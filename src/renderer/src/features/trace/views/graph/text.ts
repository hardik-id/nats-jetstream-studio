import type { ConsumerNode, GraphEdge, GraphNode, SubjectNode } from '../../model/graph'
import { formatSpan } from '../../model/trace'

/** The words of the Graph view: what a node or an edge shows, and what it is called. */

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** The title of a node: the subject (maybe grouped) or the consumer name. */
export const nodeTitle = (node: GraphNode): string =>
  node.kind === 'subject' ? node.key : node.name

/** Where a consumer stands with the messages of the trace, in a few words. */
export function consumerSummary(node: ConsumerNode): string {
  const parts: string[] = []
  if (node.done) parts.push(`${node.done} done`)
  if (node.waiting) parts.push(`${node.waiting} awaiting ack`)
  if (node.undelivered) parts.push(`${node.undelivered} not delivered`)
  return parts.join(' · ')
}

export function nodeName(node: GraphNode): string {
  if (node.kind === 'consumer')
    return `Consumer ${node.name} on ${node.stream}: ${consumerSummary(node)}`
  return subjectName(node)
}

function subjectName(node: SubjectNode): string {
  const subjects =
    node.subjects.length > 1 ? `, ${plural(node.subjects.length, 'subject')} grouped` : ''
  return `Subject ${node.key}${subjects}, stream ${node.streams.join(', ')}, ${plural(node.messages.length, 'message')}`
}

/**
 * The delay of an edge as shown on it: `~60 ms`, the median when it stands for several hops, or
 * the longest when one of them is the slowest hop of the trace.
 */
export function delayText(edge: GraphEdge): string | null {
  if (!edge.delay) return null
  // The slowest hop is the longest of its edge: say that one, not the median.
  if (edge.slowest && edge.count > 1) return `up to ~${formatSpan(edge.delay.max)}`
  return `~${formatSpan(edge.delay.median)}`
}

/** What an edge says next to its delay: `retry ×2`, `back`, `×3`, `not delivered`. */
function countText(edge: GraphEdge): string | null {
  const times = edge.count > 1 ? ` ×${edge.count}` : ''
  if (edge.kind === 'pending') return 'not delivered'
  if (edge.back) return edge.retries === edge.count ? `retry${times}` : `back${times}`
  return edge.count > 1 ? `×${edge.count}` : null
}

/** The label on an edge, or null for a single delivery (the solid line says it all). */
export function edgeLabel(edge: GraphEdge): string | null {
  const parts = [countText(edge), delayText(edge)].filter((p): p is string => p !== null)
  return parts.length ? parts.join(' · ') : null
}

export function edgeName(edge: GraphEdge, nodes: ReadonlyMap<string, GraphNode>): string {
  const from = nodeTitle(nodes.get(edge.source)!)
  const to = nodeTitle(nodes.get(edge.target)!)
  const what =
    edge.kind === 'delivery'
      ? 'delivered (known)'
      : edge.kind === 'pending'
        ? 'not delivered yet (known)'
        : 'next message (inferred from time)'
  const parts = [`${from} to ${to}: ${what}`]
  if (edge.count > 1) parts.push(`${edge.count} times`)
  if (edge.back) parts.push(edge.retries === edge.count ? 'a retry' : 'back to an earlier node')
  if (edge.delay)
    parts.push(
      edge.count > 1 && edge.delay.min !== edge.delay.max
        ? `about ${formatSpan(edge.delay.min)} to ${formatSpan(edge.delay.max)}, median ${formatSpan(edge.delay.median)}`
        : `about ${formatSpan(edge.delay.median)}`
    )
  if (edge.slowest) parts.push('slowest hop')
  return parts.join(', ')
}
