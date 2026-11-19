import type { GraphEdge, GraphNode, TraceGraph } from './graph'

/**
 * Positions for the Graph view (PBI-138 phase 3): a layered left-to-right layout, own code, no
 * layout library. Pure and deterministic: the same graph and area always give the same picture.
 *
 * - Rank: the longest path from the first node over forward edges. Nodes are numbered by first
 *   appearance in time, so forward edges (to a later node) never form a cycle, and an edge back
 *   to an earlier node (a retry, a revisit) is left out of the ranking.
 * - Side branches: a consumer that leads nowhere hangs below the subject it received from, like
 *   a branch of a tree, instead of taking a column of its own.
 * - Bands: ranks run left to right in columns. When the whole row would have to be shown too
 *   small, the ranks wrap into bands read like lines of text, on one grid of columns. The number
 *   of columns per band is the one that shows the graph largest in the given area.
 * - Rows: a node sits level with the nodes of its band it came from; nodes that would collide
 *   are pushed down.
 * - Detours: an edge that cannot be a curve between neighbouring columns of one band (a back
 *   edge, an edge to another band, an edge over a column with a node in the way) runs out to the
 *   right, through the gap between columns to a lane above the target's band, across, and in from
 *   the left. Gaps between columns and lanes between bands never hold a node, so a detour never
 *   crosses one. Lanes are stacked so that detours do not overlap.
 */

export const SUBJECT_HEIGHT = 58
export const CONSUMER_HEIGHT = 66
export const COLUMN_GAP = 112
export const ROW_GAP = 30
/** Space between a subject and its side branches, and between branches. */
export const BRANCH_GAP = 16
/** How far side branches are indented from their subject; their line runs in that space. */
export const BRANCH_INDENT = 40
/** Least space between two bands. */
export const BAND_GAP = 64
/** Distance from the top of a band to its first lane. */
export const LANE_OFFSET = 30
/** Distance between lanes: room for a label, or less when labels are left off. */
export const LANE_SPACING = 24
export const COMPACT_LANE_SPACING = 9
/** How far a detour runs out of a column before it turns; higher lanes turn further out. */
export const DETOUR_STUB = 18
export const DETOUR_STUB_PER_LEVEL = 6
/** Width of a monospace character of the node titles, in pixels. */
const CHAR_WIDTH = 7.3

export interface Size {
  width: number
  height: number
}

/** The size a node is drawn at. Long titles are cut with an ellipsis at the maximum width. */
export function nodeSize(node: GraphNode): Size {
  const clamp = (w: number, min: number, max: number): number =>
    Math.round(Math.min(max, Math.max(min, w)))
  // A subject with several messages also shows a count badge.
  if (node.kind === 'subject')
    return {
      width: clamp(node.key.length * CHAR_WIDTH + (node.messages.length > 1 ? 86 : 52), 150, 290),
      height: SUBJECT_HEIGHT
    }
  return { width: clamp(node.name.length * CHAR_WIDTH + 76, 170, 250), height: CONSUMER_HEIGHT }
}

export interface PlacedNode extends Size {
  id: string
  rank: number
  band: number
  /** The column in the grid shared by all bands. */
  column: number
  /** Top left corner. */
  x: number
  y: number
}

/**
 * How an edge is drawn when it is not a plain curve between neighbouring columns. `branch`: down
 * from its subject and into a side branch. `detour`: out at `outX`, along the lane at `y`, in at
 * `inX`.
 */
export type Route =
  { kind: 'branch' } | { kind: 'detour'; y: number; level: number; outX: number; inX: number }

export interface GraphLayout {
  nodes: Record<string, PlacedNode>
  routes: Record<string, Route>
  /** Everything that is drawn, detour lanes included. */
  bounds: { x: number; y: number; width: number; height: number }
  ranks: number
  /** Columns per band. */
  columns: number
  bands: number
}

export interface LayoutOptions {
  /**
   * The area the graph is shown in, without padding. Without it the ranks never wrap; with it,
   * the columns per band are chosen to show the graph as large as possible (up to full size).
   */
  area?: Size
  /** Lanes close together, for a dense graph whose detours carry no labels. */
  compactLanes?: boolean
}

/** What does not depend on the number of columns. */
interface Prepared {
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** Nodes that take a column (not side branches), in order of first appearance. */
  ranked: GraphNode[]
  forward: GraphEdge[]
  rank: Map<string, number>
  ranks: number
  sizes: Map<string, Size>
  /** Side branches by the subject they hang below, in order. */
  branches: Map<string, GraphNode[]>
  parentOf: Map<string, string>
}

