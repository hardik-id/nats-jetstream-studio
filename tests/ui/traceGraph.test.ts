import { describe, expect, it } from 'vitest'
import type { TraceMessage } from '@shared/trace'
import type { MessageConsumerState } from '@shared/messageConsumers'
import {
  buildGraph,
  cycleMessage,
  DEFAULT_GRAPH_OPTIONS,
  type GraphOptions,
  type TraceGraph
} from '@renderer/features/trace/model/graph'
import {
  BRANCH_INDENT,
  layoutGraph,
  type GraphLayout,
  type LayoutOptions
} from '@renderer/features/trace/model/layout'
import { layoutLanes } from '@renderer/features/trace/model/lanes'
import {
  LOOP_PAUSE,
  MAX_CYCLE,
  MAX_DOTS_PER_EDGE,
  MAX_TRAVEL,
  MIN_TRAVEL,
  planMotion
} from '@renderer/features/trace/model/motion'
import { buildTrace, slowestHop, type Trace } from '@renderer/features/trace/model/trace'
import { edgeLabel, edgeName } from '@renderer/features/trace/views/graph/text'
import {
  fitViewport,
  MIN_FIT_ZOOM,
  revealViewport
} from '@renderer/features/trace/views/graph/viewport'
import { roundedPath } from '@renderer/features/trace/views/graph/paths'

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

/** One message: stream, subject, time, and the consumers that have it (name or name:state). */
type Step = [stream: string, subject: string, ms: number, consumers?: string[]]

function trace(...steps: Step[]): Trace {
  const t = buildTrace(steps.map(([stream, subject, ms], i) => msg(stream, i + 1, subject, ms)))
  steps.forEach(([, , , consumers = []], i) => {
    t.hops[i].consumers = consumers.map((c) => {
      const [name, state = 'done'] = c.split(':')
      return { name, state: state as MessageConsumerState, label: '', tooltip: '' }
    })
  })
  return t
}
const opts = (o: Partial<GraphOptions> = {}): GraphOptions => ({ ...DEFAULT_GRAPH_OPTIONS, ...o })
const edge = (g: TraceGraph, id: string) => g.edges.find((e) => e.id === id)!
const ids = (g: TraceGraph) => g.edges.map((e) => e.id)

/** A request across three streams, through one consumer per hop. */
const request = trace(
  ['ORD', 'orders.created', 0, ['order-svc']],
  ['PAY', 'pay.requested', 40, ['billing']],
  ['PAY', 'pay.charged', 160, ['ledger']],
  ['SHIP', 'ship.pack', 1800]
)

