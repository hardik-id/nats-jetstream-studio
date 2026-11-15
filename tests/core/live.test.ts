import { headers, type NatsConnection } from '@nats-io/transport-node'
import type { JetStreamManager } from '@nats-io/jetstream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GatewayError, type TailEvent, type TailMessage } from '@shared/api'
import { fromBase64, textToBase64, utf8Decode } from '@shared/encoding'
import { collect, createHarness, uniqueName, waitFor, type Harness } from '../helpers/studio'

let h: Harness
let id: string
let nc: NatsConnection
let jsm: JetStreamManager
beforeAll(async () => {
  h = await createHarness()
  id = await h.connect({ name: 'live' })
  ;({ nc, jsm } = await h.client())
})
afterAll(async () => {
  await h.dispose()
})

async function gatewayErr(promise: Promise<unknown>): Promise<GatewayError> {
  const err = await promise.then(
    () => undefined,
    (e) => e
  )
  expect(err).toBeInstanceOf(GatewayError)
  return err as GatewayError
}
const messagesOf = (events: TailEvent[]): TailMessage[] =>
  events.flatMap((e) => (e.type === 'messages' ? e.messages : []))

describe('PBI-060 live tail', () => {
  it('delivers messages on a wildcard subject with headers, size and payload', async () => {
    const prefix = uniqueName('tail')
    const tail = collect(
      h.service,
      'tail',
      { connId: id, subject: `${prefix}.>` },
      (e) => messagesOf(e).length >= 3
    )
    await new Promise((r) => setTimeout(r, 100))
    const hdrs = headers()
    hdrs.set('Trace-Id', 'abc')
    nc.publish(`${prefix}.one`, 'first')
    nc.publish(`${prefix}.two.deep`, JSON.stringify({ a: 1 }), { headers: hdrs })
    nc.publish(`${prefix}.three`, new Uint8Array([0, 255, 7]), { reply: 'reply.here' })
    nc.publish(`other.${prefix}`, 'not delivered')
    const { events, close } = await tail
    close()

    const msgs = messagesOf(events)
    expect(msgs.map((m) => m.subject)).toEqual([
      `${prefix}.one`,
      `${prefix}.two.deep`,
      `${prefix}.three`
    ])
    expect(utf8Decode(fromBase64(msgs[0].payload))).toBe('first')
    expect(msgs[0]).toMatchObject({ size: 5, truncated: false, headers: [] })
    expect(msgs[1].headers).toEqual([['Trace-Id', 'abc']])
    expect(Array.from(fromBase64(msgs[2].payload))).toEqual([0, 255, 7])
    expect(msgs[2].reply).toBe('reply.here')
    expect(msgs.map((m) => m.id)).toEqual([1, 2, 3])
    expect(Math.abs(msgs[0].received - Date.now())).toBeLessThan(5000)
  })

  it('stops delivering once closed', async () => {
    const subject = uniqueName('stop')
    const events: TailEvent[] = []
    const close = h.service.open('tail', { connId: id, subject }, (e) => events.push(e))
    await new Promise((r) => setTimeout(r, 100))
    nc.publish(subject, 'a')
    await waitFor(() => messagesOf(events).length === 1, 3000, 'first message')
    close()
    nc.publish(subject, 'b')
    await nc.flush()
    await new Promise((r) => setTimeout(r, 300))
    expect(messagesOf(events)).toHaveLength(1)
  })

  it('runs several tails side by side', async () => {
    const a = uniqueName('a')
    const b = uniqueName('b')
    const tailA = collect(
      h.service,
      'tail',
      { connId: id, subject: a },
      (e) => messagesOf(e).length >= 1
    )
    const tailB = collect(
      h.service,
      'tail',
      { connId: id, subject: b },
      (e) => messagesOf(e).length >= 1
    )
    await new Promise((r) => setTimeout(r, 100))
    nc.publish(a, 'for a')
    nc.publish(b, 'for b')
    const [ra, rb] = await Promise.all([tailA, tailB])
    ra.close()
    rb.close()
    expect(messagesOf(ra.events).map((m) => m.subject)).toEqual([a])
    expect(messagesOf(rb.events).map((m) => m.subject)).toEqual([b])
  })

  it('keeps up with 5,000 messages per second in batches', async () => {
    const subject = uniqueName('fast')
    const TOTAL = 20_000
    let received = 0
    let dropped = 0
    let batches = 0
    const close = h.service.open('tail', { connId: id, subject }, (e) => {
      if (e.type === 'messages') {
        received += e.messages.length
        dropped += e.dropped
        batches++
      }
    })
    await new Promise((r) => setTimeout(r, 100))
    const started = Date.now()
    // 5,000 per second for four seconds.
    for (let sent = 0; sent < TOTAL;) {
      for (let i = 0; i < 500; i++, sent++) nc.publish(subject, `{"n":${sent}}`)
      await nc.flush()
      await new Promise((r) => setTimeout(r, 100))
    }
    await waitFor(() => received + dropped >= TOTAL, 10_000, 'all messages accounted for')
    close()
    const seconds = (Date.now() - started) / 1000
    expect(received).toBe(TOTAL)
    expect(dropped).toBe(0)
    // Events are batched: far fewer UI updates than messages.
    expect(batches).toBeLessThan(seconds * 12)
  }, 30_000)

  it('drops the oldest messages of a burst it cannot deliver and reports how many', async () => {
    const subject = uniqueName('burst')
    let received = 0
    let dropped = 0
    const ids: number[] = []
    const close = h.service.open('tail', { connId: id, subject }, (e) => {
      if (e.type === 'messages') {
        received += e.messages.length
        dropped += e.dropped
        ids.push(...e.messages.map((m) => m.id))
      }
    })
    await new Promise((r) => setTimeout(r, 100))
    for (let i = 0; i < 30_000; i++) nc.publish(subject, 'x')
    await nc.flush()
    await waitFor(() => received + dropped >= 30_000, 10_000, 'burst accounted for')
    close()
    expect(received + dropped).toBe(30_000)
    // Whatever was kept is still in order.
    for (let i = 1; i < ids.length; i++) expect(ids[i]).toBeGreaterThan(ids[i - 1])
  }, 30_000)

  it('truncates large payloads but reports their size', async () => {
    const subject = uniqueName('large')
    const tail = collect(
      h.service,
      'tail',
      { connId: id, subject, payloadBytes: 100 },
      (e) => messagesOf(e).length >= 1
    )
    await new Promise((r) => setTimeout(r, 100))
    nc.publish(subject, 'z'.repeat(5000))
    const { events, close } = await tail
    close()
    expect(messagesOf(events)[0]).toMatchObject({ size: 5000, truncated: true })
    expect(fromBase64(messagesOf(events)[0].payload).length).toBe(100)
  })

  it('rejects an invalid subject', async () => {
    const { events, close } = await collect(
      h.service,
      'tail',
      { connId: id, subject: 'bad..subject' },
      (e) => e.length >= 1
    )
    close()
    expect(events[0]).toMatchObject({ type: 'error', error: { kind: 'validation' } })
  })

  it('names the subject when the user may not subscribe to it', async () => {
    const limited = await h.connect({ name: 'limited', user: 'limited', password: 'limited' })
    const { events, close } = await collect(
      h.service,
      'tail',
      { connId: limited, subject: 'secret.>' },
      (e) => e.some((x) => x.type === 'error')
    )
    close()
    const error = events.find((e) => e.type === 'error') as Extract<TailEvent, { type: 'error' }>
    expect(error.error.kind).toBe('permission')
    expect(error.error.subject).toBe('secret.>')
    expect(error.error.message).toMatch(/may not subscribe to "secret\.>"/)

    // A subject the user is allowed to read still works.
    const ok = collect(
      h.service,
      'tail',
      { connId: limited, subject: 'orders.>' },
      (e) => messagesOf(e).length >= 1
    )
    await new Promise((r) => setTimeout(r, 100))
    nc.publish('orders.eu.created', 'allowed')
    const result = await ok
    result.close()
    expect(messagesOf(result.events)[0].subject).toBe('orders.eu.created')
    await h.service.deleteConnection(limited)
  })
})

