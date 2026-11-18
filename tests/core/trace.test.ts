import { headers } from '@nats-io/transport-node'
import type { JetStreamManager } from '@nats-io/jetstream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MessageDto, ScanEvent, ScanRequest } from '@shared/api'
import { messageConsumerStatus } from '@shared/messageConsumers'
import { MINUTE, headerRule, type TraceQuery } from '@shared/trace'
import { runTrace, type TraceGateway } from '@renderer/features/trace/model/collect'
import { collect, createHarness, uniqueName, type Harness } from '../helpers/studio'

let h: Harness
let id: string
let jsm: JetStreamManager
beforeAll(async () => {
  h = await createHarness()
  id = await h.connect({ name: 'trace' })
  jsm = (await h.client()).jsm
})
afterAll(async () => {
  await h.dispose()
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function scan(
  stream: string,
  request: Partial<ScanRequest>
): Promise<{ matches: MessageDto[]; done: Extract<ScanEvent, { type: 'done' }> }> {
  const full: ScanRequest = {
    direction: 'asc',
    start: { kind: 'first' },
    limit: 1000,
    scanLimit: 10_000,
    filters: {},
    ...request
  }
  const { events, close } = await collect(
    h.service,
    'scan',
    { connId: id, stream, request: full },
    (e) => e.some((x) => x.type === 'done')
  )
  close()
  return {
    matches: events.flatMap((e) => (e.type === 'matches' ? e.messages : [])),
    done: events.find((e) => e.type === 'done') as Extract<ScanEvent, { type: 'done' }>
  }
}

describe('PBI-138 scan end bound', () => {
  it('stops at the first message stored after `until`', async () => {
    const { js } = await h.client()
    const name = uniqueName('UNTIL')
    await jsm.streams.add({ name, subjects: [`${name}.>`] })
    for (let i = 1; i <= 3; i++) await js.publish(`${name}.x`, `early-${i}`)
    await sleep(250)
    const cut = new Date()
    await sleep(250)
    for (let i = 1; i <= 3; i++) await js.publish(`${name}.x`, `late-${i}`)

    const bounded = await scan(name, { until: cut.toISOString() })
    expect(bounded.matches.map((m) => m.seq)).toEqual([1, 2, 3])
    expect(bounded.done).toMatchObject({ reason: 'until', scanned: 3, matched: 3, resumeSeq: null })

    // Without it the scan reads everything; a time start and an end make a window.
    expect((await scan(name, {})).done).toMatchObject({ reason: 'end', scanned: 6 })
    const window = await scan(name, {
      start: { kind: 'time', time: new Date(cut.getTime() - 100).toISOString() },
      until: new Date(cut.getTime() + 600).toISOString()
    })
    expect(window.matches.map((m) => m.seq)).toEqual([4, 5, 6])
    expect(window.done.reason).toBe('end')

    const bad = await scan(name, { until: 'not a date' })
    expect(bad.done.reason).toBe('error')
    expect(bad.done.error?.kind).toBe('validation')
    await jsm.streams.delete(name)
  })

  it('refuses an end time on a descending scan', async () => {
    const { js } = await h.client()
    const name = uniqueName('UNTILD')
    await jsm.streams.add({ name, subjects: [`${name}.>`] })
    await js.publish(`${name}.x`, 'a')
    const r = await scan(name, {
      direction: 'desc',
      start: { kind: 'last' },
      until: new Date().toISOString()
    })
    expect(r.done.reason).toBe('error')
    expect(r.done.error?.kind).toBe('validation')
    await jsm.streams.delete(name)
  })
})

describe('PBI-138 a trace across three streams', () => {
  it('follows a header and a JSON field through orders, payments and shipping', async () => {
    const { js } = await h.client()
    const tag = uniqueName('REQ')
    const orders = uniqueName('ORDERS')
    const pay = uniqueName('PAY')
    const ship = uniqueName('SHIP')
    for (const s of [orders, pay, ship]) await jsm.streams.add({ name: s, subjects: [`${s}.>`] })
    // A consumer on the payments stream, to see badges.
    await jsm.consumers.add(pay, { durable_name: 'billing', ack_policy: 'explicit' as never })

    const hdr = (value: string) => {
      const hd = headers()
      hd.set('trace-id', value)
      return { headers: hd }
    }
    // Noise with another id, then the request: header hops in orders and payments, and a hop in
    // shipping that has no header but carries the id in its JSON payload.
    await js.publish(`${orders}.new`, '{}', hdr('other-' + tag))
    await js.publish(`${orders}.new`, JSON.stringify({ order: { id: tag } }), hdr(tag))
    await sleep(40)
    await js.publish(`${pay}.charge`, '{"amount":10}', hdr(tag))
    await sleep(40)
    await js.publish(`${pay}.noise`, '{"amount":99}', hdr('other-' + tag))
    await js.publish(`${ship}.pack`, JSON.stringify({ ref: { order: tag }, sku: 'A' }))

    // The renderer's own fan-out (runTrace), over the real service.
    const gateway = {
      open: (channel, args, on) => h.service.open(channel, args, on),
      listStreams: (connId) => h.service.listStreams(connId)
    } as TraceGateway
    const run = async (query: TraceQuery, names = [orders, pay, ship]) => {
      const result = await runTrace(gateway, id, { ...query, streams: names })
      return result.messages.map((m) => ({ stream: m.stream, m }))
    }
    const window = { kind: 'last', ms: 10 * MINUTE } as const

    const byHeader = await run({ rules: [headerRule('trace-id', tag)], window })
    expect(byHeader.map((f) => [f.stream, f.m.subject])).toEqual([
      [orders, `${orders}.new`],
      [pay, `${pay}.charge`]
    ])

    const byJson = await run({ rules: [{ kind: 'json', path: '$.ref.order', value: tag }], window })
    expect(byJson.map((f) => f.stream)).toEqual([ship])

    // All rules together are one trace, in the order the messages were stored.
    const both = await run({
      rules: [
        headerRule('trace-id', tag),
        { kind: 'json', path: '$.ref.order', value: tag },
        { kind: 'json', path: '$.order.id', value: tag }
      ],
      window
    })
    expect(both.map((f) => f.stream)).toEqual([orders, pay, ship])

    // Text anywhere finds the same request by its id in the payloads.
    const text = await run({ rules: [{ kind: 'text', value: tag }], window })
    expect(text.map((f) => f.stream)).toEqual([orders, ship])

    // The consumer of the payments stream has not received the charge yet.
    const consumers = await h.service.listConsumers(id, pay)
    const charge = both.find((f) => f.stream === pay)!.m
    expect(consumers.map((c) => messageConsumerStatus(charge, c).state)).toEqual(['not-delivered'])

    // A window that ended before the messages finds nothing.
    const old = await run({
      rules: [headerRule('trace-id', tag)],
      window: {
        kind: 'range',
        from: new Date(Date.now() - 3 * 60 * MINUTE).toISOString(),
        to: new Date(Date.now() - 2 * 60 * MINUTE).toISOString()
      }
    })
    expect(old).toEqual([])

    // A stream that does not exist fails alone: its scan ends with an error.
    expect((await scan('NO_SUCH_STREAM', {})).done.reason).toBe('error')

    for (const s of [orders, pay, ship]) await jsm.streams.delete(s)
  })
})
