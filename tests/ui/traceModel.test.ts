import { describe, expect, it } from 'vitest'
import type {
  ConsumerInfoDto,
  GatewayStreams,
  MessageDto,
  ScanRequest,
  StreamInfoDto
} from '@shared/api'
import { fromBase64 } from '@shared/encoding'
import { compileFilters } from '@shared/filters'
import {
  DAY,
  headerRule,
  HOUR,
  MINUTE,
  type TraceMessage,
  type TraceQuery,
  type TraceRule
} from '@shared/trace'
import {
  compareMessages,
  mergeMessages,
  runTrace,
  type TraceGateway
} from '@renderer/features/trace/model/collect'
import { buildTrace, formatSpan, messageId } from '@renderer/features/trace/model/trace'

const T0 = Date.parse('2026-03-01T10:00:00.000Z')
const at = (ms: number): string => new Date(T0 + ms).toISOString()

function dto(
  seq: number,
  subject: string,
  ms: number,
  headers: [string, string][] = [],
  body = ''
): MessageDto {
  return {
    seq,
    subject,
    time: at(ms),
    size: body.length,
    headers,
    payload: btoa(body),
    truncated: false
  }
}

function tm(stream: string, seq: number, ms: number, subject = 's'): TraceMessage {
  return { ...dto(seq, subject, ms), stream, ms: T0 + ms }
}

/** A fake gateway: every stream holds messages, and the scan filters them like the server does. */
function fakeGateway(
  streams: Record<string, MessageDto[]>,
  opts: { fail?: string[]; delay?: number } = {}
): TraceGateway & { requests: { stream: string; request: ScanRequest }[]; maxRunning: number } {
  let running = 0
  const gw = {
    requests: [] as { stream: string; request: ScanRequest }[],
    maxRunning: 0,
    listStreams: async () =>
      Object.keys(streams).map((name) => ({ config: { name } }) as unknown as StreamInfoDto),
    open<K extends keyof GatewayStreams>(
      _channel: K,
      args: GatewayStreams[K]['args'],
      onEvent: (event: GatewayStreams[K]['event']) => void
    ): () => void {
      const { stream, request } = args as GatewayStreams['scan']['args']
      const emit = onEvent as (e: GatewayStreams['scan']['event']) => void
      gw.requests.push({ stream, request })
      running++
      gw.maxRunning = Math.max(gw.maxRunning, running)
      let open = true
      setTimeout(() => {
        if (!open) return
        running--
        if (opts.fail?.includes(stream)) {
          emit({
            type: 'done',
            reason: 'error',
            scanned: 0,
            matched: 0,
            skippedNonJson: 0,
            resumeSeq: null,
            error: { kind: 'permission', message: 'not allowed' }
          })
          return
        }
        const test = compileFilters(request.filters)
        const start = request.start.kind === 'time' ? Date.parse(request.start.time) : 0
        const until = request.until ? Date.parse(request.until) : Infinity
        const found: MessageDto[] = []
        let scanned = 0
        let reason: 'end' | 'page' | 'limit' | 'until' = 'end'
        for (const m of streams[stream]) {
          const t = Date.parse(m.time)
          if (t < start) continue
          if (t > until) {
            reason = 'until'
            break
          }
          scanned++
          if (test(m.headers, fromBase64(m.payload), m.subject).match) found.push(m)
          if (found.length >= request.limit) {
            reason = 'page'
            break
          }
          if (scanned >= request.scanLimit) {
            reason = 'limit'
            break
          }
        }
        if (found.length) emit({ type: 'matches', messages: found })
        emit({
          type: 'done',
          reason,
          scanned,
          matched: found.length,
          skippedNonJson: 0,
          resumeSeq: null
        })
      }, opts.delay ?? 0)
      return () => {
        if (open && running > 0) running--
        open = false
      }
    }
  }
  return gw as never
}

const hdr = (id: string): [string, string][] => [['trace-id', id]]
const query = (rules: TraceRule[], extra: Partial<TraceQuery> = {}): TraceQuery => ({
  rules,
  window: { kind: 'around', anchor: at(0), ms: HOUR },
  ...extra
})

