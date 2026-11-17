import { headers } from '@nats-io/transport-node'
import type { JetStreamManager, StoredMsg } from '@nats-io/jetstream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MessageReader, pickReadMode, type ReadMode } from '@core/messageReader'
import type { MessageDto, ScanEvent, ScanRequest } from '@shared/api'
import { fromBase64, utf8Decode } from '@shared/encoding'
import { collect, createHarness, gatewayErr, uniqueName, type Harness } from '../helpers/studio'

let h: Harness
let id: string
let jsm: JetStreamManager
beforeAll(async () => {
  h = await createHarness()
  id = await h.connect({ name: 'messages' })
  jsm = (await h.client()).jsm
})
afterAll(async () => {
  await h.dispose()
})

const text = (m: MessageDto): string => utf8Decode(fromBase64(m.payload))
const seqs = (list: { seq: number }[]): number[] => list.map((m) => m.seq)
async function all<T>(gen: AsyncGenerator<T>, max = Infinity): Promise<T[]> {
  const out: T[] = []
  for await (const item of gen) {
    out.push(item)
    if (out.length >= max) break
  }
  return out
}

/**
 * 400 messages: subject .a on odd sequences, .b on even ones, and a rare .rare on every 100th.
 * Then holes are punched in it so readers have to cope with deleted messages.
 */
async function seedGappy(
  allowDirect: boolean
): Promise<{ name: string; alive: number[]; subjectOf: (seq: number) => string }> {
  const { nc } = await h.client()
  const name = uniqueName('GAPPY')
  await jsm.streams.add({ name, subjects: [`${name}.>`], allow_direct: allowDirect })
  const subjectOf = (seq: number): string =>
    seq % 100 === 0 ? `${name}.rare` : seq % 2 === 1 ? `${name}.a` : `${name}.b`
  const js = (await h.client()).js
  const acks: Promise<unknown>[] = []
  for (let seq = 1; seq <= 400; seq++) acks.push(js.publish(subjectOf(seq), `msg-${seq}`))
  await Promise.all(acks)
  await nc.flush()
  const dead = new Set<number>([1, 2, 3, 150, 400])
  for (let s = 40; s <= 60; s++) dead.add(s)
  for (let s = 200; s <= 320; s++) dead.add(s)
  for (const s of dead) await jsm.streams.deleteMessage(name, s, false)
  const alive: number[] = []
  for (let s = 1; s <= 400; s++) if (!dead.has(s)) alive.push(s)
  return { name, alive, subjectOf }
}

