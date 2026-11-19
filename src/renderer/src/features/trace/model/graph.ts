import { groupSubject } from './subjectGroup'
import { slowestHop, type ConsumerBadge, type Trace } from './trace'

/**
 * The trace as a graph (PBI-138 phase 3): subjects and consumers as nodes, the way the request
 * went as edges. Pure: no React, no sizes of the screen (see `layout.ts` for positions).
 *
 * The request path is the time order of the messages. NATS records which consumers received a
 * message, but not who published the next one, so a step from one message to the next is
 * inferred. When exactly one consumer received a message, the step goes through it (subject, the
 * consumer that received it, the next subject); otherwise it goes straight to the next subject and
 * the consumers hang off the subject as side branches.
 */

export interface GraphOptions {
  /** Consumers as nodes. Off: every step goes from subject to subject. */
  consumers: boolean
  /** Collapse id-like subject tokens (see `groupSubject`), as the Lanes view does. */
  group: boolean
}

export const DEFAULT_GRAPH_OPTIONS: GraphOptions = { consumers: true, group: true }

interface NodeBase {
  id: string
  /** Order of first appearance along the path: 0 for the first node. */
  order: number
  /** Indexes (in the trace) of the messages at this node, in time order. */
  messages: number[]
}

export interface SubjectNode extends NodeBase {
  kind: 'subject'
  /** The subject, or the grouped subject with `*` for id-like tokens. */
  key: string
  /** The real subjects of its messages, in order of first appearance. */
  subjects: string[]
  streams: string[]
}

export interface ConsumerNode extends NodeBase {
  kind: 'consumer'
  stream: string
  name: string
  /** Messages it is finished with (acknowledged, or delivered with ack policy none). */
  done: number
  /** Messages delivered and waiting for an acknowledgement. */
  waiting: number
  /** Messages for it that it has not received yet. */
  undelivered: number
}

export type GraphNode = SubjectNode | ConsumerNode

/**
 * `delivery`: known, the consumer received the message. `pending`: known, the message is for the
 * consumer but it has not received it yet. `hop`: inferred, the next message followed in time.
 */
export type EdgeKind = 'delivery' | 'pending' | 'hop'

export interface DelayStats {
  min: number
  median: number
  max: number
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  kind: EdgeKind
  /** How many steps of the path it stands for. */
  count: number
  /** The delays of its hops in milliseconds (none for deliveries), and their summary. */
  delays: number[]
  delay: DelayStats | null
  /** Indexes of the messages it leads to, one per step, in time order. */
  messages: number[]
  /** The target was first seen before the source: a retry or a revisit of an earlier node. */
  back: boolean
  /** Steps that went back to the subject of the message they left from. */
  retries: number
  /** It carries the slowest hop of the trace (see `slowestHop`). */
  slowest: boolean
}

/** One move along the path. */
export interface PathStep {
  edge: string
  /** The message the request is at when the step starts. */
  from: number
  /** The message the step leads to. */
  to: number
  /** Milliseconds the step took, when it is known (hops only). */
  delayMs: number | null
  /** A side branch: it starts with the next step instead of after the previous one. */
  branch: boolean
}

export interface TraceGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** The path in time order. */
  path: PathStep[]
  /** The subject node of each message. */
  nodeOf: string[]
  /** The consumer nodes that received each message (empty with consumers off). */
  receivers: string[][]
  /** The hop edge that leads to each message; null for the first one. */
  arrivedBy: (string | null)[]
  /** The index of the message after the slowest hop, as `slowestHop` says. */
  slowest: number | null
}

const subjectId = (key: string): string => `subject:${key}`
const consumerId = (stream: string, name: string): string => `consumer:${stream}/${name}`
const received = (b: ConsumerBadge): boolean => b.state === 'done' || b.state === 'waiting-ack'