describe('PBI-138 collecting across streams', () => {
  const data = (): Record<string, MessageDto[]> => ({
    ORDERS: [dto(1, 'orders.new', -5000, hdr('a')), dto(2, 'orders.new', 100, hdr('b'))],
    PAY: [dto(7, 'pay.start', 2000, hdr('a')), dto(8, 'pay.done', 4000, [])],
    SHIP: [dto(3, 'ship.go', 3000, [], '{"order":{"id":"a"}}'), dto(4, 'ship.go', 3500, hdr('a'))],
    KV_cfg: [dto(1, '$KV.cfg.k', 10, hdr('a'))]
  })

  it('merges the streams in time order and skips system streams', async () => {
    const gw = fakeGateway(data())
    const rules: TraceRule[] = [
      headerRule('trace-id', 'a'),
      { kind: 'json', path: '$.order.id', value: 'a' }
    ]
    const result = await runTrace(gw, 'c', query(rules), { now: T0 })
    expect(result.messages.map(messageId)).toEqual(['ORDERS#1', 'PAY#7', 'SHIP#3', 'SHIP#4'])
    expect(result.streams.map((s) => s.stream)).toEqual(['ORDERS', 'PAY', 'SHIP'])
    expect(result.streams.every((s) => s.state === 'done')).toBe(true)
    // One scan per stream and rule, none for the system stream.
    expect(gw.requests).toHaveLength(6)
    expect(gw.requests.some((r) => r.stream === 'KV_cfg')).toBe(false)
    expect(gw.requests[0].request).toMatchObject({
      direction: 'asc',
      start: { kind: 'time', time: at(-HOUR) },
      until: at(HOUR)
    })
    const withSystem = await runTrace(
      fakeGateway(data()),
      'c',
      query([headerRule('trace-id', 'a')], { includeSystem: true })
    )
    expect(withSystem.messages.map(messageId)).toContain('KV_cfg#1')
  })

  it('merges the rules without duplicates and orders ties by stream then sequence', async () => {
    const same = at(0)
    const streams = {
      B: [{ ...dto(2, 'x', 0, hdr('a'), '{"id":"a"}'), time: same }],
      A: [
        { ...dto(9, 'x', 0, hdr('a'), '{"id":"a"}'), time: same },
        { ...dto(5, 'x', 0, hdr('a')), time: same }
      ]
    }
    const result = await runTrace(
      fakeGateway(streams),
      'c',
      query([headerRule('trace-id', 'a'), { kind: 'json', path: '$.id', value: 'a' }])
    )
    expect(result.messages.map(messageId)).toEqual(['A#5', 'A#9', 'B#2'])
    expect(result.streams.find((s) => s.stream === 'A')?.matched).toBe(2)
    const [x, y] = [tm('B', 1, 5), tm('A', 1, 5)]
    expect(mergeMessages([[x], [y, x]]).map(messageId)).toEqual(['A#1', 'B#1'])
    expect(compareMessages(tm('A', 2, 1), tm('A', 1, 2))).toBeLessThan(0)
  })

  it('drops messages outside the window when the scan starts at the last message', async () => {
    // A server that clamps a start past the end to the last message still sends it.
    const clamping = {
      listStreams: async () => [{ config: { name: 'S' } }] as unknown as StreamInfoDto[],
      open: (_c: string, _a: unknown, emit: (e: GatewayStreams['scan']['event']) => void) => {
        queueMicrotask(() => {
          emit({ type: 'matches', messages: [dto(1, 's', -2 * HOUR, hdr('a'))] })
          emit({
            type: 'done',
            reason: 'end',
            scanned: 1,
            matched: 1,
            skippedNonJson: 0,
            resumeSeq: null
          })
        })
        return () => {}
      }
    } as unknown as TraceGateway
    const result = await runTrace(clamping, 'c', query([headerRule('trace-id', 'a')]))
    expect(result.messages).toEqual([])
  })

  it('keeps going when one stream fails and reports it separately', async () => {
    const result = await runTrace(
      fakeGateway(data(), { fail: ['PAY'] }),
      'c',
      query([headerRule('trace-id', 'a')])
    )
    expect(result.messages.map(messageId)).toEqual(['ORDERS#1', 'SHIP#4'])
    const pay = result.streams.find((s) => s.stream === 'PAY')!
    expect(pay).toMatchObject({ state: 'error', error: 'not allowed' })
    expect(result.streams.find((s) => s.stream === 'ORDERS')?.state).toBe('done')
  })

  it('marks a stream partial at its scan limit or its match cap', async () => {
    const many = Array.from({ length: 30 }, (_, i) => dto(i + 1, 's', i, hdr('a')))
    const noCap = await runTrace(
      fakeGateway({ S: many }),
      'c',
      query([headerRule('trace-id', 'a')], { scanLimit: 100 }),
      { matchCap: 1000 }
    )
    expect(noCap.streams[0].partial).toBeUndefined()
    const capped = await runTrace(
      fakeGateway({ S: many }),
      'c',
      query([headerRule('trace-id', 'a')]),
      { matchCap: 10 }
    )
    expect(capped.streams[0]).toMatchObject({ partial: 'cap', matched: 10 })
    expect(capped.messages).toHaveLength(10)
    const big = Array.from({ length: 300 }, (_, i) => dto(i + 1, 's', i, hdr('a')))
    const scanLimited = await runTrace(
      fakeGateway({ S: big }),
      'c',
      query([headerRule('trace-id', 'zz')], { scanLimit: 100 })
    )
    expect(scanLimited.streams[0].partial).toBe('limit')
  })

  it('runs at most three scans at once', async () => {
    const streams = Object.fromEntries(
      ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((n) => [n, [dto(1, 's', 0, hdr('a'))]])
    )
    const gw = fakeGateway(streams, { delay: 5 })
    const result = await runTrace(gw, 'c', query([headerRule('trace-id', 'a')]))
    expect(result.messages).toHaveLength(7)
    expect(gw.maxRunning).toBe(3)
    const one = fakeGateway(streams, { delay: 5 })
    await runTrace(one, 'c', query([headerRule('trace-id', 'a')]), { concurrency: 1 })
    expect(one.maxRunning).toBe(1)
  })

  it('stops on abort and returns what it has', async () => {
    const streams = Object.fromEntries(
      ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((n) => [n, [dto(1, 's', 0, hdr('a'))]])
    )
    const gw = fakeGateway(streams, { delay: 20 })
    const ctl = new AbortController()
    const seen: number[] = []
    const run = runTrace(gw, 'c', query([headerRule('trace-id', 'a')]), {
      signal: ctl.signal,
      onProgress: (s) => seen.push(s.filter((p) => p.state === 'done').length)
    })
    setTimeout(() => ctl.abort(), 10)
    const result = await run
    expect(result.cancelled).toBe(true)
    expect(gw.requests).toHaveLength(3)
    expect(result.messages).toHaveLength(0)
    // Nothing started after the abort.
    await new Promise((r) => setTimeout(r, 60))
    expect(gw.requests).toHaveLength(3)
    expect(seen.length).toBeGreaterThan(0)
  })

  it('searches the streams a query names, even system ones', async () => {
    const gw = fakeGateway(data())
    await runTrace(gw, 'c', query([headerRule('trace-id', 'a')], { streams: ['KV_cfg'] }))
    expect(gw.requests.map((r) => r.stream)).toEqual(['KV_cfg'])
  })
})