describe('PBI-138 graph model', () => {
  it('goes through the one consumer that received a message: subject, consumer, next subject', () => {
    const g = buildGraph(request, opts({ group: false }))
    expect(g.nodes.map((n) => n.id)).toEqual([
      'subject:orders.created',
      'consumer:ORD/order-svc@orders.created',
      'subject:pay.requested',
      'consumer:PAY/billing@pay.requested',
      'subject:pay.charged',
      'consumer:PAY/ledger@pay.charged',
      'subject:ship.pack'
    ])
    expect(ids(g)).toEqual([
      'delivery:subject:orders.created->consumer:ORD/order-svc@orders.created',
      'hop:consumer:ORD/order-svc@orders.created->subject:pay.requested',
      'delivery:subject:pay.requested->consumer:PAY/billing@pay.requested',
      'hop:consumer:PAY/billing@pay.requested->subject:pay.charged',
      'delivery:subject:pay.charged->consumer:PAY/ledger@pay.charged',
      'hop:consumer:PAY/ledger@pay.charged->subject:ship.pack'
    ])
    // A delivery is known and carries no delay; the hop after it is inferred and carries the gap.
    expect(edge(g, ids(g)[0])).toMatchObject({ kind: 'delivery', delays: [], delay: null })
    expect(edge(g, ids(g)[1])).toMatchObject({
      kind: 'hop',
      delays: [40],
      delay: { min: 40, median: 40, max: 40 },
      messages: [1],
      back: false
    })
    expect(g.arrivedBy).toEqual([null, ids(g)[1], ids(g)[3], ids(g)[5]])
    expect(g.receivers).toEqual([
      ['consumer:ORD/order-svc@orders.created'],
      ['consumer:PAY/billing@pay.requested'],
      ['consumer:PAY/ledger@pay.charged'],
      []
    ])
    expect(g.path.map((s) => [s.from, s.to, s.branch])).toEqual([
      [0, 0, false],
      [0, 1, false],
      [1, 1, false],
      [1, 2, false],
      [2, 2, false],
      [2, 3, false]
    ])
  })

  it('goes straight to the next subject when several consumers received it, with the consumers as side branches', () => {
    const g = buildGraph(
      trace(
        ['EVT', 'evt.placed', 0, ['email', 'sms', 'audit', 'search']],
        ['SHIP', 'ship.pack', 70]
      ),
      opts()
    )
    expect(ids(g)).toEqual([
      'delivery:subject:evt.placed->consumer:EVT/email@evt.placed',
      'delivery:subject:evt.placed->consumer:EVT/sms@evt.placed',
      'delivery:subject:evt.placed->consumer:EVT/audit@evt.placed',
      'delivery:subject:evt.placed->consumer:EVT/search@evt.placed',
      'hop:subject:evt.placed->subject:ship.pack'
    ])
    expect(g.path.filter((s) => s.branch)).toHaveLength(4)
    expect(g.receivers[0]).toHaveLength(4)
  })

  it('also goes straight on when no consumer received the message', () => {
    const g = buildGraph(trace(['A', 'a', 0], ['B', 'b', 5]), opts())
    expect(ids(g)).toEqual(['hop:subject:a->subject:b'])
  })

  it("hangs the last message's consumers off it, and draws a message not delivered yet as pending", () => {
    const g = buildGraph(trace(['A', 'a', 0], ['B', 'b', 5, ['done-one', 'late:not-delivered']]))
    expect(ids(g)).toEqual([
      'hop:subject:a->subject:b',
      'delivery:subject:b->consumer:B/done-one@b',
      'pending:subject:b->consumer:B/late@b'
    ])
    const late = g.nodes.find((n) => n.id === 'consumer:B/late@b')!
    expect(late).toMatchObject({ kind: 'consumer', done: 0, waiting: 0, undelivered: 1 })
    // A consumer waiting for its message did not receive it, so it does not route the request.
    expect(g.receivers[1]).toEqual(['consumer:B/done-one@b'])
  })

  it('counts where each consumer stands, with one node per subject it receives from', () => {
    const g = buildGraph(
      trace(
        ['P', 'p.a', 0, ['c']],
        ['P', 'p.a', 5, ['c:waiting-ack']],
        ['P', 'p.a', 9, ['c:not-delivered']],
        ['P', 'p.b', 12, ['c']]
      )
    )
    expect(g.nodes.find((n) => n.id === 'consumer:P/c@p.a')).toMatchObject({
      done: 1,
      waiting: 1,
      undelivered: 1,
      messages: [0, 1, 2],
      shared: true
    })
    expect(g.nodes.find((n) => n.id === 'consumer:P/c@p.b')).toMatchObject({
      done: 1,
      messages: [3],
      subject: 'p.b',
      shared: true
    })
  })

  it('makes same-subject repeats one repeat edge back, not more nodes', () => {
    // Three charge requests in a row, each received by billing.
    const g = buildGraph(
      trace(
        ['PAY', 'pay.requested', 0, ['billing']],
        ['PAY', 'pay.requested', 300, ['billing']],
        ['PAY', 'pay.requested', 800, ['billing']],
        ['PAY', 'pay.charged', 900]
      )
    )
    expect(g.nodes).toHaveLength(3)
    const repeat = edge(g, 'hop:consumer:PAY/billing@pay.requested->subject:pay.requested')
    expect(repeat).toMatchObject({ back: true, repeats: 2, count: 2, messages: [1, 2] })
    expect(repeat.delay).toEqual({ min: 300, median: 400, max: 500 })
    expect(edgeLabel(repeat)).toBe('repeat ×2 · up to ~500 ms')
    expect(
      edge(g, 'delivery:subject:pay.requested->consumer:PAY/billing@pay.requested').count
    ).toBe(3)

    // Without consumers a repeat is a loop on the subject itself.
    const plain = buildGraph(trace(['A', 'a', 0], ['A', 'a', 10], ['B', 'b', 15]), opts())
    expect(edge(plain, 'hop:subject:a->subject:a')).toMatchObject({ back: true, repeats: 1 })
    expect(edgeLabel(edge(plain, 'hop:subject:a->subject:a'))).toBe('repeat · ~10 ms')
  })

  it('marks a revisit of an earlier subject as a back edge that is not a repeat', () => {
    const g = buildGraph(trace(['A', 'a', 0], ['B', 'b', 10], ['A', 'a', 20]), opts())
    const back = edge(g, 'hop:subject:b->subject:a')
    expect(back).toMatchObject({ back: true, repeats: 0 })
    expect(edgeLabel(back)).toBe('back · ~10 ms')
  })

  it('merges repeated hops and summarises their delays', () => {
    const g = buildGraph(
      trace(
        ['A', 'a', 0],
        ['B', 'b', 10],
        ['A', 'a', 20],
        ['B', 'b', 50],
        ['A', 'a', 60],
        ['B', 'b', 160]
      ),
      opts()
    )
    const ab = edge(g, 'hop:subject:a->subject:b')
    expect(ab).toMatchObject({ count: 3, delays: [10, 30, 100], messages: [1, 3, 5] })
    expect(ab.delay).toEqual({ min: 10, median: 30, max: 100 })
  })

  it('marks the slowest hop with the rule the Lanes view uses', () => {
    const g = buildGraph(request, opts())
    expect(g.slowest).toBe(3)
    expect(g.slowest).toBe(slowestHop(request.hops))
    expect(g.slowest).toBe(layoutLanes(request).slowest)
    expect(g.edges.filter((e) => e.slowest).map((e) => e.id)).toEqual([
      'hop:consumer:PAY/ledger@pay.charged->subject:ship.pack'
    ])
    // Two messages (one hop), or equal gaps, have no slowest hop.
    expect(buildGraph(trace(['A', 'a', 0], ['B', 'b', 9])).slowest).toBeNull()
    expect(buildGraph(trace(['A', 'a', 0], ['B', 'b', 9], ['C', 'c', 18])).slowest).toBeNull()
  })

  it('routes subject to subject with consumers off', () => {
    const g = buildGraph(request, opts({ consumers: false }))
    expect(g.nodes.every((n) => n.kind === 'subject')).toBe(true)
    expect(g.edges.every((e) => e.kind === 'hop')).toBe(true)
    expect(g.edges).toHaveLength(3)
    expect(g.receivers.every((r) => r.length === 0)).toBe(true)
  })

  it('groups similar subjects into one node when asked, as the Lanes view does', () => {
    const t = trace(['O', 'orders.1001.paid', 0], ['O', 'orders.1002.paid', 5], ['S', 'ship.x', 9])
    const grouped = buildGraph(t, opts({ group: true }))
    expect(grouped.nodes[0]).toMatchObject({
      key: 'orders.*.paid',
      subjects: ['orders.1001.paid', 'orders.1002.paid'],
      messages: [0, 1]
    })
    expect(buildGraph(t, opts({ group: false })).nodes).toHaveLength(3)
  })

  it('handles one message and no message', () => {
    const one = buildGraph(trace(['A', 'a', 0]))
    expect(one.nodes).toHaveLength(1)
    expect(one.edges).toEqual([])
    expect(buildGraph(trace()).nodes).toEqual([])
  })

  it('is the same for the same trace', () => {
    expect(buildGraph(request)).toEqual(buildGraph(request))
  })

  it('a click steps through the messages of a node or edge, and wraps around', () => {
    expect(cycleMessage([2, 5, 7], null)).toBe(2)
    expect(cycleMessage([2, 5, 7], 5)).toBe(7)
    expect(cycleMessage([2, 5, 7], 7)).toBe(2)
    expect(cycleMessage([2, 5, 7], 3)).toBe(2)
    expect(cycleMessage([], 1)).toBeNull()
  })

  it('names nodes and edges for assistive technology', () => {
    const g = buildGraph(request)
    const nodes = new Map(g.nodes.map((n) => [n.id, n]))
    expect(edgeName(g.edges[0], nodes)).toBe('orders.created to order-svc: delivered (known)')
    expect(edgeName(g.edges[5], nodes)).toBe(
      'ledger to ship.pack: next message (inferred from time), about 1.6 s, slowest hop'
    )
    expect(edgeLabel(g.edges[0])).toBeNull()
    expect(edgeLabel(g.edges[1])).toBe('~40 ms')
  })
})

