import type { TraceGraph } from './graph'

/**
 * When the moving dots of the Graph view travel (PBI-138 phase 3). Pure: seconds only, the view
 * turns them into SVG animations.
 *
 * The path is played as one request moving from left to right: each step starts when the
 * previous one arrives, side branches start together with the step after them, and a step takes
 * its real delay, kept between `MIN_TRAVEL` and `MAX_TRAVEL` so that it neither blurs nor stalls.
 * A short path then pauses and loops. A long one (more than `MAX_CYCLE` seconds) loops every
 * `MAX_CYCLE` seconds instead, so several requests are on their way at once and every edge keeps
 * moving.
 */

export const MIN_TRAVEL = 0.8
export const MAX_TRAVEL = 4
/** Travel time of a delivery to a consumer: NATS does not say when it happened. */
export const DELIVERY_TRAVEL = 0.9
/** Pause before a short path starts again. */
export const LOOP_PAUSE = 1.2
export const MAX_CYCLE = 14
/** Above this many edges nothing moves: the picture would be noise, and it costs CPU. */
export const MAX_ANIMATED_EDGES = 80
/** Dots on one edge at most; an edge that stands for more steps keeps an even spread of them. */
export const MAX_DOTS_PER_EDGE = 3

export interface Dot {
  /** Seconds into the cycle at which the dot leaves the source. */
  start: number
  /** Seconds it takes to reach the target. */
  travel: number
}

export interface Motion {
  /** Seconds after which everything repeats. */
  cycle: number
  /** The dots of each edge (by edge id), in time order. Edges without dots are left out. */
  dots: Record<string, Dot[]>
}

export const travelTime = (delayMs: number | null): number =>
  delayMs === null ? DELIVERY_TRAVEL : Math.min(MAX_TRAVEL, Math.max(MIN_TRAVEL, delayMs / 1000))

/** Picks `n` items spread evenly over a list, keeping the first. */
function spread<T>(list: readonly T[], n: number): T[] {
  if (list.length <= n) return [...list]
  return Array.from({ length: n }, (_, k) => list[Math.floor((k * list.length) / n)])
}

export function planMotion(graph: Pick<TraceGraph, 'path'>): Motion {
  const all: Record<string, Dot[]> = {}
  let t = 0
  for (const s of graph.path) {
    const travel = travelTime(s.delayMs)
    ;(all[s.edge] ??= []).push({ start: t, travel })
    if (!s.branch) t += travel
  }
  const longest = Math.max(0, ...Object.values(all).flatMap((d) => d.map((x) => x.travel)))
  // Branches that start at the very end (the last message's consumers) still have to arrive.
  const end = Math.max(t, ...Object.values(all).flatMap((d) => d.map((x) => x.start + x.travel)))
  const cycle = end + LOOP_PAUSE <= MAX_CYCLE ? end + LOOP_PAUSE : Math.max(MAX_CYCLE, longest)
  const dots: Record<string, Dot[]> = {}
  for (const [edge, list] of Object.entries(all)) {
    dots[edge] = spread(list, MAX_DOTS_PER_EDGE).map((d) => ({ ...d, start: d.start % cycle }))
  }
  return { cycle, dots }
}