describe('PBI-040 reading without a consumer', () => {
  it('picks the fastest read mode the stream and server support', () => {
    expect(pickReadMode(false, '2.15.3')).toBe('api')
    expect(pickReadMode(undefined, '2.15.3')).toBe('api')
    expect(pickReadMode(true, '2.10.22')).toBe('direct')
    expect(pickReadMode(true, '2.11.0')).toBe('batch')
  })

  const modes: [ReadMode, boolean][] = [
    ['api', false],
    ['direct', true],
    ['batch', true]
  ]
  describe.each(modes)('in %s mode', (mode, allowDirect) => {
    let name: string
    let alive: number[]
    let subjectOf: (seq: number) => string
    let reader: MessageReader

    beforeAll(async () => {
      ;({ name, alive, subjectOf } = await seedGappy(allowDirect))
      reader = new MessageReader(jsm, name, mode)
    })
    afterAll(async () => {
      await jsm.streams.delete(name)
    })

    it('walks forward over deleted messages without errors or empty rows', async () => {
      const msgs = await all(reader.forward(1, undefined, undefined))
      expect(seqs(msgs)).toEqual(alive)
      expect(msgs.every((m: StoredMsg) => m.string() === `msg-${m.seq}`)).toBe(true)
      expect(msgs.every((m: StoredMsg) => m.subject === subjectOf(m.seq))).toBe(true)
    })

    it('finds the next message at or after a sequence', async () => {
      expect((await reader.next(1))!.seq).toBe(4)
      expect((await reader.next(45))!.seq).toBe(61)
      expect((await reader.next(200))!.seq).toBe(321)
      expect((await reader.next(399))!.seq).toBe(399)
      expect(await reader.next(400)).toBeNull()
      expect((await reader.next(5, `${name}.rare`))!.seq).toBe(100)
    })

    it('filters by subject on the server, wildcards included', async () => {
      const a = await all(reader.forward(1, undefined, `${name}.a`))
      expect(seqs(a)).toEqual(alive.filter((s) => subjectOf(s) === `${name}.a`))
      const rare = await all(reader.forward(1, undefined, `${name}.rare`))
      expect(seqs(rare)).toEqual([100])
      const wild = await all(reader.forward(1, undefined, `${name}.*`))
      expect(seqs(wild)).toEqual(alive)
      expect(await all(reader.forward(1, undefined, `${name}.nothing`))).toEqual([])
    })

    it('stops at an upper bound', async () => {
      expect(seqs(await all(reader.forward(30, 65, undefined)))).toEqual(
        alive.filter((s) => s >= 30 && s < 65)
      )
      expect(await all(reader.forward(200, 321, undefined))).toEqual([])
    })

    it('walks backward, newest first, across gaps', async () => {
      const msgs = await all(reader.backward(401, 1, undefined))
      expect(seqs(msgs)).toEqual([...alive].reverse())
      const firstTen = await all(reader.backward(401, 1, undefined, 10), 10)
      expect(seqs(firstTen)).toEqual([...alive].reverse().slice(0, 10))
    })

    it('walks backward with a subject filter, sparse or dense', async () => {
      const b = await all(reader.backward(401, 1, `${name}.b`))
      expect(seqs(b)).toEqual(alive.filter((s) => subjectOf(s) === `${name}.b`).reverse())
      const rare = await all(reader.backward(401, 1, `${name}.rare`))
      expect(seqs(rare)).toEqual([100])
      const fromMiddle = await all(reader.backward(120, 1, `${name}.a`, 5), 5)
      expect(seqs(fromMiddle)).toEqual([119, 117, 115, 113, 111])
    })
  })

  it('walks backward through a stream much larger than one window', async () => {
    const { nc } = await h.client()
    const name = uniqueName('LONG')
    await jsm.streams.add({
      name,
      subjects: [`${name}.>`],
      storage: 'memory' as never,
      allow_direct: true,
      no_ack: true
    })
    const TOTAL = 3000
    for (let i = 1; i <= TOTAL; i++)
      nc.publish(i % 500 === 0 ? `${name}.rare` : `${name}.common`, String(i))
    await nc.flush()
    while ((await jsm.streams.info(name)).state.messages < TOTAL)
      await new Promise((r) => setTimeout(r, 20))

    for (const mode of ['api', 'batch'] as const) {
      const reader = new MessageReader(jsm, name, mode)
      // A rare subject: windows must grow instead of crawling 64 sequences at a time.
      expect(seqs(await all(reader.backward(TOTAL + 1, 1, `${name}.rare`)))).toEqual([
        3000, 2500, 2000, 1500, 1000, 500
      ])
      // A dense subject after sparse windows: narrowing must not drop or repeat messages.
      const dense = await all(reader.backward(TOTAL + 1, 1, `${name}.common`))
      expect(dense).toHaveLength(TOTAL - 6)
      for (let i = 1; i < dense.length; i++) expect(dense[i].seq).toBeLessThan(dense[i - 1].seq)
    }
    await jsm.streams.delete(name)
  }, 60_000)
})

