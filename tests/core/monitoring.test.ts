import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { JetStreamClient, JetStreamManager } from '@nats-io/jetstream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AuditLog } from '@core/audit'
import { KeyFileSecretStore } from '@core/secrets'
import { StudioService } from '@core/service'
import type { AlertEvent, AlertRule, GlobalEvent } from '@shared/api'
import { textToBase64 } from '@shared/encoding'
import { startNatsServer } from '../helpers/natsServer'
import { createHarness, gatewayErr, uniqueName, waitFor, type Harness } from '../helpers/studio'

let h: Harness
let id: string
let jsm: JetStreamManager
let js: JetStreamClient
const INTERVAL = 200

beforeAll(async () => {
  h = await createHarness({ sampler: { intervalMs: INTERVAL, retentionMs: 60_000 } })
  id = await h.connect({ name: 'monitoring' })
  ;({ jsm, js } = await h.client())
})
afterAll(async () => {
  await h.dispose()
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('PBI-080 time-series metrics', () => {
  it('samples stream totals and message rate while connected', async () => {
    const name = uniqueName('METRIC')
    await jsm.streams.add({ name, subjects: [`${name}.>`] })
    await sleep(INTERVAL * 2)
    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < 20; i++) await js.publish(`${name}.x`, 'payload')
      await sleep(INTERVAL)
    }
    await sleep(INTERVAL * 2)

    const m = await h.service.metrics(id, { kind: 'stream', stream: name }, 60_000)
    expect(m.intervalMs).toBe(INTERVAL)
    expect(m.t.length).toBeGreaterThanOrEqual(5)
    expect(Object.keys(m.series).sort()).toEqual(['bytes', 'messages', 'rate'])
    for (const col of Object.values(m.series)) expect(col).toHaveLength(m.t.length)
    for (let i = 1; i < m.t.length; i++) {
      expect(m.t[i]).toBeGreaterThan(m.t[i - 1])
      expect(m.series.messages[i]).toBeGreaterThanOrEqual(m.series.messages[i - 1])
    }
    expect(m.series.messages.at(-1)).toBe(100)
    expect(m.series.bytes.at(-1)).toBeGreaterThan(0)
    // 100 messages over roughly one second: the peak rate is well above zero and it settles back to zero.
    expect(Math.max(...m.series.rate)).toBeGreaterThan(20)
    expect(m.series.rate.at(-1)).toBe(0)

    // A shorter range returns only the newest samples.
    const recent = await h.service.metrics(id, { kind: 'stream', stream: name }, INTERVAL * 2.5)
    expect(recent.t.length).toBeLessThan(m.t.length)
    expect(recent.t.at(-1)).toBe(m.t.at(-1))
    await jsm.streams.delete(name)
  })

  it('samples consumer pending, ack pending and redelivered', async () => {
    const name = uniqueName('CMETRIC')
    await jsm.streams.add({ name, subjects: [`${name}.>`] })
    await jsm.consumers.add(name, { durable_name: 'c', ack_policy: 'explicit' as never })
    for (let i = 0; i < 10; i++) await js.publish(`${name}.x`, 'm')
    await sleep(INTERVAL * 3)
    const consumer = await js.consumers.get(name, 'c')
    const batch = await consumer.fetch({ max_messages: 4, expires: 1000 })
    for await (const _ of batch) void 0
    await sleep(INTERVAL * 3)

    const m = await h.service.metrics(id, { kind: 'consumer', stream: name, consumer: 'c' }, 60_000)
    expect(Object.keys(m.series).sort()).toEqual(['ackPending', 'pending', 'redelivered'])
    expect(m.series.pending).toContain(10)
    expect(m.series.pending.at(-1)).toBe(6)
    expect(m.series.ackPending.at(-1)).toBe(4)
    expect(m.series.redelivered.at(-1)).toBe(0)
    await jsm.streams.delete(name)
  })

  it('returns an empty series for something that was never sampled', async () => {
    const m = await h.service.metrics(id, { kind: 'stream', stream: 'NEVER_EXISTED' }, 60_000)
    expect(m).toEqual({
      t: [],
      series: { messages: [], bytes: [], rate: [] },
      intervalMs: INTERVAL
    })
  })

  it('forgets a deleted stream', async () => {
    const name = uniqueName('FORGET')
    await jsm.streams.add({ name, subjects: [`${name}.>`] })
    await waitFor(
      async () =>
        (await h.service.metrics(id, { kind: 'stream', stream: name }, 60_000)).t.length > 0,
      5000,
      'first sample'
    )
    await jsm.streams.delete(name)
    await waitFor(
      async () =>
        (await h.service.metrics(id, { kind: 'stream', stream: name }, 60_000)).t.length === 0,
      5000,
      'series to be dropped'
    )
  })

  it('keeps only the configured amount of history', async () => {
    const short = await createHarness({ sampler: { intervalMs: 100, retentionMs: 500 } })
    try {
      const conn = await short.connect()
      const name = uniqueName('RETAIN')
      await jsm.streams.add({ name, subjects: [`${name}.>`] })
      await sleep(1500)
      const m = await short.service.metrics(conn, { kind: 'stream', stream: name }, 60_000)
      expect(m.t.length).toBeLessThanOrEqual(5)
      expect(m.t.length).toBeGreaterThanOrEqual(3)
      await jsm.streams.delete(name)
    } finally {
      await short.dispose()
    }
  })

  it('stops sampling while the connection is down and resumes afterwards', async () => {
    const server = await startNatsServer('')
    const saved = await h.service.saveConnection({
      name: 'sampler-down',
      servers: [server.url],
      auth: 'none'
    })
    try {
      await h.service.connect(saved.id)
      await h.service.createStream(saved.id, { name: 'DOWN', subjects: ['down.>'] })
      const count = async (): Promise<number> =>
        (await h.service.metrics(saved.id, { kind: 'stream', stream: 'DOWN' }, 60_000)).t.length
      await waitFor(async () => (await count()) >= 2, 5000, 'samples before the outage')

      await server.kill()
      await waitFor(
        async () =>
          (await h.service.listConnections()).find((c) => c.id === saved.id)!.state.status ===
          'reconnecting',
        5000,
        'reconnecting'
      )
      // While down, asking for metrics says so rather than returning stale numbers as if live.
      expect(
        (await gatewayErr(h.service.metrics(saved.id, { kind: 'stream', stream: 'DOWN' }, 60_000)))
          .kind
      ).toBe('not_connected')

      // Stay down for a while. With a quick restart the outage can fit between two samples and
      // would not show as a gap at all.
      await sleep(INTERVAL * 6)
      await server.restart()
      await waitFor(
        async () =>
          (await h.service.listConnections()).find((c) => c.id === saved.id)!.state.status ===
          'connected',
        15_000,
        'reconnected'
      )
      const afterOutage = await count()
      await waitFor(async () => (await count()) > afterOutage, 5000, 'sampling to resume')

      // The outage is visible as a gap between samples, not filled with invented points.
      const m = await h.service.metrics(saved.id, { kind: 'stream', stream: 'DOWN' }, 60_000)
      const gaps = m.t.slice(1).map((t, i) => t - m.t[i])
      expect(Math.max(...gaps)).toBeGreaterThan(INTERVAL * 4)

      await h.service.disconnect(saved.id)
      expect(
        (await gatewayErr(h.service.metrics(saved.id, { kind: 'stream', stream: 'DOWN' }, 60_000)))
          .kind
      ).toBe('not_connected')
    } finally {
      await h.service.deleteConnection(saved.id)
      await server.stop()
    }
  }, 40_000)
})