function prepare(graph: Pick<TraceGraph, 'nodes' | 'edges'>): Prepared {
  const nodes = [...graph.nodes].sort((a, b) => a.order - b.order)
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const edges = graph.edges.filter((e) => byId.has(e.source) && byId.has(e.target))

  // Side branches: consumers that lead nowhere, below the first subject that delivered to them.
  const parentOf = new Map<string, string>()
  const branches = new Map<string, GraphNode[]>()
  for (const n of nodes) {
    if (n.kind !== 'consumer' || edges.some((e) => e.source === n.id)) continue
    const from = edges
      .filter((e) => e.target === n.id && byId.get(e.source)!.kind === 'subject')
      .map((e) => byId.get(e.source)!)
      .sort((a, b) => a.order - b.order)[0]
    if (!from) continue
    parentOf.set(n.id, from.id)
    branches.set(from.id, [...(branches.get(from.id) ?? []), n])
  }

  const ranked = nodes.filter((n) => !parentOf.has(n.id))
  const forward = edges.filter(
    (e) => !e.back && e.source !== e.target && !parentOf.has(e.target) && !parentOf.has(e.source)
  )
  // In order of first appearance every forward edge points to a later node, so one pass in that
  // order is a longest-path layering.
  const rank = new Map<string, number>(ranked.map((n) => [n.id, 0]))
  for (const n of ranked)
    for (const e of forward)
      if (e.source === n.id) rank.set(e.target, Math.max(rank.get(e.target)!, rank.get(n.id)! + 1))
  for (const [side, parent] of parentOf) rank.set(side, rank.get(parent)!)
  const ranks = ranked.length ? Math.max(...ranked.map((n) => rank.get(n.id)!)) + 1 : 0
  const sizes = new Map(nodes.map((n) => [n.id, nodeSize(n)]))
  return { nodes, edges, ranked, forward, rank, ranks, sizes, branches, parentOf }
}

/** The size of a node with its side branches below it. */
function blockSize(p: Prepared, id: string): Size {
  const own = p.sizes.get(id)!
  const sides = (p.branches.get(id) ?? []).map((n) => p.sizes.get(n.id)!)
  return {
    width: Math.max(own.width, ...sides.map((s) => BRANCH_INDENT + s.width)),
    height: own.height + sides.reduce((h, s) => h + BRANCH_GAP + s.height, 0)
  }
}