describe('PBI-040 browse stream messages', () => {
  let name: string
  beforeAll(async () => {
    const { js } = await h.client()
    name = uniqueName('BROWSE')
    await jsm.streams.add({ name, subjects: [`${name}.>`] })
    for (let i = 1; i <= 120; i++) {
      const hdrs = headers()
      hdrs.set('Trace-Id', `t-${i}`)
      if (i % 2 === 0) hdrs.append('X-Multi', 'one')
      if (i % 2 === 0) hdrs.append('X-Multi', 'two')
      await js.publish(
        `${name}.${i % 3 === 0 ? 'c' : 'ab'}`,
        JSON.stringify({ n: i, note: `message ${i}` }),
        { headers: hdrs }
      )
    }
  })
  afterAll(async () => {
    await jsm.streams.delete(name)
  })

  it('returns sequence, subject, timestamp, size, headers and a payload preview', async () => {
    const page = await h.service.getMessages(id, name, {
      direction: 'asc',
      start: { kind: 'first' },
      limit: 50
    })
    expect(page.messages).toHaveLength(50)
    expect(seqs(page.messages)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1))
    expect(page).toMatchObject({ exhausted: false, startSeq: 1, firstSeq: 1, lastSeq: 120 })
    const m = page.messages[1]
    expect(m).toMatchObject({ seq: 2, subject: `${name}.ab`, truncated: false })
    expect(JSON.parse(text(m))).toEqual({ n: 2, note: 'message 2' })
    expect(m.size).toBe(text(m).length)
    expect(m.headers).toEqual([
      ['Trace-Id', 't-2'],
      ['X-Multi', 'one'],
      ['X-Multi', 'two']
    ])
    expect(Math.abs(new Date(m.time).getTime() - Date.now())).toBeLessThan(120_000)
  })

  it('pages forwards and backwards, oldest first or newest first', async () => {
    const p1 = await h.service.getMessages(id, name, {
      direction: 'asc',
      start: { kind: 'first' },
      limit: 50
    })
    const p2 = await h.service.getMessages(id, name, {
      direction: 'asc',
      start: { kind: 'seq', seq: p1.messages.at(-1)!.seq + 1 },
      limit: 50
    })
    const p3 = await h.service.getMessages(id, name, {
      direction: 'asc',
      start: { kind: 'seq', seq: p2.messages.at(-1)!.seq + 1 },
      limit: 50
    })
    expect(seqs(p2.messages)).toEqual(Array.from({ length: 50 }, (_, i) => i + 51))
    expect(seqs(p3.messages)).toEqual(Array.from({ length: 20 }, (_, i) => i + 101))
    expect([p1.exhausted, p2.exhausted, p3.exhausted]).toEqual([false, false, true])

    // Newest first, then one page older, then back to the newer page.
    const newest = await h.service.getMessages(id, name, {
      direction: 'desc',
      start: { kind: 'last' },
      limit: 50
    })
    expect(seqs(newest.messages)).toEqual(Array.from({ length: 50 }, (_, i) => 120 - i))
    const older = await h.service.getMessages(id, name, {
      direction: 'desc',
      start: { kind: 'seq', seq: newest.messages.at(-1)!.seq - 1 },
      limit: 50
    })
    expect(seqs(older.messages)).toEqual(Array.from({ length: 50 }, (_, i) => 70 - i))
    const back = await h.service.getMessages(id, name, {
      direction: 'asc',
      start: { kind: 'seq', seq: older.messages[0].seq + 1 },
      limit: 50
    })
    expect(seqs(back.messages)).toEqual(seqs(newest.messages).reverse())
  })

  it('truncates large payloads in the list but reports the full size', async () => {
    const { js } = await h.client()
    const big = uniqueName('BIG')
    await jsm.streams.add({ name: big, subjects: [`${big}.>`] })
    await js.publish(`${big}.x`, 'A'.repeat(100_000))
    const page = await h.service.getMessages(id, big, {
      direction: 'asc',
      start: { kind: 'first' },
      limit: 10
    })
    expect(page.messages[0]).toMatchObject({ size: 100_000, truncated: true })
    expect(fromBase64(page.messages[0].payload).length).toBe(2048)

    const full = await h.service.getMessage(id, big, 1)
    expect(full).toMatchObject({ size: 100_000, truncated: false })
    expect(fromBase64(full.payload).length).toBe(100_000)
    await jsm.streams.delete(big)
  })

  it('creates no consumer and acknowledges nothing', async () => {
    const before = await jsm.streams.info(name)
    await h.service.getMessages(id, name, {
      direction: 'asc',
      start: { kind: 'first' },
      limit: 100
    })
    await h.service.getMessages(id, name, {
      direction: 'desc',
      start: { kind: 'last' },
      limit: 100,
      subject: `${name}.c`
    })
    const after = await jsm.streams.info(name)
    expect(after.state.consumer_count).toBe(0)
    expect(after.state.messages).toBe(before.state.messages)
    expect(after.state.first_seq).toBe(before.state.first_seq)
  })

  it('loads a page of 50 in well under a second on a local server', async () => {
    const started = performance.now()
    const page = await h.service.getMessages(id, name, {
      direction: 'desc',
      start: { kind: 'last' },
      limit: 50
    })
    const elapsed = performance.now() - started
    expect(page.messages).toHaveLength(50)
    expect(elapsed).toBeLessThan(1000)
  })

  it('returns an empty page for an empty stream', async () => {
    const empty = uniqueName('EMPTY')
    await jsm.streams.add({ name: empty, subjects: [`${empty}.>`] })
    const page = await h.service.getMessages(id, empty, {
      direction: 'desc',
      start: { kind: 'last' },
      limit: 50
    })
    expect(page).toMatchObject({ messages: [], exhausted: true })
    await jsm.streams.delete(empty)
  })
})

