import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { StreamConfigDto } from '@shared/api'
import { startNatsServer, type TestServer } from '../helpers/natsServer'
import { createHarness, gatewayErr, uniqueName, waitFor, type Harness } from '../helpers/studio'

let h: Harness
let id: string
beforeAll(async () => {
  h = await createHarness()
  id = await h.connect({ name: 'streams' })
})
afterAll(async () => {
  await h.dispose()
})

describe('PBI-030 streams list', () => {
  it('returns the columns the list shows', async () => {
    const { jsm, js } = await h.client()
    const name = uniqueName('LIST')
    await jsm.streams.add({
      name,
      subjects: [`${name}.a`, `${name}.b.>`],
      storage: 'memory' as never,
      retention: 'interest' as never,
      max_msgs: 100
    })
    await jsm.consumers.add(name, { durable_name: 'c1' })
    await js.publish(`${name}.a`, 'one')
    await js.publish(`${name}.b.x`, 'two!')

    const row = (await h.service.listStreams(id)).find((s) => s.config.name === name)!
    expect(row.config).toMatchObject({
      subjects: [`${name}.a`, `${name}.b.>`],
      storage: 'memory',
      retention: 'interest',
      num_replicas: 1
    })
    expect(row.state).toMatchObject({
      messages: 2,
      bytes: expect.any(Number),
      consumer_count: 1,
      first_seq: 1,
      last_seq: 2
    })
    expect(row.state.bytes).toBeGreaterThan(0)
    expect(new Date(row.state.last_ts).getTime()).toBeGreaterThan(Date.now() - 60_000)
    expect(new Date(row.created).getTime()).toBeGreaterThan(Date.now() - 60_000)
    await jsm.streams.delete(name)
  })

  it('includes the streams behind KV and Object Store buckets so the UI can hide them', async () => {
    await h.service.createKvBucket(id, { bucket: 'list_kv' })
    await h.service.createObjBucket(id, { bucket: 'list_obj' })
    const names = (await h.service.listStreams(id)).map((s) => s.config.name)
    expect(names).toContain('KV_list_kv')
    expect(names).toContain('OBJ_list_obj')
    await h.service.deleteKvBucket(id, 'list_kv')
    await h.service.deleteObjBucket(id, 'list_obj')
  })
})

describe('PBI-030 a large account', () => {
  let server: TestServer
  let big: string
  const COUNT = 5000

  beforeAll(async () => {
    server = await startNatsServer('')
    const saved = await h.service.saveConnection({
      name: 'big',
      servers: [server.url],
      auth: 'none'
    })
    big = saved.id
    await h.service.connect(big)
    const { connect } = await import('@nats-io/transport-node')
    const { jetstreamManager } = await import('@nats-io/jetstream')
    const nc = await connect({ servers: server.url })
    const jsm = await jetstreamManager(nc)
    let next = 0
    await Promise.all(
      Array.from({ length: 32 }, async () => {
        while (next < COUNT) {
          const n = next++
          await jsm.streams.add({
            name: `S${String(n).padStart(5, '0')}`,
            subjects: [`big.${n}.>`],
            storage: 'memory' as never
          })
        }
      })
    )
    await nc.close()
  }, 120_000)

  afterAll(async () => {
    if (big) await h.service.deleteConnection(big)
    await server?.stop()
  })

  it('lists 5,000 streams in one call', async () => {
    const started = Date.now()
    const streams = await h.service.listStreams(big)
    const elapsed = Date.now() - started
    expect(streams).toHaveLength(COUNT)
    expect(new Set(streams.map((s) => s.config.name)).size).toBe(COUNT)
    expect(elapsed).toBeLessThan(10_000)
    const index = await h.service.searchIndex(big)
    expect(index.streams).toHaveLength(COUNT)
  }, 60_000)
})