describe('PBI-054 lag that keeps growing', () => {
  it('flags the consumer and counts it in the summary', async () => {
    const name = uniqueName('LAG')
    await jsm.streams.add({ name, subjects: [`${name}.>`] })
    await jsm.consumers.add(name, { durable_name: 'behind', ack_policy: 'explicit' as never })
    await jsm.consumers.add(name, {
      durable_name: 'idle',
      ack_policy: 'explicit' as never,
      filter_subject: `${name}.never`
    })
    await h.service.setSetting(`conn:${id}:health`, { lagSamples: 3, stalledSeconds: 3600 })

    // Publish steadily so every sample sees more pending than the one before.
    let publishing = true
    const publisher = (async () => {
      while (publishing) {
        await js.publish(`${name}.x`, 'm')
        await sleep(20)
      }
    })()
    try {
      await waitFor(
        async () =>
          (await h.service.consumerInfo(id, name, 'behind')).health?.includes('lag_growing') ??
          false,
        10_000,
        'lag_growing flag'
      )
      const list = await h.service.listConsumers(id, name)
      expect(list.find((c) => c.name === 'behind')!.health).toEqual(['lag_growing'])
      expect(list.find((c) => c.name === 'idle')!.health).toEqual([])

      const summary = await h.service.healthSummary(id)
      const item = summary.items.find((i) => i.stream === name && i.consumer === 'behind')
      expect(item?.flags).toEqual(['lag_growing'])
      expect(summary.items.some((i) => i.stream === name && i.consumer === 'idle')).toBe(false)
      expect(summary.unhealthy).toBe(summary.items.length)
      expect(summary.total).toBeGreaterThanOrEqual(2)
    } finally {
      publishing = false
      await publisher
    }
    // Once publishing stops, pending stops growing and the flag clears.
    await waitFor(
      async () =>
        !(await h.service.consumerInfo(id, name, 'behind')).health?.includes('lag_growing'),
      10_000,
      'flag to clear'
    )
    await h.service.setSetting(`conn:${id}:health`, null)
    await jsm.streams.delete(name)
  }, 40_000)
})