describe('PBI-043 headers are exactly what was stored', () => {
  it('returns the same headers whichever way the message is read', async () => {
    const { js } = await h.client()
    const plain = uniqueName('HDRAPI')
    const direct = uniqueName('HDRDIRECT')
    await jsm.streams.add({ name: plain, subjects: [`${plain}.>`], allow_direct: false })
    await jsm.streams.add({ name: direct, subjects: [`${direct}.>`], allow_direct: true })

    for (const name of [plain, direct]) {
      const withHeaders = headers()
      withHeaders.set('Trace-Id', 'abc')
      // A message that was republished from elsewhere really does carry these headers.
      withHeaders.set('Nats-Stream', 'ORIGIN')
      withHeaders.set('Nats-Sequence', '77')
      await js.publish(`${name}.x`, 'with headers', { headers: withHeaders })
      await js.publish(`${name}.x`, 'without headers')
    }

    const expected = [
      [
        ['Trace-Id', 'abc'],
        ['Nats-Stream', 'ORIGIN'],
        ['Nats-Sequence', '77']
      ],
      []
    ]
    for (const name of [plain, direct]) {
      const page = await h.service.getMessages(id, name, {
        direction: 'asc',
        start: { kind: 'first' },
        limit: 10
      })
      expect(
        page.messages.map((m) => m.headers),
        name
      ).toEqual(expected)
      expect((await h.service.getMessage(id, name, 1)).headers, name).toEqual(expected[0])
      expect((await h.service.getMessage(id, name, 2)).headers, name).toEqual([])
    }

    // A header filter must not match the headers the server adds to its direct-get replies.
    const { events, close } = await collect(
      h.service,
      'scan',
      {
        connId: id,
        stream: direct,
        request: {
          direction: 'asc',
          start: { kind: 'first' },
          limit: 10,
          scanLimit: 100,
          filters: { headers: [{ key: 'Nats-Time-Stamp' }] }
        }
      },
      (e) => e.some((x) => x.type === 'done')
    )
    close()
    expect(events.flatMap((e) => (e.type === 'matches' ? e.messages : []))).toEqual([])
    const stored = await collect(
      h.service,
      'scan',
      {
        connId: id,
        stream: direct,
        request: {
          direction: 'asc',
          start: { kind: 'first' },
          limit: 10,
          scanLimit: 100,
          filters: { headers: [{ key: 'Nats-Stream', value: 'ORIGIN' }] }
        }
      },
      (e) => e.some((x) => x.type === 'done')
    )
    stored.close()
    expect(seqs(stored.events.flatMap((e) => (e.type === 'matches' ? e.messages : [])))).toEqual([
      1
    ])
    await jsm.streams.delete(plain)
    await jsm.streams.delete(direct)
  })
})

describe('PBI-040 WorkQueue and Interest streams', () => {
  it('browses a WorkQueue stream without consuming it, even with a consumer bound', async () => {
    const { js } = await h.client()
    const name = uniqueName('WQ')
    await jsm.streams.add({ name, subjects: [`${name}.>`], retention: 'workqueue' as never })
    await jsm.consumers.add(name, { durable_name: 'worker', ack_policy: 'explicit' as never })
    for (let i = 0; i < 20; i++) await js.publish(`${name}.job`, `job-${i}`)

    const page = await h.service.getMessages(id, name, {
      direction: 'asc',
      start: { kind: 'first' },
      limit: 50
    })
    expect(page.messages).toHaveLength(20)
    const desc = await h.service.getMessages(id, name, {
      direction: 'desc',
      start: { kind: 'last' },
      limit: 5
    })
    expect(seqs(desc.messages)).toEqual([20, 19, 18, 17, 16])

    const info = await jsm.streams.info(name)
    expect(info.state.messages).toBe(20)
    expect(info.state.consumer_count).toBe(1)
    const worker = await jsm.consumers.info(name, 'worker')
    expect(worker.num_pending).toBe(20)
    expect(worker.num_ack_pending).toBe(0)
    expect(worker.delivered.stream_seq).toBe(0)

    // The worker can still take every job afterwards.
    const consumer = await js.consumers.get(name, 'worker')
    const batch = await consumer.fetch({ max_messages: 20, expires: 2000 })
    let got = 0
    for await (const m of batch) {
      m.ack()
      got++
    }
    expect(got).toBe(20)
    await jsm.streams.delete(name)
  })

  it('browses an Interest stream without registering interest', async () => {
    const { js } = await h.client()
    const name = uniqueName('INT')
    await jsm.streams.add({ name, subjects: [`${name}.>`], retention: 'interest' as never })
    await jsm.consumers.add(name, { durable_name: 'listener', ack_policy: 'explicit' as never })
    for (let i = 0; i < 10; i++) await js.publish(`${name}.e`, `e-${i}`)

    const page = await h.service.getMessages(id, name, {
      direction: 'asc',
      start: { kind: 'first' },
      limit: 50
    })
    expect(page.messages).toHaveLength(10)
    const info = await jsm.streams.info(name)
    expect(info.state).toMatchObject({ messages: 10, consumer_count: 1 })
    expect((await jsm.consumers.info(name, 'listener')).num_pending).toBe(10)
    await jsm.streams.delete(name)
  })
})