describe('PBI-031 stream detail', () => {
  it('reports state including deleted messages', async () => {
    const { jsm, js } = await h.client()
    const name = uniqueName('DETAIL')
    await jsm.streams.add({ name, subjects: [`${name}.>`], description: 'detail test' })
    for (let i = 0; i < 5; i++) await js.publish(`${name}.k`, `m${i}`)
    await jsm.streams.deleteMessage(name, 3)

    const info = await h.service.streamInfo(id, name)
    expect(info.config.description).toBe('detail test')
    expect(info.state).toMatchObject({
      messages: 4,
      first_seq: 1,
      last_seq: 5,
      num_deleted: 1,
      consumer_count: 0
    })
    expect(new Date(info.state.first_ts).getTime()).toBeLessThanOrEqual(
      new Date(info.state.last_ts).getTime()
    )
    await jsm.streams.delete(name)
  })

  it('shows mirror and source lag', async () => {
    const { jsm, js } = await h.client()
    const origin = uniqueName('ORIGIN')
    const mirror = uniqueName('MIRROR')
    const agg = uniqueName('AGG')
    await jsm.streams.add({ name: origin, subjects: [`${origin}.>`] })
    for (let i = 0; i < 3; i++) await js.publish(`${origin}.x`, 'm')
    await jsm.streams.add({ name: mirror, mirror: { name: origin } })
    await jsm.streams.add({ name: agg, sources: [{ name: origin }] })

    await waitFor(
      async () => (await h.service.streamInfo(id, mirror)).state.messages === 3,
      10_000,
      'mirror to catch up'
    )
    const m = await h.service.streamInfo(id, mirror)
    expect(m.mirror).toMatchObject({ name: origin, lag: 0 })
    expect(m.config.mirror?.name).toBe(origin)

    await waitFor(
      async () => (await h.service.streamInfo(id, agg)).state.messages === 3,
      10_000,
      'source to catch up'
    )
    const a = await h.service.streamInfo(id, agg)
    expect(a.sources).toHaveLength(1)
    expect(a.sources![0]).toMatchObject({ name: origin, lag: 0 })
    for (const s of [mirror, agg, origin]) await jsm.streams.delete(s)
  })

  it('reports a missing stream as not found with the NATS error code', async () => {
    const err = await gatewayErr(h.service.streamInfo(id, 'NOPE_NOT_HERE'))
    expect(err.kind).toBe('not_found')
    expect(err.natsCode).toBe(10059)
    expect(err.message).toMatch(/stream not found \(JetStream error 10059\)/)
  })
})

describe('PBI-032 create and edit a stream', () => {
  it('creates a stream with every field the form covers', async () => {
    const name = uniqueName('FULL')
    const config: StreamConfigDto = {
      name,
      description: 'made by the studio',
      subjects: [`${name}.orders.*`, `${name}.events.>`],
      storage: 'file',
      retention: 'limits',
      num_replicas: 1,
      max_msgs: 1000,
      max_bytes: 10 * 1024 * 1024,
      max_age: 3600e9,
      max_msg_size: 64 * 1024,
      max_msgs_per_subject: 50,
      discard: 'new',
      duplicate_window: 120e9,
      compression: 's2',
      allow_direct: true,
      allow_rollup_hdrs: true,
      deny_delete: true,
      deny_purge: false
    }
    const created = await h.service.createStream(id, config)
    expect(created.config).toMatchObject(config)

    const { jsm } = await h.client()
    expect((await jsm.streams.info(name)).config).toMatchObject({
      max_msgs: 1000,
      discard: 'new',
      compression: 's2',
      deny_delete: true,
      max_age: 3600e9
    })
    await jsm.streams.delete(name)
  })

  it('edits the fields the server allows and keeps the rest', async () => {
    const name = uniqueName('EDIT')
    const created = await h.service.createStream(id, {
      name,
      subjects: [`${name}.a`],
      max_msgs: 10
    })
    const updated = await h.service.updateStream(id, name, {
      ...created.config,
      subjects: [`${name}.a`, `${name}.b`],
      max_msgs: 20,
      max_age: 600e9,
      description: 'edited'
    })
    expect(updated.config).toMatchObject({
      subjects: [`${name}.a`, `${name}.b`],
      max_msgs: 20,
      max_age: 600e9,
      description: 'edited',
      storage: 'file'
    })

    // The server checks combinations too: the duplicate window cannot outlast max age.
    const err = await gatewayErr(
      h.service.updateStream(id, name, { ...updated.config, max_age: 60e9 })
    )
    expect(err.natsCode).toBe(10052)
    await h.service.deleteStream(id, name)
  })

  it('surfaces server validation errors with the NATS error code', async () => {
    const name = uniqueName('BAD')
    const created = await h.service.createStream(id, {
      name,
      subjects: [`${name}.a`],
      storage: 'file'
    })

    // Storage type cannot be changed after creation.
    const storage = await gatewayErr(
      h.service.updateStream(id, name, { ...created.config, storage: 'memory' })
    )
    expect(storage.kind).toBe('jetstream')
    expect(storage.natsCode).toBeGreaterThan(10000)
    expect(storage.message).toMatch(/storage/i)

    // Two streams cannot listen on overlapping subjects.
    const overlap = await gatewayErr(
      h.service.createStream(id, { name: uniqueName('OVERLAP'), subjects: [`${name}.>`] })
    )
    expect(overlap.natsCode).toBe(10065)
    expect(overlap.message).toMatch(/overlap/i)

    const noName = await gatewayErr(h.service.createStream(id, { name: ' ', subjects: ['x'] }))
    expect(noName.kind).toBe('validation')
    await h.service.deleteStream(id, name)
  })
})