function consumer(
  over: Partial<ConsumerInfoDto> & { name: string; filter?: string; floor?: number }
): ConsumerInfoDto {
  return {
    stream_name: 'S',
    name: over.name,
    created: at(-DAY),
    config: { ack_policy: 'explicit', deliver_policy: 'all', filter_subject: over.filter },
    delivered: { consumer_seq: 0, stream_seq: over.floor ?? 0 },
    ack_floor: { consumer_seq: 0, stream_seq: over.floor ?? 0 },
    num_ack_pending: 0,
    num_redelivered: 0,
    num_waiting: 0,
    num_pending: 0
  } as ConsumerInfoDto
}

describe('PBI-138 building the trace', () => {
  it('computes gaps, offsets and the largest gap', () => {
    const trace = buildTrace([tm('A', 1, 0), tm('A', 2, 120), tm('B', 1, 1620)])
    expect(trace.hops.map((h) => h.gapMs)).toEqual([null, 120, 1500])
    expect(trace.hops.map((h) => h.offsetMs)).toEqual([0, 120, 1620])
    expect(trace.maxGapMs).toBe(1500)
    expect(trace.durationMs).toBe(1620)
    expect(trace.streams).toEqual(['A', 'B'])
    expect(trace.subjects).toBe(1)
  })

  it('is empty for no messages', () => {
    expect(buildTrace([])).toEqual({
      hops: [],
      maxGapMs: 0,
      durationMs: 0,
      streams: [],
      subjects: 0
    })
  })

  it('never shows a negative gap for messages with the same time', () => {
    expect(buildTrace([tm('A', 1, 10), tm('B', 1, 10)]).hops[1].gapMs).toBe(0)
  })

  it('lists the consumers that have the message and leaves out those it is not for', () => {
    const consumers = {
      S: [
        consumer({ name: 'done', floor: 10 }),
        consumer({ name: 'elsewhere', filter: 'other.>', floor: 10 }),
        consumer({ name: 'behind', floor: 0 })
      ]
    }
    const trace = buildTrace([tm('S', 5, 0, 'orders.new')], consumers)
    expect(trace.hops[0].consumers.map((c) => [c.name, c.state])).toEqual([
      ['done', 'done'],
      ['behind', 'not-delivered']
    ])
    // A stream whose consumers were not read yet has no badges.
    expect(buildTrace([tm('T', 1, 0)], consumers).hops[0].consumers).toEqual([])
  })

  it('formats spans', () => {
    expect(formatSpan(0)).toBe('0 ms')
    expect(formatSpan(850)).toBe('850 ms')
    expect(formatSpan(1400)).toBe('1.4 s')
    expect(formatSpan(12_000)).toBe('12 s')
    expect(formatSpan(125_000)).toBe('2 min 5 s')
    expect(formatSpan(HOUR + 3 * MINUTE)).toBe('1 h 3 min')
    expect(formatSpan(DAY + 4 * HOUR)).toBe('1 d 4 h')
  })
})
