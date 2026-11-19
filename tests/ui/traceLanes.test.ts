import { describe, expect, it } from 'vitest'
import type { TraceMessage } from '@shared/trace'
import {
  AXIS_SPACING,
  DEFAULT_LANE_OPTIONS,
  DOT_RADIUS,
  laneY,
  layoutLanes,
  linkShape,
  MAX_GAP_PX,
  MIN_GAP_PX,
  neighbourInLane,
  PAD_LEFT,
  STEP_WIDTH,
  type LaneOptions
} from '@renderer/features/trace/model/lanes'
import { buildTrace } from '@renderer/features/trace/model/trace'
import { laneOptions } from '@renderer/features/trace/views/lanesSettings'
import { resolveSettings } from '@renderer/features/trace/views/controls'
import { TRACE_VIEWS } from '@renderer/features/trace/views/registry'

const T0 = Date.parse('2026-03-01T10:00:00.000Z')

function msg(stream: string, seq: number, subject: string, ms: number): TraceMessage {
  return {
    seq,
    subject,
    time: new Date(T0 + ms).toISOString(),
    size: 0,
    headers: [],
    payload: '',
    truncated: false,
    stream,
    ms: T0 + ms
  }
}
const trace = (...m: [string, string, number][]) =>
  buildTrace(m.map(([stream, subject, ms], i) => msg(stream, i + 1, subject, ms)))
const opts = (o: Partial<LaneOptions> = {}): LaneOptions => ({ ...DEFAULT_LANE_OPTIONS, ...o })