// ───────────── Layout ─────────────

function overlaps(layout: GraphLayout): string[] {
  const boxes = Object.values(layout.nodes)
  const out: string[] = []
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]
      const b = boxes[j]
      if (
        a.x < b.x + b.width &&
        b.x < a.x + a.width &&
        a.y < b.y + b.height &&
        b.y < a.y + a.height
      )
        out.push(`${a.id} / ${b.id}`)
    }
  return out
}

/** Checks that hold for every layout. */
function checkLayout(g: TraceGraph, options?: LayoutOptions): GraphLayout {
  const l = layoutGraph(g, options)
  expect(Object.keys(l.nodes).sort()).toEqual(g.nodes.map((n) => n.id).sort())
  expect(overlaps(l)).toEqual([])
  for (const e of g.edges) {
    const a = l.nodes[e.source]
    const b = l.nodes[e.target]
    const route = l.routes[e.id]
    if (route?.kind === 'branch') {
      // A side branch hangs below its subject, indented, in the same column.
      expect(b.column).toBe(a.column)
      expect(b.y).toBeGreaterThan(a.y)
      expect(b.x).toBe(a.x + BRANCH_INDENT)
    } else if (route?.kind === 'detour') {
      // The lane runs above every node of the target's band.
      const band = Object.values(l.nodes).filter((n) => n.band === b.band)
      expect(route.y).toBeLessThan(Math.min(...band.map((n) => n.y)))
      expect(route.outX).toBeGreaterThan(a.x + a.width)
      expect(route.inX).toBeLessThan(b.x)
    } else {
      // A plain curve goes forward to the next columns of the same band.
      expect(e.back).toBe(false)
      expect(b.rank).toBeGreaterThan(a.rank)
      expect(b.band).toBe(a.band)
    }
    if (!e.back && route?.kind !== 'branch' && e.source !== e.target)
      expect(b.rank).toBeGreaterThan(a.rank)
    if (e.back) expect(route?.kind).toBe('detour')
  }
  // Inside the bounds.
  for (const n of Object.values(l.nodes)) {
    expect(n.x).toBeGreaterThanOrEqual(l.bounds.x)
    expect(n.y).toBeGreaterThanOrEqual(l.bounds.y)
    expect(n.x + n.width).toBeLessThanOrEqual(l.bounds.x + l.bounds.width)
    expect(n.y + n.height).toBeLessThanOrEqual(l.bounds.y + l.bounds.height)
  }
  // Stable.
  expect(layoutGraph(g, options)).toEqual(l)
  return l
}