describe('PBI-033 purge and delete a stream', () => {
  async function seeded(): Promise<string> {
    const { jsm, js } = await h.client()
    const name = uniqueName('PURGE')
    await jsm.streams.add({ name, subjects: [`${name}.>`] })
    for (let i = 0; i < 10; i++)
      await js.publish(`${name}.${i % 2 === 0 ? 'even' : 'odd'}`, `m${i}`)
    return name
  }

  it('purges everything and reports the count', async () => {
    const name = await seeded()
    expect(await h.service.purgeStream(id, name, {})).toEqual({ purged: 10 })
    expect((await h.service.streamInfo(id, name)).state.messages).toBe(0)
    await h.service.deleteStream(id, name)
  })

  it('purges by subject filter', async () => {
    const name = await seeded()
    expect(await h.service.purgeStream(id, name, { filter: `${name}.odd` })).toEqual({ purged: 5 })
    const page = await h.service.getMessages(id, name, {
      direction: 'asc',
      start: { kind: 'first' },
      limit: 50
    })
    expect(page.messages.map((m) => m.subject)).toEqual(Array(5).fill(`${name}.even`))
    await h.service.deleteStream(id, name)
  })

  it('purges up to a sequence, not including it', async () => {
    const name = await seeded()
    expect(await h.service.purgeStream(id, name, { seq: 7 })).toEqual({ purged: 6 })
    expect((await h.service.streamInfo(id, name)).state).toMatchObject({
      messages: 4,
      first_seq: 7
    })
    await h.service.deleteStream(id, name)
  })

  it('keeps the last N messages', async () => {
    const name = await seeded()
    expect(await h.service.purgeStream(id, name, { keep: 3 })).toEqual({ purged: 7 })
    expect((await h.service.streamInfo(id, name)).state).toMatchObject({
      messages: 3,
      first_seq: 8,
      last_seq: 10
    })
    await h.service.deleteStream(id, name)
  })

  it('combines a subject filter with keep', async () => {
    const name = await seeded()
    expect(await h.service.purgeStream(id, name, { filter: `${name}.even`, keep: 1 })).toEqual({
      purged: 4
    })
    expect((await h.service.streamInfo(id, name)).state.messages).toBe(6)
    await h.service.deleteStream(id, name)
  })

  it('rejects contradictory options and invalid filters', async () => {
    const name = await seeded()
    expect((await gatewayErr(h.service.purgeStream(id, name, { seq: 3, keep: 2 }))).kind).toBe(
      'validation'
    )
    expect((await gatewayErr(h.service.purgeStream(id, name, { filter: 'a..b' }))).kind).toBe(
      'validation'
    )
    expect((await h.service.streamInfo(id, name)).state.messages).toBe(10)
    await h.service.deleteStream(id, name)
  })

  it('refuses to purge a stream that denies it', async () => {
    const name = uniqueName('NOPURGE')
    await h.service.createStream(id, { name, subjects: [`${name}.>`], deny_purge: true })
    const err = await gatewayErr(h.service.purgeStream(id, name, {}))
    expect(err.kind).toBe('jetstream')
    expect(err.message).toMatch(/purge/i)
    await h.service.deleteStream(id, name)
  })

  it('deletes a stream', async () => {
    const name = await seeded()
    await h.service.deleteStream(id, name)
    expect((await gatewayErr(h.service.streamInfo(id, name))).kind).toBe('not_found')
  })
})