describe('PBI-138 lanes layout', () => {
  const t = trace(
    ['ORDERS', 'orders.new', 0],
    ['PAY', 'pay.charge', 200],
    ['ORDERS', 'orders.new', 2600],
    ['SHIP', 'ship.pack', 2700]
  )

  it('orders lanes by first appearance and puts each message in its lane', () => {
    const l = layoutLanes(t, opts({ group: false }))
    expect(l.lanes).toEqual([
      { key: 'orders.new', count: 2 },
      { key: 'pay.charge', count: 1 },
      { key: 'ship.pack', count: 1 }
    ])
    expect(l.dots.map((d) => d.lane)).toEqual([0, 1, 0, 2])
    expect(l.dots.map((d) => d.index)).toEqual([0, 1, 2, 3])
  })

  it('lanes by stream', () => {
    const l = layoutLanes(t, opts({ by: 'stream' }))
    expect(l.lanes.map((x) => x.key)).toEqual(['ORDERS', 'PAY', 'SHIP'])
    expect(l.dots.map((d) => d.lane)).toEqual([0, 1, 0, 2])
  })

  it('groups similar subjects only for subject lanes and only when asked', () => {
    const g = trace(
      ['O', 'orders.1.paid', 0],
      ['O', 'orders.2.paid', 10],
      ['O', 'orders.3.shipped', 20]
    )
    expect(layoutLanes(g, opts()).lanes).toEqual([
      { key: 'orders.*.paid', count: 2 },
      { key: 'orders.*.shipped', count: 1 }
    ])
    expect(layoutLanes(g, opts({ group: false })).lanes).toHaveLength(3)
    expect(layoutLanes(g, opts({ by: 'stream' })).lanes).toEqual([{ key: 'O', count: 3 }])
  })

  it('even steps: one column per message, whatever the times', () => {
    const l = layoutLanes(t, opts({ scale: 'steps' }))
    expect(l.dots.map((d) => d.x)).toEqual([0, 1, 2, 3].map((i) => PAD_LEFT + i * STEP_WIDTH))
    expect(l.links.map((k) => [k.x1, k.x2])).toEqual([
      [PAD_LEFT, PAD_LEFT + STEP_WIDTH],
      [PAD_LEFT + STEP_WIDTH, PAD_LEFT + 2 * STEP_WIDTH],
      [PAD_LEFT + 2 * STEP_WIDTH, PAD_LEFT + 3 * STEP_WIDTH]
    ])
    expect(l.width).toBeGreaterThan(l.dots[3].x)
  })

  it('links consecutive messages with their gap, and marks the slowest hop', () => {
    const l = layoutLanes(t)
    expect(l.links.map((k) => [k.from, k.to, k.gapMs])).toEqual([
      [0, 1, 200],
      [1, 2, 2400],
      [2, 3, 100]
    ])
    expect(l.links.map((k) => [k.fromLane, k.toLane])).toEqual([
      [0, 1],
      [1, 0],
      [0, 2]
    ])
    expect(l.slowest).toBe(2)
    expect(l.links.map((k) => k.slowest)).toEqual([false, true, false])
  })

  it('has no slowest hop for one hop, or when the gaps are equal; a tie among different gaps takes the first', () => {
    expect(layoutLanes(trace(['A', 'a', 0])).slowest).toBeNull()
    // One hop alone is not "slowest".
    const one = layoutLanes(trace(['A', 'a', 0], ['A', 'b', 900]))
    expect(one.slowest).toBeNull()
    expect(one.links.map((k) => k.slowest)).toEqual([false])
    expect(layoutLanes(trace(['A', 'a', 5], ['A', 'b', 5])).slowest).toBeNull()
    // Equal gaps: none is slower.
    expect(layoutLanes(trace(['A', 'a', 0], ['A', 'b', 100], ['A', 'c', 200])).slowest).toBeNull()
    expect(layoutLanes(trace(['A', 'a', 0], ['A', 'b', 0], ['A', 'c', 0])).slowest).toBeNull()
    // Different gaps, the largest twice: the first.
    expect(
      layoutLanes(trace(['A', 'a', 0], ['A', 'b', 10], ['A', 'c', 110], ['A', 'd', 210])).slowest
    ).toBe(2)
    const one0 = layoutLanes(trace(['A', 'a', 0]))
    expect(one0.links).toEqual([])
    expect(one0.dots).toHaveLength(1)
    expect(one0.lanes).toHaveLength(1)
  })

  it('real time: lone or equal gaps are not "shortened"', () => {
    for (const times of [
      [0, 5],
      [0, 5, 10],
      [0, 1000, 2000, 3000],
      [0, 0, 0]
    ]) {
      const l = layoutLanes(
        trace(...times.map((ms): [string, string, number] => ['A', 'a', ms])),
        opts({ scale: 'time' })
      )
      expect(l.shortened, times.join()).toBe(0)
      expect(l.links.every((k) => !k.shortened)).toBe(true)
    }
    // A gap of 5 s among 1 s gaps is not an outlier either (under ten times the typical one).
    const l = layoutLanes(
      trace(['A', 'a', 0], ['A', 'b', 1000], ['A', 'c', 2000], ['A', 'd', 7000]),
      opts({ scale: 'time' })
    )
    expect(l.shortened).toBe(0)
  })

  it('real time: x grows with time, with a minimum spacing so dots never overlap', () => {
    // Fifty messages in the same millisecond, then one 2 s later.
    const burst = trace(
      ...Array.from({ length: 50 }, (_, i): [string, string, number] => ['A', `s.${i}`, 0]),
      ['A', 'end', 2000]
    )
    const l = layoutLanes(burst, opts({ scale: 'time' }))
    for (let i = 1; i < l.dots.length; i++)
      expect(l.dots[i].x - l.dots[i - 1].x).toBeGreaterThanOrEqual(MIN_GAP_PX)
    // The same instant for all: still spaced.
    const same = layoutLanes(
      trace(['A', 'a', 0], ['A', 'b', 0], ['A', 'c', 0]),
      opts({ scale: 'time' })
    )
    expect(same.dots.map((d) => d.x)).toEqual([
      PAD_LEFT,
      PAD_LEFT + MIN_GAP_PX,
      PAD_LEFT + 2 * MIN_GAP_PX
    ])
  })

  it('real time: distances are proportional where nothing is clamped', () => {
    const l = layoutLanes(
      trace(
        ['A', 'a', 0],
        ['A', 'b', 1000],
        ['A', 'c', 3000],
        ['A', 'd', 4000],
        ['A', 'e', 5000],
        ['A', 'f', 6000],
        ['A', 'g', 7000],
        ['A', 'h', 8000]
      ),
      opts({ scale: 'time' })
    )
    const [d1, d2] = [l.dots[1].x - l.dots[0].x, l.dots[2].x - l.dots[1].x]
    expect(d2 / d1).toBeCloseTo(2, 5)
    expect(l.shortened).toBe(0)
  })

  it('real time: one huge gap does not flatten the others, and is marked as shortened', () => {
    const l = layoutLanes(
      trace(
        ['A', 'a', 0],
        ['A', 'b', 1000],
        ['A', 'c', 2000],
        ['A', 'd', 3000],
        ['A', 'e', 3_600_000]
      ),
      opts({ scale: 'time' })
    )
    const gaps = l.dots.slice(1).map((d, i) => d.x - l.dots[i].x)
    expect(gaps[0]).toBeGreaterThan(60)
    expect(gaps[3]).toBeLessThanOrEqual(MAX_GAP_PX)
    expect(gaps[3]).toBeGreaterThan(gaps[0])
    expect(l.links.map((k) => k.shortened)).toEqual([false, false, false, true])
    expect(l.shortened).toBe(1)
    expect(l.slowest).toBe(4)
  })

  it('axis labels are spaced apart and start at the first message', () => {
    const many = trace(
      ...Array.from({ length: 40 }, (_, i): [string, string, number] => ['A', 'a', i * 5])
    )
    const l = layoutLanes(many, opts({ scale: 'time' }))
    expect(l.axis[0]).toBe(0)
    for (let i = 1; i < l.axis.length; i++)
      expect(l.dots[l.axis[i]].x - l.dots[l.axis[i - 1]].x).toBeGreaterThanOrEqual(AXIS_SPACING)
    const steps = layoutLanes(many, opts({ scale: 'steps' }))
    expect(steps.axis.length).toBe(40) // every column has room for a label
  })

  it('handles 500 messages over 40 lanes', () => {
    const big = trace(
      ...Array.from({ length: 500 }, (_, i): [string, string, number] => [
        `S${i % 5}`,
        `svc${i % 40}.event`,
        i * 3 + (i % 7)
      ])
    )
    for (const scale of ['steps', 'time'] as const) {
      const l = layoutLanes(big, opts({ scale, group: false }))
      expect(l.lanes).toHaveLength(40)
      expect(l.dots).toHaveLength(500)
      expect(l.links).toHaveLength(499)
      for (let i = 1; i < 500; i++) expect(l.dots[i].x).toBeGreaterThan(l.dots[i - 1].x)
    }
  })

  it('an empty trace has an empty layout', () => {
    const l = layoutLanes(trace())
    expect(l.lanes).toEqual([])
    expect(l.dots).toEqual([])
    expect(l.axis).toEqual([])
    expect(l.links).toEqual([])
  })
})

