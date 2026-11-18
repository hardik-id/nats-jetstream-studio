import type { Trace, TraceHop } from './trace'
import { groupSubject } from './subjectGroup'

/** What a lane is: one per subject, or one per stream. */
export type LaneBy = 'subject' | 'stream'
/**
 * The horizontal scale. `steps`: one column per message in time order (close and far apart
 * messages are equally readable). `time`: the distance follows the time between messages, within
 * a minimum and a maximum spacing.
 */
export type LaneScale = 'steps' | 'time'

export interface LaneOptions {
  by: LaneBy
  scale: LaneScale
  /** Collapse id-like subject tokens to `*` in lane keys (only with `by: 'subject'`). */
  group: boolean
}

export const DEFAULT_LANE_OPTIONS: LaneOptions = { by: 'subject', scale: 'steps', group: true }

/** Layout constants, in pixels. */
export const LANE_HEIGHT = 44
export const DOT_RADIUS = 6
export const STEP_WIDTH = 92
export const MIN_GAP_PX = 32
export const MAX_GAP_PX = 320
export const TIME_WIDTH = 960
export const PAD_LEFT = 36
export const PAD_RIGHT = 56
/** Labels on the axis are at least this far apart. */
export const AXIS_SPACING = 92

export interface Lane {
  /** What messages are grouped by: a subject (maybe with `*`) or a stream name. */
  key: string
  /** Messages in the lane. */
  count: number
}

export interface LaneDot {
  /** The message id, see `messageId`. */
  id: string
  /** The index of the message in the trace (time order). */
  index: number
  lane: number
  x: number
}

export interface LaneLink {
  /** Indexes of the two messages. */
  from: number
  to: number
  fromLane: number
  toLane: number
  x1: number
  x2: number
  gapMs: number
  slowest: boolean
  /** The gap is drawn shorter than its time says (real-time scale only). */
  shortened: boolean
}

export interface LanesLayout {
  options: LaneOptions
  lanes: Lane[]
  dots: LaneDot[]
  links: LaneLink[]
  /** Width of the drawing, without the lane labels. */
  width: number
  /** The index of the message after the slowest hop, or null when no hop is slower than another. */
  slowest: number | null
  /** Indexes of the messages that carry a label on the axis. */
  axis: number[]
  /** Gaps drawn shorter than their time (real-time scale). */
  shortened: number
}

/** The lane key of a message. */
export function laneKey(hop: TraceHop, options: LaneOptions): string {
  if (options.by === 'stream') return hop.message.stream
  return options.group ? groupSubject(hop.message.subject) : hop.message.subject
}

/** The x position of each message for a scale: strictly increasing, at least a spacing apart. */
function positions(
  hops: readonly TraceHop[],
  scale: LaneScale
): { xs: number[]; shortened: boolean[] } {
  const xs = [PAD_LEFT]
  const shortened = [false]
  if (scale === 'steps') {
    for (let i = 1; i < hops.length; i++) {
      xs.push(PAD_LEFT + i * STEP_WIDTH)
      shortened.push(false)
    }
    return { xs, shortened }
  }
  const gaps = hops.slice(1).map((h) => h.gapMs ?? 0)
  // One huge gap must not flatten the rest: gaps far above the typical one are counted as a
  // multiple of it, and the scale is made from those.
  const sorted = gaps.filter((g) => g > 0).sort((a, b) => a - b)
  const typical = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0
  const cap = typical > 0 ? typical * 10 : Infinity
  const effective = gaps.map((g) => Math.min(g, cap))
  const total = effective.reduce((s, g) => s + g, 0)
  const pxPerMs = total > 0 ? TIME_WIDTH / total : 0
  gaps.forEach((g, i) => {
    const px = Math.min(MAX_GAP_PX, Math.max(MIN_GAP_PX, effective[i] * pxPerMs))
    xs.push(xs[i] + px)
    shortened.push(g > cap || (g * pxPerMs > MAX_GAP_PX && pxPerMs > 0))
  })
  return { xs, shortened }
}