describe('PBI-041 choose the start position', () => {
  let name: string
  let cut: Date
  beforeAll(async () => {
    const { js } = await h.client()
    name = uniqueName('START')
    await jsm.streams.add({ name, subjects: [`${name}.>`] })
    for (let i = 1; i <= 30; i++) await js.publish(`${name}.x`, `early-${i}`)
    await new Promise((r) => setTimeout(r, 60))
    cut = new Date()
    await new Promise((r) => setTimeout(r, 60))
    for (let i = 31; i <= 60; i++) await js.publish(`${name}.x`, `late-${i}`)
    await jsm.streams.purge(name, { seq: 6 })
  })
  afterAll(async () => {
    await jsm.streams.delete(name)
  })

  it('starts from the first message', async () => {
    const page = await h.service.getMessages(id, name, {
      direction: 'asc',
      start: { kind: 'first' },
      limit: 3
    })
    expect(seqs(page.messages)).toEqual([6, 7, 8])
    expect(page.startSeq).toBe(6)
  })

  it('shows the last N', async () => {
    const page = await h.service.getMessages(id, name, {
      direction: 'desc',
      start: { kind: 'last' },
      limit: 4
    })
    expect(seqs(page.messages)).toEqual([60, 59, 58, 57])
  })

  it('starts from a sequence', async () => {
    const page = await h.service.getMessages(id, name, {
      direction: 'asc',
      start: { kind: 'seq', seq: 42 },
      limit: 2
    })
    expect(seqs(page.messages)).toEqual([42, 43])
    expect(page.notice).toBeUndefined()
  })

  it('moves an out-of-range sequence to the nearest valid one and says so', async () => {
    const low = await h.service.getMessages(id, name, {
      direction: 'asc',
      start: { kind: 'seq', seq: 2 },
      limit: 2
    })
    expect(seqs(low.messages)).toEqual([6, 7])
    expect(low.notice).toMatch(/Sequence 2 is before the first message\. Showing from 6/)
    const high = await h.service.getMessages(id, name, {
      direction: 'desc',
      start: { kind: 'seq', seq: 9999 },
      limit: 2
    })
    expect(seqs(high.messages)).toEqual([60, 59])
    expect(high.notice).toMatch(/Sequence 9999 is after the last message\. Showing from 60/)
  })

  it('starts from a date and time', async () => {
    const page = await h.service.getMessages(id, name, {
      direction: 'asc',
      start: { kind: 'time', time: cut.toISOString() },
      limit: 3
    })
    expect(seqs(page.messages)).toEqual([31, 32, 33])
    expect(page.startSeq).toBe(31)
    expect(text(page.messages[0])).toBe('late-31')

    const older = await h.service.getMessages(id, name, {
      direction: 'desc',
      start: { kind: 'time', time: cut.toISOString() },
      limit: 2
    })
    expect(seqs(older.messages)).toEqual([31, 30])

    const early = await h.service.getMessages(id, name, {
      direction: 'asc',
      start: { kind: 'time', time: '2001-01-01T00:00:00Z' },
      limit: 1
    })
    expect(seqs(early.messages)).toEqual([6])
    const future = await h.service.getMessages(id, name, {
      direction: 'asc',
      start: { kind: 'time', time: new Date(Date.now() + 3600_000).toISOString() },
      limit: 5
    })
    expect(seqs(future.messages)).toEqual([60])
    expect(future.notice).toMatch(/No messages at or after that time/)
  })

  it('rejects an invalid date', async () => {
    expect(
      (
        await gatewayErr(
          h.service.getMessages(id, name, {
            direction: 'asc',
            start: { kind: 'time', time: 'yesterday-ish' },
            limit: 1
          })
        )
      ).kind
    ).toBe('validation')
  })
})