/** Lays the graph out with a given number of columns per band. */
function place(p: Prepared, perBand: number, options: LayoutOptions): GraphLayout {
  const { nodes, ranked, forward, rank, ranks, sizes } = p
  const bands = ranks ? Math.ceil(ranks / perBand) : 0
  const bandOf = (id: string): number => Math.floor(rank.get(id)! / perBand)
  const columnOf = (id: string): number => rank.get(id)! % perBand
  const blocks = new Map(ranked.map((n) => [n.id, blockSize(p, n.id)]))
  const widths = Array.from({ length: perBand }, () => 0)
  for (const n of ranked)
    widths[columnOf(n.id)] = Math.max(widths[columnOf(n.id)], blocks.get(n.id)!.width)
  const lefts: number[] = []
  for (let j = 0; j < perBand; j++)
    lefts.push(j === 0 ? 0 : lefts[j - 1] + widths[j - 1] + COLUMN_GAP)

  // Rows within each band (y relative to the band), rank by rank: level with the mean centre of
  // the nodes of the same band a node came from.
  const local = new Map<string, number>()
  const centre = (id: string): number => local.get(id)! + sizes.get(id)!.height / 2
  for (let r = 0; r < ranks; r++) {
    const column = ranked.filter((n) => rank.get(n.id) === r)
    const wanted = new Map<string, number>()
    for (const n of column) {
      const from = forward.filter(
        (e) => e.target === n.id && local.has(e.source) && bandOf(e.source) === bandOf(n.id)
      )
      wanted.set(
        n.id,
        from.length ? from.reduce((s, e) => s + centre(e.source), 0) / from.length : 0
      )
    }
    const sorted = [...column].sort(
      (a, b) => wanted.get(a.id)! - wanted.get(b.id)! || a.order - b.order
    )
    let bottom = -Infinity
    for (const n of sorted) {
      const y = Math.round(
        Math.max(wanted.get(n.id)! - sizes.get(n.id)!.height / 2, bottom + ROW_GAP)
      )
      local.set(n.id, y)
      let below = y + sizes.get(n.id)!.height
      for (const side of p.branches.get(n.id) ?? []) {
        local.set(side.id, below + BRANCH_GAP)
        below += BRANCH_GAP + sizes.get(side.id)!.height
      }
      bottom = below
    }
  }

  // Which edges need a detour, and their lanes: above the target's band, stacked by overlap.
  const routes: Record<string, Route> = {}
  const blocked = (e: GraphEdge): boolean => {
    if (bandOf(e.source) !== bandOf(e.target)) return true
    const a = rank.get(e.source)!
    const b = rank.get(e.target)!
    if (b - a < 2) return b <= a
    const lo = Math.min(centre(e.source), centre(e.target)) - 12
    const hi = Math.max(centre(e.source), centre(e.target)) + 12
    return nodes.some((n) => {
      const r = rank.get(n.id)!
      const y = local.get(n.id)!
      return r > a && r < b && y < hi && y + sizes.get(n.id)!.height > lo
    })
  }
  const routed: { id: string; band: number; source: string; target: string }[] = []
  for (const e of p.edges) {
    if (p.parentOf.get(e.target) === e.source) routes[e.id] = { kind: 'branch' }
    else if (e.back || e.source === e.target || blocked(e))
      routed.push({ id: e.id, band: bandOf(e.target), source: e.source, target: e.target })
  }
  const span = (d: (typeof routed)[number]): [number, number] => {
    const a = columnOf(d.source)
    const b = columnOf(d.target)
    return [Math.min(a, b), Math.max(a, b)]
  }
  // Short detours nearest the band, so that long ones go around them.
  routed.sort((p, q) => {
    const [pl, ph] = span(p)
    const [ql, qh] = span(q)
    return ph - pl - (qh - ql) || pl - ql || (p.id < q.id ? -1 : 1)
  })
  const lanes: [number, number][][][] = Array.from({ length: bands }, () => [])
  const levels = new Map<string, number>()
  for (const d of routed) {
    const [lo, hi] = span(d)
    const taken = lanes[d.band]
    let level = 0
    while (taken[level]?.some(([l, h]) => l <= hi && lo <= h)) level++
    ;(taken[level] ??= []).push([lo, hi])
    levels.set(d.id, level)
  }

  // Bands one below the other, with room for the lanes above each.
  const spacing = options.compactLanes ? COMPACT_LANE_SPACING : LANE_SPACING
  const offsets: number[] = []
  const tops: number[] = []
  let previousBottom = 0
  for (let b = 0; b < bands; b++) {
    const members = nodes.filter((n) => bandOf(n.id) === b)
    const minTop = Math.min(...members.map((n) => local.get(n.id)!))
    const maxBottom = Math.max(...members.map((n) => local.get(n.id)! + sizes.get(n.id)!.height))
    const lanesHeight = lanes[b].length ? 2 * LANE_OFFSET + (lanes[b].length - 1) * spacing : 0
    const offset = b === 0 ? -minTop : previousBottom + Math.max(BAND_GAP, lanesHeight) - minTop
    offsets.push(offset)
    tops.push(offset + minTop)
    previousBottom = offset + maxBottom
  }

  const placed: Record<string, PlacedNode> = {}
  for (const n of nodes) {
    const parent = p.parentOf.get(n.id)
    const anchor = parent ?? n.id
    const j = columnOf(anchor)
    const block = blocks.get(anchor)!
    const left = Math.round(lefts[j] + (widths[j] - block.width) / 2)
    const size = sizes.get(n.id)!
    // A node with branches lines up with its block's left edge; branches are indented.
    const x = parent
      ? left + BRANCH_INDENT
      : p.branches.has(n.id)
        ? left
        : Math.round(lefts[j] + (widths[j] - size.width) / 2)
    placed[n.id] = {
      id: n.id,
      rank: rank.get(n.id)!,
      band: bandOf(n.id),
      column: j,
      x,
      y: offsets[bandOf(n.id)] + local.get(n.id)!,
      ...size
    }
  }
  for (const d of routed) {
    const level = levels.get(d.id)!
    const stub = DETOUR_STUB + level * DETOUR_STUB_PER_LEVEL
    const out = columnOf(d.source)
    const into = columnOf(d.target)
    routes[d.id] = {
      kind: 'detour',
      level,
      y: tops[d.band] - LANE_OFFSET - level * spacing,
      outX: lefts[out] + widths[out] + stub,
      inX: lefts[into] - stub
    }
  }

  const all = Object.values(placed)
  const laneYs = Object.values(routes).flatMap((r) => (r.kind === 'detour' ? [r.y] : []))
  const minY = Math.min(0, ...laneYs.map((y) => y - 24))
  const maxX = all.length ? Math.max(...all.map((n) => n.x + n.width)) : 0
  const maxY = all.length ? Math.max(...all.map((n) => n.y + n.height)) : 0
  // Detours turn up to the stub of their level outside the outer columns.
  const margin = laneYs.length ? DETOUR_STUB + 4 * DETOUR_STUB_PER_LEVEL + 8 : 8
  return {
    nodes: placed,
    routes,
    bounds: { x: -margin, y: minY, width: maxX + 2 * margin, height: maxY - minY },
    ranks,
    columns: perBand,
    bands
  }
}

/** The zoom at which a drawing of this size fits the area (never above full size). */
export function fitZoom(bounds: Size, area: Size): number {
  return Math.min(1, area.width / bounds.width, area.height / bounds.height)
}

export function layoutGraph(
  graph: Pick<TraceGraph, 'nodes' | 'edges'>,
  options: LayoutOptions = {}
): GraphLayout {
  const p = prepare(graph)
  const { area } = options
  if (!area || p.ranks <= 2) return place(p, Math.max(1, p.ranks), options)
  // Every distinct band count, from one band (no wrap) down; ranks are spread evenly over bands.
  let best: { layout: GraphLayout; zoom: number } | null = null
  let bands = 0
  for (let k = p.ranks; k >= 1; k--) {
    if (Math.ceil(p.ranks / k) === bands) continue
    bands = Math.ceil(p.ranks / k)
    const layout = place(p, Math.ceil(p.ranks / bands), options)
    const zoom = fitZoom(layout.bounds, area)
    // Fewer bands win a tie, so a graph that fits is never wrapped.
    if (!best || zoom > best.zoom + 0.01) best = { layout, zoom }
  }
  return best!.layout
}