/** The indexes whose labels fit on the axis: the first, then each one far enough from the last. */
function axisMarks(xs: readonly number[]): number[] {
  const marks: number[] = []
  let last = -Infinity
  xs.forEach((x, i) => {
    if (x - last >= AXIS_SPACING) {
      marks.push(i)
      last = x
    }
  })
  return marks
}

/**
 * Lays a trace out as lanes (PBI-138 phase 2): the lanes in order of first appearance, each
 * message's lane and x position, the links between consecutive messages with their gaps, and the
 * slowest hop. Pure: no sizes of the screen are involved, only the constants above.
 */
export function layoutLanes(
  trace: Pick<Trace, 'hops'>,
  options: LaneOptions = DEFAULT_LANE_OPTIONS
): LanesLayout {
  const { hops } = trace
  const lanes: Lane[] = []
  const laneOf = new Map<string, number>()
  const laneIndex = hops.map((hop) => {
    const key = laneKey(hop, options)
    let i = laneOf.get(key)
    if (i === undefined) {
      i = lanes.length
      laneOf.set(key, i)
      lanes.push({ key, count: 0 })
    }
    lanes[i].count++
    return i
  })
  const { xs, shortened } = positions(hops, options.scale)
  const dots = hops.map((hop, index): LaneDot => ({
    id: hop.id,
    index,
    lane: laneIndex[index],
    x: xs[index]
  }))

  // The slowest hop: the largest gap (the first one on a tie), if there is a gap at all.
  let slowest: number | null = null
  let most = 0
  hops.forEach((h, i) => {
    if (h.gapMs !== null && h.gapMs > most) {
      most = h.gapMs
      slowest = i
    }
  })
  const links = hops.slice(1).map((hop, k): LaneLink => {
    const i = k + 1
    return {
      from: i - 1,
      to: i,
      fromLane: laneIndex[i - 1],
      toLane: laneIndex[i],
      x1: xs[i - 1],
      x2: xs[i],
      gapMs: hop.gapMs ?? 0,
      slowest: slowest === i,
      shortened: shortened[i]
    }
  })
  return {
    options,
    lanes,
    dots,
    links,
    width: xs[xs.length - 1] + PAD_RIGHT,
    slowest,
    axis: axisMarks(xs),
    shortened: shortened.filter(Boolean).length
  }
}

/**
 * The message to select when moving up (`-1`) or down (`+1`) a lane: in the neighbouring lane,
 * the one nearest in x (the earlier one on a tie). Null at the first or last lane.
 */
export function neighbourInLane(layout: LanesLayout, index: number, delta: -1 | 1): number | null {
  const from = layout.dots[index]
  if (!from) return null
  const lane = from.lane + delta
  if (lane < 0 || lane >= layout.lanes.length) return null
  let best: LaneDot | null = null
  for (const dot of layout.dots) {
    if (dot.lane !== lane) continue
    if (!best || Math.abs(dot.x - from.x) < Math.abs(best.x - from.x)) best = dot
  }
  return best ? best.index : null
}

export interface LinkShape {
  /** The SVG path of the arrow, from the edge of one dot to the edge of the next. */
  d: string
  /** Where the gap label goes. */
  mid: { x: number; y: number }
  curved: boolean
}

/** The y of the centre of a lane. */
export const laneY = (lane: number): number => (lane + 0.5) * LANE_HEIGHT

/**
 * The arrow of a link: straight within a lane, an S curve between lanes. It leaves one dot and
 * ends at the next, a little short of it so that the arrow head is not under the dot. Messages
 * are in time order and links join consecutive ones, so no other dot is ever in between.
 */
export function linkShape(link: LaneLink): LinkShape {
  const y1 = laneY(link.fromLane)
  const y2 = laneY(link.toLane)
  const xa = link.x1 + DOT_RADIUS + 1
  const xb = link.x2 - DOT_RADIUS - 2
  if (link.fromLane === link.toLane)
    return { d: `M${xa} ${y1}H${xb}`, mid: { x: (xa + xb) / 2, y: y1 }, curved: false }
  const dx = (xb - xa) / 2
  return {
    d: `M${xa} ${y1}C${xa + dx} ${y1} ${xb - dx} ${y2} ${xb} ${y2}`,
    mid: { x: (xa + xb) / 2, y: (y1 + y2) / 2 },
    curved: true
  }
}