describe('PBI-081 alerts', () => {
  const alerts: AlertEvent[] = []
  let closeEvents: () => void
  beforeAll(() => {
    closeEvents = h.service.open('events', {}, (e: GlobalEvent) => {
      if (e.type === 'alert') alerts.push(e.alert)
    })
  })
  afterAll(() => closeEvents())

  const rule = (over: Partial<AlertRule>): AlertRule => ({
    id: '',
    connId: id,
    name: 'rule',
    metric: 'consumer_pending',
    stream: '*',
    consumer: '*',
    threshold: 5,
    durationSeconds: 0,
    enabled: true,
    notify: true,
    ...over
  })

  it('fires once when a consumer crosses the threshold, and again only after it clears', async () => {
    const name = uniqueName('ALERT')
    await jsm.streams.add({ name, subjects: [`${name}.>`] })
    await jsm.consumers.add(name, { durable_name: 'c', ack_policy: 'explicit' as never })
    const saved = await h.service.saveAlertRule(rule({ name: 'pending high', stream: name }))
    expect(saved.id).toBeTruthy()
    expect(await h.service.listAlertRules(id)).toEqual([saved])
    const mine = (): AlertEvent[] => alerts.filter((a) => a.ruleId === saved.id)

    for (let i = 0; i < 5; i++) await js.publish(`${name}.x`, 'm')
    await sleep(INTERVAL * 3)
    expect(mine()).toEqual([])

    for (let i = 0; i < 5; i++) await js.publish(`${name}.x`, 'm')
    await waitFor(() => mine().length === 1, 5000, 'alert')
    expect(mine()[0]).toMatchObject({
      ruleName: 'pending high',
      connId: id,
      metric: 'consumer_pending',
      target: `${name} > c`,
      value: 10,
      threshold: 5,
      notify: true
    })
    await sleep(INTERVAL * 4)
    expect(mine()).toHaveLength(1)

    // Drain the consumer so the condition clears, then cross the threshold again.
    const consumer = await js.consumers.get(name, 'c')
    const batch = await consumer.fetch({ max_messages: 10, expires: 1000 })
    for await (const m of batch) m.ack()
    await sleep(INTERVAL * 3)
    for (let i = 0; i < 8; i++) await js.publish(`${name}.x`, 'm')
    await waitFor(() => mine().length === 2, 5000, 'second alert')
    expect(mine()[1].value).toBe(8)

    expect((await h.service.alertHistory()).filter((a) => a.ruleId === saved.id)).toHaveLength(2)
    await h.service.deleteAlertRule(id, saved.id)
    expect(await h.service.listAlertRules(id)).toEqual([])
    await jsm.streams.delete(name)
  }, 30_000)

  it('waits for the condition to hold for the rule duration', async () => {
    const name = uniqueName('HOLD')
    await jsm.streams.add({ name, subjects: [`${name}.>`] })
    await jsm.consumers.add(name, { durable_name: 'c', ack_policy: 'explicit' as never })
    const saved = await h.service.saveAlertRule(
      rule({ name: 'held', stream: name, threshold: 0, durationSeconds: 1.5 })
    )
    await js.publish(`${name}.x`, 'm')
    const start = Date.now()
    await sleep(700)
    expect(alerts.filter((a) => a.ruleId === saved.id)).toEqual([])
    await waitFor(() => alerts.some((a) => a.ruleId === saved.id), 5000, 'alert after duration')
    expect(Date.now() - start).toBeGreaterThanOrEqual(1400)
    await h.service.deleteAlertRule(id, saved.id)
    await jsm.streams.delete(name)
  })

  it('stays silent when snoozed or disabled', async () => {
    const name = uniqueName('QUIET')
    await jsm.streams.add({ name, subjects: [`${name}.>`] })
    await jsm.consumers.add(name, { durable_name: 'c', ack_policy: 'explicit' as never })
    const snoozed = await h.service.saveAlertRule(
      rule({ name: 'snoozed', stream: name, threshold: 0, snoozedUntil: Date.now() + 1200 })
    )
    const disabled = await h.service.saveAlertRule(
      rule({ name: 'disabled', stream: name, threshold: 0, enabled: false })
    )
    await js.publish(`${name}.x`, 'm')
    await sleep(INTERVAL * 4)
    expect(alerts.filter((a) => a.ruleId === snoozed.id || a.ruleId === disabled.id)).toEqual([])
    // When the snooze ends and the condition still holds, the rule fires.
    await waitFor(() => alerts.some((a) => a.ruleId === snoozed.id), 5000, 'alert after snooze')
    expect(alerts.some((a) => a.ruleId === disabled.id)).toBe(false)
    await h.service.deleteAlertRule(id, snoozed.id)
    await h.service.deleteAlertRule(id, disabled.id)
    await jsm.streams.delete(name)
  })

  it('alerts on redeliveries and on stream size as a share of its limit', async () => {
    const name = uniqueName('PCT')
    await jsm.streams.add({
      name,
      subjects: [`${name}.>`],
      max_bytes: 100_000,
      discard: 'new' as never
    })
    const unlimited = uniqueName('NOLIMIT')
    await jsm.streams.add({ name: unlimited, subjects: [`${unlimited}.>`] })
    const pct = await h.service.saveAlertRule(
      rule({ name: 'nearly full', metric: 'stream_bytes_pct', threshold: 50 })
    )
    await js.publish(`${unlimited}.x`, 'x'.repeat(60_000))
    await js.publish(`${name}.x`, 'x'.repeat(60_000))
    await waitFor(() => alerts.some((a) => a.ruleId === pct.id), 5000, 'size alert')
    const fired = alerts.filter((a) => a.ruleId === pct.id)
    // Only the stream with a limit can be "nearly full".
    expect(fired.map((a) => a.target)).toEqual([name])
    expect(fired[0].value).toBeGreaterThan(50)
    expect(fired[0].value).toBeLessThanOrEqual(100)
    await h.service.deleteAlertRule(id, pct.id)

    await jsm.consumers.add(name, {
      durable_name: 'r',
      ack_policy: 'explicit' as never,
      ack_wait: 300e6
    })
    const redeliver = await h.service.saveAlertRule(
      rule({
        name: 'redelivering',
        metric: 'consumer_redelivered',
        stream: name,
        consumer: 'r',
        threshold: 0
      })
    )
    const consumer = await js.consumers.get(name, 'r')
    for (let round = 0; round < 2; round++) {
      const batch = await consumer.fetch({ max_messages: 1, expires: 1000 })
      for await (const _ of batch) void 0
      await sleep(400)
    }
    await waitFor(() => alerts.some((a) => a.ruleId === redeliver.id), 5000, 'redelivery alert')
    await h.service.deleteAlertRule(id, redeliver.id)
    await jsm.streams.delete(name)
    await jsm.streams.delete(unlimited)
  }, 30_000)

  it('validates rules', async () => {
    expect((await gatewayErr(h.service.saveAlertRule(rule({ name: ' ' })))).kind).toBe('validation')
    expect((await gatewayErr(h.service.saveAlertRule(rule({ threshold: Number.NaN })))).kind).toBe(
      'validation'
    )
    expect((await gatewayErr(h.service.saveAlertRule(rule({ durationSeconds: -1 })))).kind).toBe(
      'validation'
    )
    expect((await gatewayErr(h.service.saveAlertRule(rule({ connId: 'nope' })))).kind).toBe(
      'not_found'
    )
  })
})