/** A random walk over `subjects` subjects, the same every run. */
function walk(messages: number, subjects: number, forward = 0.75): Trace {
  let seed = 11
  const rnd = (): number => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
  let at = 0
  const steps: Step[] = []
  for (let i = 0; i < messages; i++) {
    at = rnd() < forward ? (at + 1) % subjects : Math.floor(rnd() * subjects)
    steps.push(['S', `svc.step${at}`, i * 7, rnd() < 0.3 ? [`worker${at}`] : []])
  }
  return trace(...steps)
}

describe('PBI-138 graph layout', () => {
  it('lays a single node out', () => {
    const l = checkLayout(buildGraph(trace(['A', 'a', 0])))
    expect(l).toMatchObject({ ranks: 1, bands: 1, columns: 1 })
    expect(l.nodes['subject:a']).toMatchObject({ rank: 0, x: 0, y: 0 })
  })

  it('puts the request on one straight row, left to right in time, when it fits', () => {
    const g = buildGraph(request)
    const l = checkLayout(g, { area: { width: 5000, height: 800 } })
    expect(l.bands).toBe(1)
    const ranks = g.nodes.map((n) => l.nodes[n.id].rank)
    expect(ranks).toEqual([0, 1, 2, 3, 4, 5, 6])
    const ys = new Set(g.nodes.map((n) => l.nodes[n.id].y + l.nodes[n.id].height / 2))
    expect(ys.size).toBe(1)
  })

  it('wraps a long request into bands that show it larger in a small area', () => {
    const g = buildGraph(walk(16, 16, 1))
    const wide = checkLayout(g)
    expect(wide.bands).toBe(1)
    const l = checkLayout(g, { area: { width: 1100, height: 700 } })
    expect(l.bands).toBeGreaterThan(1)
    expect(l.columns * l.bands).toBeGreaterThanOrEqual(l.ranks)
    // Bands read like lines of text: the next rank starts the next band.
    const first = Object.values(l.nodes).filter((n) => n.band === 1)
    expect(Math.min(...first.map((n) => n.rank))).toBe(l.columns)
    // An edge from one band to the next takes a lane between them.
    const crossing = g.edges.filter(
      (e) => l.nodes[e.source].band !== l.nodes[e.target].band && !e.back
    )
    expect(crossing.length).toBe(l.bands - 1)
    for (const e of crossing) expect(l.routes[e.id]?.kind).toBe('detour')
  })

  it('routes repeats and revisits around the nodes', () => {
    const g = buildGraph(
      trace(
        ['PAY', 'pay.requested', 0, ['billing']],
        ['PAY', 'pay.requested', 300, ['billing']],
        ['ORD', 'orders.done', 400],
        ['PAY', 'pay.requested', 500]
      )
    )
    const l = checkLayout(g)
    const back = g.edges.filter((e) => e.back)
    expect(back.length).toBe(2)
    // Two detours over the same columns take different lanes.
    const lanes = back.map((e) => l.routes[e.id]).filter((r) => r?.kind === 'detour')
    expect(new Set(lanes.map((r) => r!.kind === 'detour' && r.y)).size).toBe(2)
  })

  it('hangs a fan-out below its subject', () => {
    const g = buildGraph(
      trace(
        ['EVT', 'evt.placed', 0, ['email', 'sms', 'audit', 'search']],
        ['SHIP', 'ship.pack', 70]
      )
    )
    const l = checkLayout(g)
    const branches = g.edges.filter((e) => l.routes[e.id]?.kind === 'branch')
    expect(branches).toHaveLength(4)
    expect(l.ranks).toBe(2)
  })

  it('keeps a wide fan-out and 30+ nodes apart', () => {
    const many = Array.from({ length: 12 }, (_, i) => `consumer${i}`)
    checkLayout(buildGraph(trace(['E', 'e', 0, many], ['F', 'f', 9, many.slice(0, 6)])))
    const big = buildGraph(walk(200, 15))
    expect(big.nodes.length).toBeGreaterThanOrEqual(30)
    checkLayout(big)
    checkLayout(big, { area: { width: 1100, height: 600 } })
    checkLayout(big, { area: { width: 600, height: 400 }, compactLanes: true })
  })

  it('handles consumers off and grouped subjects', () => {
    checkLayout(buildGraph(walk(60, 8), opts({ consumers: false })))
    checkLayout(buildGraph(walk(60, 8), opts({ group: false })))
  })
})