describe('PBI-062 publish and request', () => {
  it('publishes a core message with headers and payload', async () => {
    const subject = uniqueName('pub')
    const sub = nc.subscribe(subject, { max: 1 })
    await nc.flush()
    const result = await h.service.publish(id, {
      subject,
      mode: 'core',
      payload: textToBase64('{"hello":"wörld"}'),
      headers: [
        ['Content-Type', 'application/json'],
        ['X-Multi', 'a'],
        ['X-Multi', 'b'],
        ['  ', 'ignored: blank key']
      ]
    })
    expect(result).toEqual({})
    for await (const m of sub) {
      expect(m.string()).toBe('{"hello":"wörld"}')
      expect(m.headers!.get('Content-Type')).toBe('application/json')
      expect(m.headers!.values('X-Multi')).toEqual(['a', 'b'])
      expect(m.headers!.keys()).toHaveLength(2)
    }
  })

  it('publishes to JetStream and shows the acknowledgement', async () => {
    const name = uniqueName('PUBJS')
    await jsm.streams.add({ name, subjects: [`${name}.>`] })
    const first = await h.service.publish(id, {
      subject: `${name}.a`,
      mode: 'jetstream',
      payload: textToBase64('one'),
      headers: [['Nats-Msg-Id', 'dedupe-1']]
    })
    expect(first.ack).toEqual({ stream: name, seq: 1, duplicate: false })
    const again = await h.service.publish(id, {
      subject: `${name}.a`,
      mode: 'jetstream',
      payload: textToBase64('one'),
      headers: [['Nats-Msg-Id', 'dedupe-1']]
    })
    expect(again.ack).toEqual({ stream: name, seq: 1, duplicate: true })
    const second = await h.service.publish(id, {
      subject: `${name}.b`,
      mode: 'jetstream',
      payload: ''
    })
    expect(second.ack).toMatchObject({ seq: 2, duplicate: false })
    await jsm.streams.delete(name)
  })

  it('says when no stream captures a JetStream publish', async () => {
    const err = await gatewayErr(
      h.service.publish(id, { subject: uniqueName('nostream'), mode: 'jetstream', payload: '' })
    )
    expect(err.kind).toBe('no_responders')
    expect(err.message).toMatch(/No stream is listening/)
  })

  it('rejects wildcards and invalid subjects', async () => {
    expect(
      (await gatewayErr(h.service.publish(id, { subject: 'a.*', mode: 'core', payload: '' }))).kind
    ).toBe('validation')
    expect(
      (await gatewayErr(h.service.publish(id, { subject: 'a..b', mode: 'core', payload: '' }))).kind
    ).toBe('validation')
    expect(
      (await gatewayErr(h.service.request(id, { subject: 'a.>', payload: '', timeoutMs: 100 })))
        .kind
    ).toBe('validation')
  })

  it('names the subject when the user may not publish to it', async () => {
    const limited = await h.connect({ name: 'limited-pub', user: 'limited', password: 'limited' })
    const err = await gatewayErr(
      h.service.publish(limited, { subject: 'forbidden.subject', mode: 'core', payload: '' })
    )
    expect(err.kind).toBe('permission')
    expect(err.subject).toBe('forbidden.subject')
    expect(err.message).toMatch(/may not publish to "forbidden\.subject"/)
    expect(
      await h.service.publish(limited, { subject: 'orders.ok', mode: 'core', payload: '' })
    ).toEqual({})
    await h.service.deleteConnection(limited)
  })

  it('sends a request and shows the reply with its round-trip time', async () => {
    const subject = uniqueName('svc')
    const sub = nc.subscribe(subject, {
      callback: (_err, msg) => {
        const hdrs = headers()
        hdrs.set('X-Served-By', 'test')
        msg.respond(`echo:${msg.string()}:${msg.headers?.get('X-Ask') ?? ''}`, { headers: hdrs })
      }
    })
    await nc.flush()
    const reply = await h.service.request(id, {
      subject,
      payload: textToBase64('ping'),
      headers: [['X-Ask', 'please']],
      timeoutMs: 2000
    })
    expect(utf8Decode(fromBase64(reply.payload))).toBe('echo:ping:please')
    expect(reply.headers).toEqual([['X-Served-By', 'test']])
    expect(reply.size).toBe('echo:ping:please'.length)
    expect(reply.rttMs).toBeGreaterThan(0)
    expect(reply.rttMs).toBeLessThan(2000)
    sub.unsubscribe()
  })

  it('reports "no responders" as such', async () => {
    const subject = uniqueName('nobody')
    const err = await gatewayErr(h.service.request(id, { subject, payload: '', timeoutMs: 2000 }))
    expect(err.kind).toBe('no_responders')
    expect(err.message).toBe(`No responders: nothing is listening on "${subject}"`)
  })

  it('honours the timeout when a service does not answer', async () => {
    const subject = uniqueName('slow')
    const sub = nc.subscribe(subject, { callback: () => {} })
    await nc.flush()
    const started = Date.now()
    const err = await gatewayErr(h.service.request(id, { subject, payload: '', timeoutMs: 300 }))
    expect(err.kind).toBe('timeout')
    expect(err.message).toBe('No reply within 300 ms')
    expect(Date.now() - started).toBeLessThan(1500)
    sub.unsubscribe()
  })
})