describe('PBI-092 audit log', () => {
  it('records every change with time, connection, action, target and result', async () => {
    const audited = await h.connect({ name: 'audited' })
    const name = uniqueName('AUDIT')
    await h.service.createStream(audited, { name, subjects: [`${name}.>`] })
    await h.service.publish(audited, {
      subject: `${name}.x`,
      mode: 'jetstream',
      payload: textToBase64('TOP-SECRET-PAYLOAD'),
      headers: [['Authorization', 'Bearer HEADER-SECRET']]
    })
    await h.service.createConsumer(audited, name, { durable_name: 'c', ack_policy: 'explicit' })
    await h.service.purgeStream(audited, name, { filter: `${name}.x` })
    await h.service.deleteConsumer(audited, name, 'c')
    await h.service
      .deleteStream(audited, name)
      .then(() => h.service.deleteStream(audited, name).catch(() => {}))
    // Reading is not a change and is not recorded.
    await h.service.listStreams(audited)

    const entries = await h.service.auditList({ connId: audited })
    expect(entries.map((e) => [e.action, e.target, e.result])).toEqual([
      ['stream.delete', name, 'error'],
      ['stream.delete', name, 'ok'],
      ['consumer.delete', `${name} > c`, 'ok'],
      ['stream.purge', name, 'ok'],
      ['consumer.create', `${name} > c`, 'ok'],
      ['publish.jetstream', `${name}.x`, 'ok'],
      ['stream.create', name, 'ok']
    ])
    expect(entries.every((e) => e.connName === 'audited' && e.connId === audited)).toBe(true)
    expect(entries.every((e) => Math.abs(new Date(e.time).getTime() - Date.now()) < 60_000)).toBe(
      true
    )
    expect(entries.find((e) => e.action === 'stream.purge')!.detail).toBe(
      JSON.stringify({ filter: `${name}.x` })
    )
    expect(entries.find((e) => e.action === 'publish.jetstream')!.detail).toBe('18 bytes')
    expect(entries[0].detail).toMatch(/stream not found/)

    // Payloads and header values never reach the log.
    const raw = readFileSync(join(h.dataDir, 'audit.ndjson'), 'utf8')
    expect(raw).not.toContain('TOP-SECRET-PAYLOAD')
    expect(raw).not.toContain('HEADER-SECRET')
    expect(raw).not.toContain(textToBase64('TOP-SECRET-PAYLOAD'))
  })

  it('filters by text and result, newest first, and exports CSV', async () => {
    const conn = await h.connect({ name: 'csv "quoted", conn' })
    const name = uniqueName('CSV')
    await h.service.createStream(conn, { name, subjects: [`${name}.>`] })
    await h.service.publish(conn, { subject: `${name}.=formula`, mode: 'core', payload: '' })
    await h.service.deleteStream(conn, 'DOES_NOT_EXIST').catch(() => {})

    expect(
      (await h.service.auditList({ connId: conn, result: 'error' })).map((e) => e.target)
    ).toEqual(['DOES_NOT_EXIST'])
    expect(
      (await h.service.auditList({ connId: conn, text: 'stream.create' })).map((e) => e.target)
    ).toEqual([name])
    expect(await h.service.auditList({ connId: conn, limit: 1 })).toHaveLength(1)

    const csv = await h.service.auditExportCsv({ connId: conn })
    const lines = csv.trim().split('\n')
    expect(lines[0]).toBe('"time","connection","action","target","result","detail","user"')
    expect(lines).toHaveLength(4)
    expect(lines[1]).toContain('"csv ""quoted"", conn"')
    // A value that a spreadsheet would run as a formula is neutralised.
    expect(csv).toContain(`"${name}.=formula"`)
    expect(new AuditLog(h.dataDir).toCsv({ connId: 'x' })).toBe(
      '"time","connection","action","target","result","detail","user"\n'
    )
  })

  it('neutralises spreadsheet formulas in exported values', () => {
    const dir = join(h.dataDir, 'audit-formula')
    const log = new AuditLog(dir)
    log.record({
      connId: 'c',
      connName: '=cmd()',
      action: 'publish',
      target: '+1+1',
      result: 'ok',
      detail: '@SUM(A1)'
    })
    const row = log.toCsv().trim().split('\n')[1]
    expect(row).toContain(`"'=cmd()"`)
    expect(row).toContain(`"'+1+1"`)
    expect(row).toContain(`"'@SUM(A1)"`)
  })

  it('drops entries older than the retention period', () => {
    const dir = join(h.dataDir, 'audit-prune')
    const log = new AuditLog(dir)
    log.record({ connId: 'c', connName: 'c', action: 'new', target: 't', result: 'ok' })
    const day = 86_400_000
    expect(log.prune(90, Date.now() + 89 * day)).toBe(0)
    expect(log.list()).toHaveLength(1)
    expect(log.prune(90, Date.now() + 91 * day)).toBe(1)
    expect(log.list()).toEqual([])
  })

  it('applies the configured retention when the app starts', async () => {
    const name = uniqueName('RETENTION')
    const conn = await h.connect({ name: 'retention' })
    await h.service.createStream(conn, { name, subjects: [`${name}.>`] })
    await h.service.setSetting('audit.retentionDays', 0)
    // Entries written in the very millisecond of the restart count as "not older", so step past it.
    await sleep(5)
    const restarted = new StudioService({
      dataDir: h.dataDir,
      secretStore: new KeyFileSecretStore(join(h.dataDir, 'secret.key')),
      cliContextDir: join(h.dataDir, 'none'),
      mode: 'desktop',
      appVersion: 't',
      natsClientVersion: 't'
    })
    try {
      expect(await restarted.auditList({})).toEqual([])
    } finally {
      await restarted.dispose()
      await h.service.setSetting('audit.retentionDays', null)
    }
  })
})