describe('PBI-042 and PBI-048 filters', () => {
  let name: string
  beforeAll(async () => {
    const { js } = await h.client()
    name = uniqueName('FILTER')
    await jsm.streams.add({ name, subjects: [`${name}.>`], allow_direct: true })
    for (let i = 1; i <= 300; i++) {
      const hdrs = headers()
      hdrs.set('Region', i % 2 === 0 ? 'eu' : 'us')
      if (i % 10 === 0) hdrs.set('Trace-Id', `trace-${i}`)
      const subject = `${name}.orders.${i % 2 === 0 ? 'eu' : 'us'}.${i % 5 === 0 ? 'shipped' : 'created'}`
      const body =
        i % 25 === 0
          ? `plain text line ${i} URGENT`
          : JSON.stringify({
              order: { id: `A-${i}`, total: i },
              tags: i % 50 === 0 ? ['urgent'] : []
            })
      await js.publish(subject, body, { headers: hdrs })
    }
  })
  afterAll(async () => {
    await jsm.streams.delete(name)
  })

  const scan = async (
    request: Partial<ScanRequest>,
    until?: (e: ScanEvent[]) => boolean
  ): Promise<{
    matches: MessageDto[]
    done: Extract<ScanEvent, { type: 'done' }>
    events: ScanEvent[]
  }> => {
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
      { connId: id, stream: name, request: full },
      until ?? ((e) => e.some((x) => x.type === 'done'))
    )
    close()
    const matches = events.flatMap((e) => (e.type === 'matches' ? e.messages : []))
    const done = events.find((e) => e.type === 'done') as Extract<ScanEvent, { type: 'done' }>
    return { matches, done, events }
  }

  it('filters by subject with wildcards on the server', async () => {
    const page = await h.service.getMessages(id, name, {
      direction: 'asc',
      start: { kind: 'first' },
      limit: 1000,
      subject: `${name}.orders.*.shipped`
    })
    expect(page.messages).toHaveLength(60)
    expect(page.messages.every((m) => m.subject.endsWith('.shipped'))).toBe(true)
    const eu = await h.service.getMessages(id, name, {
      direction: 'desc',
      start: { kind: 'last' },
      limit: 1000,
      subject: `${name}.orders.eu.>`
    })
    expect(eu.messages).toHaveLength(150)
    expect(
      (
        await gatewayErr(
          h.service.getMessages(id, name, {
            direction: 'asc',
            start: { kind: 'first' },
            limit: 5,
            subject: 'a..b'
          })
        )
      ).kind
    ).toBe('validation')
  })

  it('filters by header key and by header value', async () => {
    const hasTrace = await scan({ filters: { headers: [{ key: 'trace-id' }] } })
    expect(seqs(hasTrace.matches)).toEqual(Array.from({ length: 30 }, (_, i) => (i + 1) * 10))
    const eu = await scan({ filters: { headers: [{ key: 'Region', value: 'eu' }] } })
    expect(eu.matches).toHaveLength(150)
    const none = await scan({ filters: { headers: [{ key: 'Region', value: 'mars' }] } })
    expect(none.matches).toEqual([])
    expect(none.done).toMatchObject({ reason: 'end', scanned: 300, matched: 0 })
  })

  it('filters by payload text, ignoring case', async () => {
    const urgent = await scan({ filters: { payloadContains: 'urgent' } })
    expect(seqs(urgent.matches)).toEqual([25, 50, 75, 100, 125, 150, 175, 200, 225, 250, 275, 300])
  })

  it('combines filters with AND, including the server-side subject filter', async () => {
    const result = await scan({
      subject: `${name}.orders.eu.>`,
      filters: { headers: [{ key: 'Trace-Id' }], payloadContains: 'URGENT' }
    })
    expect(seqs(result.matches)).toEqual([50, 100, 150, 200, 250, 300])
    // Only the 150 messages on the subject were examined; the server skipped the rest.
    expect(result.done.scanned).toBe(150)
  })

  it('filters by regular expression', async () => {
    const result = await scan({ filters: { payloadRegex: '"id":"A-1[0-9]"' } })
    expect(seqs(result.matches)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
  })

  it('filters by JSONPath and counts payloads that are not JSON', async () => {
    const result = await scan({ filters: { jsonPath: '$.order.total > 290' } })
    expect(seqs(result.matches)).toEqual([291, 292, 293, 294, 295, 296, 297, 298, 299])
    expect(result.done.skippedNonJson).toBe(12)
    const tagged = await scan({ filters: { jsonPath: '$.tags contains "urgent"' } })
    expect(tagged.matches).toEqual([])
    expect(tagged.done.skippedNonJson).toBe(12)
    const byId = await scan({ filters: { jsonPath: '$.order.id == "A-7"' } })
    expect(seqs(byId.matches)).toEqual([7])
  })

  it('applies a list of conditions: two includes AND together, an exclude rejects what it matches (PBI-126)', async () => {
    const both = await scan({
      filters: {
        conditions: [
          { kind: 'header', key: 'Trace-Id' },
          { kind: 'contains', expr: 'URGENT' }
        ]
      }
    })
    expect(seqs(both.matches)).toEqual([50, 100, 150, 200, 250, 300])

    const notEu = await scan({
      filters: { conditions: [{ kind: 'header', key: 'Region', value: 'eu', exclude: true }] }
    })
    expect(notEu.matches).toHaveLength(150)
    expect(
      notEu.matches.every((m) => !m.headers.some(([k, v]) => k === 'Region' && v === 'eu'))
    ).toBe(true)

    const mixed = await scan({
      filters: {
        conditions: [
          { kind: 'jsonPath', expr: '$.order.total > 290' },
          { kind: 'jsonPath', expr: '$.order.id == "A-295"', exclude: true }
        ]
      }
    })
    expect(seqs(mixed.matches)).toEqual([291, 292, 293, 294, 296, 297, 298, 299])

    // An exclude JSONPath does not reject a payload that is not JSON, and does not count it as
    // skipped; the same path as an include skips it (and counts it).
    const excluded = await scan({
      filters: { conditions: [{ kind: 'jsonPath', expr: '$.order.total > 0', exclude: true }] }
    })
    expect(excluded.matches).toHaveLength(12)
    expect(excluded.done.skippedNonJson).toBe(0)

    // The older single fields give the same answer as the equivalent conditions.
    const old = await scan({
      filters: { headers: [{ key: 'Trace-Id' }], payloadContains: 'URGENT' }
    })
    expect(seqs(old.matches)).toEqual(seqs(both.matches))
  })

  it('rejects an invalid expression before scanning anything', async () => {
    const regex = await scan({ filters: { payloadRegex: '(' } })
    expect(regex.done).toMatchObject({ reason: 'error', scanned: 0 })
    expect(regex.done.error?.kind).toBe('validation')
    const path = await scan({ filters: { jsonPath: 'order.total > 1' } })
    expect(path.done.error?.message).toMatch(/must start with \$/)
  })

  it('reports progress while scanning', async () => {
    const result = await scan({ filters: { payloadContains: 'no-such-text' } })
    const progress = result.events.filter((e) => e.type === 'progress') as Extract<
      ScanEvent,
      { type: 'progress' }
    >[]
    expect(progress.length).toBeGreaterThan(0)
    expect(progress.at(-1)).toMatchObject({ scanned: 300, matched: 0 })
  })

  it('stops when the page is full and can continue from there', async () => {
    const first = await scan({ limit: 5, filters: { headers: [{ key: 'Trace-Id' }] } })
    expect(seqs(first.matches)).toEqual([10, 20, 30, 40, 50])
    expect(first.done).toMatchObject({ reason: 'page', matched: 5, scanned: 50, resumeSeq: 51 })
    const second = await scan({
      limit: 5,
      start: { kind: 'seq', seq: first.done.resumeSeq! },
      filters: { headers: [{ key: 'Trace-Id' }] }
    })
    expect(seqs(second.matches)).toEqual([60, 70, 80, 90, 100])
  })

  it('stops at the scan limit and says so, which is different from "no matches"', async () => {
    const limited = await scan({ scanLimit: 100, filters: { payloadContains: 'no-such-text' } })
    expect(limited.done).toMatchObject({
      reason: 'limit',
      scanned: 100,
      matched: 0,
      resumeSeq: 101
    })
    const rest = await scan({
      start: { kind: 'seq', seq: limited.done.resumeSeq! },
      filters: { payloadContains: 'no-such-text' }
    })
    expect(rest.done).toMatchObject({ reason: 'end', scanned: 200, matched: 0, resumeSeq: null })
  })

  it('scans newest first', async () => {
    const result = await scan({
      direction: 'desc',
      start: { kind: 'last' },
      limit: 3,
      filters: { payloadContains: 'URGENT' }
    })
    expect(seqs(result.matches)).toEqual([300, 275, 250])
    expect(result.done).toMatchObject({ reason: 'page', resumeSeq: 249 })
  })

  it('can be cancelled', async () => {
    const full: ScanRequest = {
      direction: 'asc',
      start: { kind: 'first' },
      limit: 1000,
      scanLimit: 10_000,
      filters: { payloadContains: 'no-such-text' }
    }
    const events: ScanEvent[] = []
    const close = h.service.open('scan', { connId: id, stream: name, request: full }, (e) =>
      events.push(e)
    )
    close()
    await new Promise((r) => setTimeout(r, 300))
    // Nothing is delivered after cancelling, and the scan stopped early.
    expect(events.filter((e) => e.type === 'done')).toEqual([])
    expect(events.filter((e) => e.type === 'matches')).toEqual([])
  })
})