function median(sorted: readonly number[]): number {
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Builds the graph of a trace. The same trace and options always give the same graph. */
export function buildGraph(
  trace: Pick<Trace, 'hops'>,
  options: GraphOptions = DEFAULT_GRAPH_OPTIONS
): TraceGraph {
  const { hops } = trace
  const nodes = new Map<string, GraphNode>()
  const edges = new Map<string, GraphEdge>()
  const path: PathStep[] = []
  const slowest = slowestHop(hops)
  const keyOf = (i: number): string =>
    options.group ? groupSubject(hops[i].message.subject) : hops[i].message.subject
  const nodeOf = hops.map((_, i) => subjectId(keyOf(i)))
  const receivers: string[][] = hops.map(() => [])
  const arrivedBy: (string | null)[] = hops.map(() => null)

  const subject = (i: number): SubjectNode => {
    const id = nodeOf[i]
    let node = nodes.get(id)
    if (!node) {
      node = {
        kind: 'subject',
        id,
        order: nodes.size,
        key: keyOf(i),
        messages: [],
        subjects: [],
        streams: []
      }
      nodes.set(id, node)
    }
    return node as SubjectNode
  }
  const consumer = (stream: string, name: string): ConsumerNode => {
    const id = consumerId(stream, name)
    let node = nodes.get(id)
    if (!node) {
      node = {
        kind: 'consumer',
        id,
        order: nodes.size,
        stream,
        name,
        messages: [],
        done: 0,
        waiting: 0,
        undelivered: 0
      }
      nodes.set(id, node)
    }
    return node as ConsumerNode
  }
  const step = (
    source: string,
    target: string,
    kind: EdgeKind,
    from: number,
    to: number,
    branch: boolean
  ): void => {
    const id = `${kind}:${source}->${target}`
    let edge = edges.get(id)
    if (!edge) {
      edge = {
        id,
        source,
        target,
        kind,
        count: 0,
        delays: [],
        delay: null,
        messages: [],
        back: false,
        retries: 0,
        slowest: false
      }
      edges.set(id, edge)
    }
    const delayMs = kind === 'hop' ? (hops[to].gapMs ?? 0) : null
    edge.count++
    edge.messages.push(to)
    if (delayMs !== null) edge.delays.push(delayMs)
    if (kind === 'hop') {
      arrivedBy[to] = id
      if (nodeOf[to] === nodeOf[from]) edge.retries++
      if (to === slowest) edge.slowest = true
    }
    path.push({ edge: id, from, to, delayMs, branch })
  }

  hops.forEach((hop, i) => {
    const at = subject(i)
    at.messages.push(i)
    if (!at.subjects.includes(hop.message.subject)) at.subjects.push(hop.message.subject)
    if (!at.streams.includes(hop.message.stream)) at.streams.push(hop.message.stream)

    const badges = options.consumers ? hop.consumers : []
    const got: ConsumerNode[] = []
    const waitingFor: ConsumerNode[] = []
    for (const b of badges) {
      const c = consumer(hop.message.stream, b.name)
      c.messages.push(i)
      if (b.state === 'done') c.done++
      else if (b.state === 'waiting-ack') c.waiting++
      else c.undelivered++
      if (received(b)) {
        got.push(c)
        receivers[i].push(c.id)
      } else waitingFor.push(c)
    }

    const next = i + 1 < hops.length ? i + 1 : null
    // Exactly one consumer received it, and something followed: the request went through it.
    const via = next !== null && got.length === 1 ? got[0] : null
    for (const c of got) if (c !== via) step(at.id, c.id, 'delivery', i, i, true)
    for (const c of waitingFor) step(at.id, c.id, 'pending', i, i, true)
    if (next === null) return
    const nextId = subject(next).id
    if (via) {
      step(at.id, via.id, 'delivery', i, i, false)
      step(via.id, nextId, 'hop', i, next, false)
    } else step(at.id, nextId, 'hop', i, next, false)
  })

  for (const edge of edges.values()) {
    edge.back = nodes.get(edge.target)!.order <= nodes.get(edge.source)!.order
    if (edge.delays.length) {
      const sorted = [...edge.delays].sort((a, b) => a - b)
      edge.delay = { min: sorted[0], median: median(sorted), max: sorted[sorted.length - 1] }
    }
  }

  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    path,
    nodeOf,
    receivers,
    arrivedBy,
    slowest
  }
}

/**
 * The message a click on a node or an edge selects, from the messages it stands for: the first,
 * or the one after the selected message when that is one of them (so clicking again steps on, and
 * wraps around).
 */
export function cycleMessage(messages: readonly number[], selected: number | null): number | null {
  if (messages.length === 0) return null
  const at = selected === null ? -1 : messages.indexOf(selected)
  return at < 0 ? messages[0] : messages[(at + 1) % messages.length]
}