describe('PBI-090 search index and PBI-091 saved settings', () => {
  it('indexes streams, consumers, KV buckets and Object Store buckets', async () => {
    const conn = await h.connect({ name: 'search' })
    const name = uniqueName('SEARCH')
    await h.service.createStream(conn, { name, subjects: [`${name}.>`] })
    await h.service.createConsumer(conn, name, { durable_name: 'finder', ack_policy: 'explicit' })
    const kv = uniqueName('skv')
    const obj = uniqueName('sobj')
    await h.service.createKvBucket(conn, { bucket: kv })
    await h.service.createObjBucket(conn, { bucket: obj })
    await sleep(INTERVAL * 3)

    const started = performance.now()
    const index = await h.service.searchIndex(conn)
    expect(performance.now() - started).toBeLessThan(1000)
    expect(index.streams).toContain(name)
    expect(index.streams.some((s) => s.startsWith('KV_') || s.startsWith('OBJ_'))).toBe(false)
    expect(index.consumers).toContainEqual({ stream: name, name: 'finder' })
    expect(index.kv).toContain(kv)
    expect(index.obj).toContain(obj)
    await h.service.deleteKvBucket(conn, kv)
    await h.service.deleteObjBucket(conn, obj)
    await h.service.deleteStream(conn, name)
  })

  it('keeps saved filters and favourites across restarts and removes them with the connection', async () => {
    const conn = await h.connect({ name: 'settings' })
    const filters = [
      { name: 'EU shipped', subject: 'orders.eu.shipped', filters: { payloadContains: 'urgent' } }
    ]
    await h.service.setSetting(`conn:${conn}:savedFilters`, filters)
    await h.service.setSetting(`conn:${conn}:favorites`, [{ kind: 'stream', stream: 'ORDERS' }])
    await h.service.setSetting('ui.global', { theme: 'dark' })
    expect(await h.service.getSetting(`conn:${conn}:savedFilters`)).toEqual(filters)
    expect(await h.service.getSetting('missing')).toBeNull()

    const restarted = new StudioService({
      dataDir: h.dataDir,
      secretStore: new KeyFileSecretStore(join(h.dataDir, 'secret.key')),
      cliContextDir: join(h.dataDir, 'none'),
      mode: 'desktop',
      appVersion: 't',
      natsClientVersion: 't'
    })
    expect(await restarted.getSetting(`conn:${conn}:savedFilters`)).toEqual(filters)
    await restarted.dispose()

    await h.service.deleteConnection(conn)
    const afterDelete = new StudioService({
      dataDir: h.dataDir,
      secretStore: new KeyFileSecretStore(join(h.dataDir, 'secret.key')),
      cliContextDir: join(h.dataDir, 'none'),
      mode: 'desktop',
      appVersion: 't',
      natsClientVersion: 't'
    })
    expect(await afterDelete.getSetting(`conn:${conn}:savedFilters`)).toBeNull()
    expect(await afterDelete.getSetting(`conn:${conn}:favorites`)).toBeNull()
    expect(await afterDelete.getSetting('ui.global')).toEqual({ theme: 'dark' })
    await afterDelete.dispose()
  })

  it('refuses unknown gateway methods', async () => {
    await expect(h.service.invoke('dispose', [])).rejects.toMatchObject({ kind: 'internal' })
    await expect(h.service.invoke('constructor', [])).rejects.toMatchObject({ kind: 'internal' })
    await expect(h.service.invoke('store', [])).rejects.toMatchObject({ kind: 'internal' })
  })
})