describe('PBI-043 message detail', () => {
  it('loads one message in full, and large ones on demand', async () => {
    const { js } = await h.client()
    const name = uniqueName('DETAILMSG')
    await jsm.streams.add({ name, subjects: [`${name}.>`], max_msg_size: -1 })
    const hdrs = headers()
    hdrs.set('Content-Type', 'application/octet-stream')
    const binary = new Uint8Array(900_000).map((_, i) => i % 251)
    await js.publish(`${name}.bin`, binary, { headers: hdrs })

    const msg = await h.service.getMessage(id, name, 1)
    expect(msg).toMatchObject({
      seq: 1,
      subject: `${name}.bin`,
      size: 900_000,
      truncated: false,
      headers: [['Content-Type', 'application/octet-stream']]
    })
    expect(Array.from(fromBase64(msg.payload).subarray(0, 5))).toEqual([0, 1, 2, 3, 4])

    const partial = await h.service.getMessage(id, name, 1, 1000)
    expect(partial).toMatchObject({ size: 900_000, truncated: true })
    expect(fromBase64(partial.payload).length).toBe(1000)
    await jsm.streams.delete(name)
  })

  it('reports a message that no longer exists', async () => {
    const { js } = await h.client()
    const name = uniqueName('GONE')
    await jsm.streams.add({ name, subjects: [`${name}.>`] })
    await js.publish(`${name}.x`, 'a')
    await js.publish(`${name}.x`, 'b')
    await jsm.streams.deleteMessage(name, 1)
    const err = await gatewayErr(h.service.getMessage(id, name, 1))
    expect(err.kind).toBe('not_found')
    expect(err.message).toMatch(/Message 1 is no longer in the stream|no message found/)
    await jsm.streams.delete(name)
  })
})