describe('PBI-138 graph motion', () => {
  it('plays a short path as one request, then pauses and loops', () => {
    const g = buildGraph(request)
    const m = planMotion(g)
    // Three deliveries (0.9 s) and three hops: 40 ms and 120 ms are raised to the minimum, the
    // slow 1.64 s one keeps its time.
    const travel = 3 * 0.9 + 2 * MIN_TRAVEL + 1.64
    expect(m.cycle).toBeCloseTo(travel + LOOP_PAUSE)
    const starts = g.path.map((s) => m.dots[s.edge][0].start)
    expect(starts).toEqual([...starts].sort((a, b) => a - b))
    expect(starts[0]).toBe(0)
    expect(m.dots[g.edges[5].id][0].travel).toBeCloseTo(1.64)
  })

  it('starts side branches together with the step after them', () => {
    const g = buildGraph(
      trace(['EVT', 'evt.placed', 0, ['email', 'sms']], ['SHIP', 'ship.pack', 70])
    )
    const m = planMotion(g)
    expect(Object.values(m.dots).map((d) => d[0].start)).toEqual([0, 0, 0])
  })

  it('keeps travel times between the bounds and at most a few dots per edge', () => {
    const g = buildGraph(walk(200, 15))
    const m = planMotion(g)
    expect(m.cycle).toBe(MAX_CYCLE)
    for (const dots of Object.values(m.dots)) {
      expect(dots.length).toBeLessThanOrEqual(MAX_DOTS_PER_EDGE)
      for (const d of dots) {
        expect(d.travel).toBeGreaterThanOrEqual(MIN_TRAVEL)
        expect(d.travel).toBeLessThanOrEqual(MAX_TRAVEL)
        expect(d.start).toBeGreaterThanOrEqual(0)
        expect(d.start).toBeLessThan(m.cycle)
      }
    }
  })
})

