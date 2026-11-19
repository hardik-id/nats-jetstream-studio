import { getBezierPath, Position } from '@xyflow/react'
import { BRANCH_INDENT, type GraphLayout } from '../../model/layout'

/** Geometry of the Graph view's edges that the graph library does not provide. */

const CORNER = 10

/** A polyline through the points with rounded corners, as an SVG path. */
export function roundedPath(points: readonly { x: number; y: number }[], radius = CORNER): string {
  let d = `M${points[0].x} ${points[0].y}`
  for (let i = 1; i < points.length - 1; i++) {
    const [a, b, c] = [points[i - 1], points[i], points[i + 1]]
    const inLen = Math.hypot(b.x - a.x, b.y - a.y)
    const outLen = Math.hypot(c.x - b.x, c.y - b.y)
    const r = Math.min(radius, inLen / 2, outLen / 2)
    if (r <= 0) {
      d += `L${b.x} ${b.y}`
      continue
    }
    const p1 = { x: b.x + ((a.x - b.x) / inLen) * r, y: b.y + ((a.y - b.y) / inLen) * r }
    const p2 = { x: b.x + ((c.x - b.x) / outLen) * r, y: b.y + ((c.y - b.y) / outLen) * r }
    d += `L${p1.x} ${p1.y}Q${b.x} ${b.y} ${p2.x} ${p2.y}`
  }
  const last = points[points.length - 1]
  return d + `L${last.x} ${last.y}`
}

/**
 * A detour: out of the right side of the source to `outX`, up or down to its lane, across to
 * `inX`, and into the left side of the target. Works for back edges, self loops and edges to
 * another band. Returns the path and where its label goes (the middle of the lane).
 */
export function detourPath(
  source: { x: number; y: number },
  target: { x: number; y: number },
  route: { y: number; outX: number; inX: number }
): { path: string; labelX: number; labelY: number } {
  const path = roundedPath([
    source,
    { x: route.outX, y: source.y },
    { x: route.outX, y: route.y },
    { x: route.inX, y: route.y },
    { x: route.inX, y: target.y },
    target
  ])
  return { path, labelX: (route.outX + route.inX) / 2, labelY: route.y }
}

/** A side branch: straight down from below the subject, then right into the consumer. */
export function branchPath(
  source: { x: number; y: number },
  target: { x: number; y: number }
): { path: string; labelX: number; labelY: number } {
  const path = roundedPath([source, { x: source.x, y: target.y }, target])
  return { path, labelX: source.x, labelY: (source.y + target.y) / 2 }
}

export interface EdgeGeometry {
  path: string
  labelX: number
  labelY: number
}

/**
 * Where an edge runs, from the layout alone: out of the right side of its source (or from below
 * it, for a side branch) and into the left side of its target. Nodes are never dragged, so this
 * is where the library puts the connection points too; the line and its moving dots share it.
 */
export function edgeGeometry(
  edge: { id: string; source: string; target: string },
  layout: GraphLayout
): EdgeGeometry {
  const a = layout.nodes[edge.source]
  const b = layout.nodes[edge.target]
  const route = layout.routes[edge.id]
  const target = { x: b.x, y: b.y + b.height / 2 }
  if (route?.kind === 'branch')
    return branchPath({ x: a.x + BRANCH_INDENT / 2, y: a.y + a.height }, target)
  const source = { x: a.x + a.width, y: a.y + a.height / 2 }
  if (route?.kind === 'detour') return detourPath(source, target, route)
  const [path, labelX, labelY] = getBezierPath({
    sourceX: source.x,
    sourceY: source.y,
    sourcePosition: Position.Right,
    targetX: target.x,
    targetY: target.y,
    targetPosition: Position.Left
  })
  return { path, labelX, labelY }
}