describe('PBI-046 delete a single message', () => {
  it('deletes with or without secure erase', async () => {
    const { js } = await h.client()
    const name = uniqueName('DEL')
    await jsm.streams.add({ name, subjects: [`${name}.>`] })
    for (let i = 1; i <= 4; i++) await js.publish(`${name}.x`, `m${i}`)
    await h.service.deleteMessage(id, name, 2, true)
    await h.service.deleteMessage(id, name, 3, false)
    const page = await h.service.getMessages(id, name, {
      direction: 'asc',
      start: { kind: 'first' },
      limit: 10
    })
    expect(seqs(page.messages)).toEqual([1, 4])
    expect((await jsm.streams.info(name)).state.num_deleted).toBe(2)
    const again = await gatewayErr(h.service.deleteMessage(id, name, 2, true))
    expect(`${again.kind}: ${again.message}`).toMatch(/^not_found: Message 2 is not in the stream/)
    await jsm.streams.delete(name)
  })

  it('is refused by a stream that denies deletes', async () => {
    const { js } = await h.client()
    const name = uniqueName('NODEL')
    await jsm.streams.add({ name, subjects: [`${name}.>`], deny_delete: true })
    await js.publish(`${name}.x`, 'keep me')
    const err = await gatewayErr(h.service.deleteMessage(id, name, 1, true))
    expect(err.kind).toBe('jetstream')
    expect(err.message).toMatch(/delete/i)
    expect((await jsm.streams.info(name)).state.messages).toBe(1)
    await jsm.streams.delete(name)
  })
})