describe('PBI-138 lanes navigation and arrows', () => {
  const t = trace(['A', 'a', 0], ['A', 'b', 10], ['A', 'c', 20], ['A', 'a', 30], ['A', 'b', 40])
  const l = layoutLanes(t, opts({ group: false }))

  it('Up and Down pick the nearest message of the neighbouring lane', () => {
    // Lanes: a (0, 3), b (1, 4), c (2). From message 2 (lane c, x=2): up -> lane b, nearest is 1 (x=1) or 4 (x=4): 1 is closer
    expect(neighbourInLane(l, 2, -1)).toBe(1)
    expect(neighbourInLane(l, 2, 1)).toBeNull()
    // From message 3 (lane a): down -> lane b: message 4 is one column away, 1 is two
    expect(neighbourInLane(l, 3, 1)).toBe(4)
    expect(neighbourInLane(l, 0, -1)).toBeNull()
    expect(neighbourInLane(l, 99, 1)).toBeNull()
  })

  it('draws a straight arrow within a lane and a curve between lanes, between the dots', () => {
    const same = linkShape({ ...l.links[0], fromLane: 0, toLane: 0 })
    expect(same.curved).toBe(false)
    expect(same.d).toMatch(/^M[\d.]+ [\d.]+H[\d.]+$/)
    expect(same.mid.y).toBe(laneY(0))
    const cross = linkShape(l.links[0])
    expect(cross.curved).toBe(true)
    expect(cross.d).toContain('C')
    // The // mark of a shortened gap sits on the arrow, between the lanes' heights.
    expect(cross.breakAt.x).toBeGreaterThan(l.links[0].x1)
    expect(cross.breakAt.x).toBeLessThan(l.links[0].x2)
    expect(cross.breakAt.y).toBeGreaterThanOrEqual(laneY(0))
    expect(cross.breakAt.y).toBeLessThanOrEqual(laneY(1))
    expect(same.breakAt.y).toBe(laneY(0))
    expect(cross.mid.y).toBe((laneY(0) + laneY(1)) / 2)
    // It starts after the first dot and ends before the second.
    const [xa] = cross.d.slice(1).split(' ').map(Number)
    expect(xa).toBeGreaterThanOrEqual(l.links[0].x1 + DOT_RADIUS)
    expect(Number(cross.d.split(' ').at(-2)?.replace(/^.*\s/, ''))).toBeLessThan(l.links[0].x2)
  })
})

describe('PBI-138 view settings', () => {
  const lanes = TRACE_VIEWS.find((v) => v.id === 'lanes')!

  it('the registry has Timeline, Lanes and Graph; Timeline declares no controls', () => {
    expect(TRACE_VIEWS.map((v) => v.id)).toEqual(['timeline', 'lanes', 'graph'])
    expect(TRACE_VIEWS[0].controls).toBeUndefined()
    expect(lanes.controls?.map((c) => [c.id, c.placement ?? 'bar'])).toEqual([
      ['laneBy', 'bar'],
      ['scale', 'bar'],
      ['groupSubjects', 'more']
    ])
  })

  it('resolves stored settings against the controls: defaults, and nothing invalid gets through', () => {
    expect(resolveSettings(lanes, undefined)).toEqual({
      laneBy: 'subject',
      scale: 'steps',
      groupSubjects: true
    })
    expect(
      resolveSettings(lanes, { laneBy: 'stream', scale: 'time', groupSubjects: false, other: 'x' })
    ).toEqual({ laneBy: 'stream', scale: 'time', groupSubjects: false })
    expect(
      resolveSettings(lanes, { laneBy: 'nope', scale: 3 as never, groupSubjects: 'yes' })
    ).toEqual({
      laneBy: 'subject',
      scale: 'steps',
      groupSubjects: true
    })
    expect(resolveSettings(TRACE_VIEWS[0], { laneBy: 'stream' })).toEqual({})
    expect(laneOptions(resolveSettings(lanes, { laneBy: 'stream', scale: 'time' }))).toEqual({
      by: 'stream',
      scale: 'time',
      group: true
    })
  })
})
