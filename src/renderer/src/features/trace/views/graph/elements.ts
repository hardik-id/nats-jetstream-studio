import { MarkerType, Position, type Edge, type Node, type NodeHandle } from '@xyflow/react'
import type { ConsumerNode, GraphEdge, SubjectNode, TraceGraph } from '../../model/graph'
import { BRANCH_INDENT, type GraphLayout } from '../../model/layout'
import { edgeGeometry, type EdgeGeometry } from './paths'
import { edgeLabel, edgeName, nodeName } from './text'

/** The graph and its layout as React Flow nodes and edges. */

export interface SubjectNodeData extends Record<string, unknown> {
  node: SubjectNode
  /** The selected message is at this node: its position among the node's messages. */
  current: number | null
}

export interface ConsumerNodeData extends Record<string, unknown> {
  node: ConsumerNode
  /** The consumer received the selected message. */
  current: boolean
}

export interface FlowEdgeData extends Record<string, unknown> {
  edge: GraphEdge
  label: string | null
  /** What the edge is, in words: its tooltip and accessible name. */
  name: string
  /** Where the line runs and its label goes. */
  geometry: EdgeGeometry
  /** A side branch: its line says nothing, the consumer shows its own counts. */
  branch: boolean
  /** The edge the selected message arrived by. */
  current: boolean
  /** Stroke and arrow head colour (a CSS value). */
  colour: string
  /** Drawn faintly: a back edge in a dense graph, so that the way forward stands out. */
  faint: boolean
}

export type SubjectFlowNode = Node<SubjectNodeData, 'subject'>
export type ConsumerFlowNode = Node<ConsumerNodeData, 'consumer'>
export type GraphFlowNode = SubjectFlowNode | ConsumerFlowNode
export type GraphFlowEdge = Edge<FlowEdgeData, 'flow'>

/** Where the node components put their connection points (see `SubjectNode`, `ConsumerNode`). */
function handlesOf(width: number, height: number, branches: boolean): NodeHandle[] {
  const handles: NodeHandle[] = [
    { type: 'target', position: Position.Left, x: 0, y: height / 2 },
    { type: 'source', position: Position.Right, x: width, y: height / 2 }
  ]
  if (branches)
    handles.push({
      id: 'branch',
      type: 'source',
      position: Position.Bottom,
      x: BRANCH_INDENT / 2,
      y: height
    })
  return handles
}

export function toFlowNodes(
  graph: TraceGraph,
  layout: GraphLayout,
  selected: number | null
): GraphFlowNode[] {
  const receivers = selected === null ? [] : graph.receivers[selected]
  return graph.nodes.map((node): GraphFlowNode => {
    const p = layout.nodes[node.id]
    // The size and the connection points are known from the layout. Giving them here means the
    // library never hides a node to measure it again when the nodes are rebuilt (a selection).
    const common = {
      id: node.id,
      position: { x: p.x, y: p.y },
      width: p.width,
      height: p.height,
      measured: { width: p.width, height: p.height },
      handles: handlesOf(p.width, p.height, node.kind === 'subject'),
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      ariaRole: 'img' as const
    }
    if (node.kind === 'subject') {
      const at = selected === null ? -1 : node.messages.indexOf(selected)
      return {
        ...common,
        type: 'subject',
        ariaLabel: nodeName(node) + (at >= 0 ? ', selected' : ''),
        domAttributes: at >= 0 ? { 'aria-current': true } : undefined,
        data: { node, current: at >= 0 ? at : null }
      }
    }
    const current = receivers.includes(node.id)
    return {
      ...common,
      type: 'consumer',
      ariaLabel: nodeName(node) + (current ? ', received the selected message' : ''),
      data: { node, current }
    }
  })
}

export function toFlowEdges(
  graph: TraceGraph,
  layout: GraphLayout,
  selected: number | null,
  /** Labels on every edge; without, only the selected and the slowest one keep theirs. */
  labels = true
): GraphFlowEdge[] {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]))
  const arrived = selected === null ? null : graph.arrivedBy[selected]
  return graph.edges.map((edge): GraphFlowEdge => {
    const current = edge.id === arrived
    const name = edgeName(edge, nodes) + (current ? ', the selected message arrived by it' : '')
    const colour = current
      ? 'var(--accent)'
      : edge.slowest
        ? 'var(--warn)'
        : edge.kind === 'hop'
          ? 'var(--graph-hop)'
          : 'var(--graph-known)'
    return {
      id: edge.id,
      type: 'flow',
      source: edge.source,
      target: edge.target,
      sourceHandle: layout.routes[edge.id]?.kind === 'branch' ? 'branch' : undefined,
      ariaLabel: name,
      // Above the other edges, so that its colour is not hidden where edges cross.
      zIndex: current ? 1 : edge.slowest ? 0.5 : 0,
      interactionWidth: 18,
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: colour,
        width: 18,
        height: 18,
        markerUnits: 'userSpaceOnUse'
      },
      data: {
        edge,
        label: labels || current || edge.slowest ? edgeLabel(edge) : null,
        name,
        geometry: edgeGeometry(edge, layout),
        branch: layout.routes[edge.id]?.kind === 'branch',
        current,
        colour,
        faint: !labels && edge.back && !current && !edge.slowest
      }
    }
  })
}