describe('PBI-034 per-subject message counts', () => {
  let name: string
  beforeAll(async () => {
    const { jsm, js } = await h.client()
    name = uniqueName('SUBJ')
    await jsm.streams.add({ name, subjects: [`${name}.>`] })
    const plan: [string, number][] = [
      ['orders.eu.created', 5],
      ['orders.eu.shipped', 2],
      ['orders.us.created', 9],
      ['events.login', 1]
    ]
    for (const [subject, count] of plan)
      for (let i = 0; i < count; i++) await js.publish(`${name}.${subject}`, 'x')
  })
  afterAll(async () => {
    await h.service.deleteStream(id, name)
  })

  it('lists subjects with counts, largest first', async () => {
    const page = await h.service.streamSubjects(id, name, {})
    expect(page.total).toBe(4)
    expect(page.subjects).toEqual([
      { subject: `${name}.orders.us.created`, count: 9 },
      { subject: `${name}.orders.eu.created`, count: 5 },
      { subject: `${name}.orders.eu.shipped`, count: 2 },
      { subject: `${name}.events.login`, count: 1 }
    ])
  })

  it('filters with a NATS wildcard and sorts by name', async () => {
    const page = await h.service.streamSubjects(id, name, {
      filter: `${name}.orders.*.created`,
      sort: 'subject'
    })
    expect(page.subjects.map((s) => s.subject)).toEqual([
      `${name}.orders.eu.created`,
      `${name}.orders.us.created`
    ])
    expect((await h.service.streamSubjects(id, name, { filter: `${name}.nothing.>` })).total).toBe(
      0
    )
    expect(
      (await gatewayErr(h.service.streamSubjects(id, name, { filter: 'bad..filter' }))).kind
    ).toBe('validation')
  })

  it('pages through the list', async () => {
    const first = await h.service.streamSubjects(id, name, { limit: 3, sort: 'subject' })
    const second = await h.service.streamSubjects(id, name, {
      limit: 3,
      offset: 3,
      sort: 'subject'
    })
    expect(first.subjects).toHaveLength(3)
    expect(second.subjects).toHaveLength(1)
    expect(second.offset).toBe(3)
    expect([...first.subjects, ...second.subjects].map((s) => s.subject)).toEqual([
      `${name}.events.login`,
      `${name}.orders.eu.created`,
      `${name}.orders.eu.shipped`,
      `${name}.orders.us.created`
    ])
  })

  it('handles a stream with more than 100,000 subjects', async () => {
    const { nc, jsm } = await h.client()
    const many = uniqueName('MANY')
    await jsm.streams.add({
      name: many,
      subjects: [`${many}.>`],
      storage: 'memory' as never,
      no_ack: true
    })
    const TOTAL = 120_000
    for (let i = 0; i < TOTAL; i++) {
      nc.publish(`${many}.k.${i}`, '')
      if (i % 5000 === 0) await nc.flush()
    }
    await nc.flush()
    await waitFor(
      async () => (await jsm.streams.info(many)).state.messages === TOTAL,
      30_000,
      'all subjects stored'
    )

    const page = await h.service.streamSubjects(id, many, {
      limit: 500,
      offset: 110_000,
      sort: 'subject'
    })
    expect(page.total).toBe(TOTAL)
    expect(page.subjects).toHaveLength(500)
    expect(page.subjects.every((s) => s.count === 1)).toBe(true)
    const filtered = await h.service.streamSubjects(id, many, { filter: `${many}.k.99999` })
    expect(filtered.subjects).toEqual([{ subject: `${many}.k.99999`, count: 1 }])
    await jsm.streams.delete(many)
  }, 90_000)
})

describe('PBI-035 export and import stream configuration', () => {
  it('produces configuration that recreates the stream elsewhere', async () => {
    const name = uniqueName('EXPORT')
    const created = await h.service.createStream(id, {
      name,
      subjects: [`${name}.>`],
      max_msgs: 500,
      max_age: 7200e9,
      discard: 'new',
      duplicate_window: 60e9,
      description: 'exported'
    })
    // What the UI saves to a file and what "nats stream add --config" reads: the config object as JSON.
    const exported = JSON.parse(JSON.stringify(created.config)) as StreamConfigDto
    const copy = uniqueName('IMPORT')
    const imported = await h.service.createStream(id, {
      ...exported,
      name: copy,
      subjects: [`${copy}.>`]
    })
    const { name: _n1, subjects: _s1, ...a } = created.config
    const { name: _n2, subjects: _s2, ...b } = imported.config
    expect(b).toEqual(a)
    await h.service.deleteStream(id, name)
    await h.service.deleteStream(id, copy)
  })
})