describe('PBI-138 graph geometry', () => {
  it('fits a small graph at full size in the middle, and shows the start of a huge one', () => {
    const small = fitViewport({ bounds: { x: 0, y: 0, width: 400, height: 100 } }, 1000, 600)
    expect(small.zoom).toBe(1)
    expect(small.x).toBe(300)
    const huge = fitViewport({ bounds: { x: -10, y: -20, width: 9000, height: 3000 } }, 1000, 600)
    expect(huge.zoom).toBe(MIN_FIT_ZOOM)
    expect(huge.x).toBeCloseTo(28 + 10 * MIN_FIT_ZOOM)
  })

  it('brings the selected node into view only when it is not fully in it', () => {
    const node = { x: 900, y: 100, width: 200, height: 60 }
    expect(revealViewport({ x: 0, y: 0, zoom: 1 }, node, 1200, 600)).toBeNull()
    expect(revealViewport({ x: 0, y: 0, zoom: 1 }, node, 1000, 600)).toEqual({
      x: 500 - 1000,
      y: 300 - 130,
      zoom: 1
    })
  })

  it('rounds the corners of a polyline', () => {
    expect(
      roundedPath([
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 50 }
      ])
    ).toBe('M0 0L90 0Q100 0 100 10L100 50')
  })
})

describe('PBI-138 graph review fixes', () => {
  // One consumer receives from two subjects: hop 0 by worker and audit, hop 1 by worker only.
  const shared = trace(
    ['ORD', 'orders.new', 0, ['worker', 'audit']],
    ['ORD', 'orders.paid', 20, ['worker']],
    ['SHIP', 'ship', 50]
  )

  it('never marks a delivery as going back, also to a consumer seen before', () => {
    const g = buildGraph(shared)
    const deliveries = g.edges.filter((e) => e.kind !== 'hop')
    expect(deliveries.length).toBeGreaterThan(0)
    for (const e of deliveries) {
      expect(e.back).toBe(false)
      expect(edgeLabel(e) ?? '').not.toMatch(/back|repeat/)
    }
    const l = checkLayout(g)
    for (const e of deliveries) expect(l.routes[e.id]?.kind).not.toBe('detour')
  })

  it('plays no dot towards a consumer that has not received the message', () => {
    const g = buildGraph(trace(['A', 'a', 0, ['late:not-delivered']], ['B', 'b', 10]))
    const pending = g.edges.find((e) => e.kind === 'pending')!
    expect(pending).toBeDefined()
    expect(planMotion(g).dots[pending.id]).toBeUndefined()
  })

  it('lays out a cycle A, B, A with consumers on', () => {
    const g = buildGraph(
      trace(['A', 'a', 0, ['ca']], ['B', 'b', 10, ['cb']], ['A', 'a', 20, ['ca']], ['B', 'b', 30])
    )
    expect(g.edges.filter((e) => e.back).every((e) => e.kind === 'hop')).toBe(true)
    expect(g.edges.some((e) => e.back)).toBe(true)
    checkLayout(g)
  })

  it('lays out messages with identical timestamps without NaN or overlap', () => {
    const g = buildGraph(
      trace(['A', 'a', 0, ['x']], ['B', 'b', 0, ['y', 'z']], ['C', 'c', 0], ['A', 'a', 0])
    )
    const l = checkLayout(g, { area: { width: 600, height: 400 } })
    for (const n of Object.values(l.nodes))
      for (const v of [n.x, n.y, n.width, n.height]) expect(Number.isFinite(v)).toBe(true)
    for (const v of Object.values(l.bounds)) expect(Number.isFinite(v)).toBe(true)
    const m = planMotion(g)
    expect(Number.isFinite(m.cycle)).toBe(true)
  })
})
