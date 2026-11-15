import type { JetStreamClient, JetStreamManager } from '@nats-io/jetstream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ConsumerConfigDto } from '@shared/api'
import { createHarness, gatewayErr, uniqueName, type Harness } from '../helpers/studio'

let h: Harness
let id: string
let jsm: JetStreamManager
let js: JetStreamClient
beforeAll(async () => {
  h = await createHarness()
  id = await h.connect({ name: 'consumers' })
  ;({ jsm, js } = await h.client())
})
afterAll(async () => {
  await h.dispose()
})

async function stream(messages = 0): Promise<string> {
  const name = uniqueName('CONS')
  await jsm.streams.add({ name, subjects: [`${name}.>`] })
  for (let i = 0; i < messages; i++) await js.publish(`${name}.${i % 2 ? 'odd' : 'even'}`, `m${i}`)
  return name
}

describe('PBI-050 consumers list', () => {
  it('shows type, filters, ack policy and progress for each consumer', async () => {
    const name = await stream(10)
    await jsm.consumers.add(name, {
      durable_name: 'pull_durable',
      ack_policy: 'explicit' as never,
      filter_subjects: [`${name}.odd`, `${name}.even`]
    })
    await jsm.consumers.add(name, {
      durable_name: 'push_durable',
      deliver_subject: `deliver.${name}`,
      ack_policy: 'none' as never,
      filter_subject: `${name}.odd`
    })
    await jsm.consumers.add(name, {
      name: 'ephemeral_one',
      ack_policy: 'explicit' as never,
      inactive_threshold: 60e9
    })

    // Take three messages and acknowledge only one, so the counters are all different.
    const consumer = await js.consumers.get(name, 'pull_durable')
    const batch = await consumer.fetch({ max_messages: 3, expires: 2000 })
    let n = 0
    for await (const m of batch) if (n++ === 0) m.ack()
    await new Promise((r) => setTimeout(r, 100))

    const list = await h.service.listConsumers(id, name)
    expect(list.map((c) => c.name).sort()).toEqual([
      'ephemeral_one',
      'pull_durable',
      'push_durable'
    ])

    const pull = list.find((c) => c.name === 'pull_durable')!
    expect(pull.config).toMatchObject({
      durable_name: 'pull_durable',
      ack_policy: 'explicit',
      filter_subjects: [`${name}.odd`, `${name}.even`]
    })
    expect(pull.config.deliver_subject).toBeUndefined()
    expect(pull).toMatchObject({
      num_pending: 7,
      num_ack_pending: 2,
      num_redelivered: 0,
      stream_name: name
    })
    expect(pull.delivered).toMatchObject({ consumer_seq: 3, stream_seq: 3 })
    expect(pull.ack_floor).toMatchObject({ stream_seq: 1 })
    expect(new Date(pull.delivered.last_active!).getTime()).toBeGreaterThan(Date.now() - 60_000)
    expect(pull.health).toEqual([])

    const push = list.find((c) => c.name === 'push_durable')!
    expect(push.config).toMatchObject({
      deliver_subject: `deliver.${name}`,
      ack_policy: 'none',
      filter_subject: `${name}.odd`
    })
    const eph = list.find((c) => c.name === 'ephemeral_one')!
    expect(eph.config.durable_name).toBeUndefined()
    await jsm.streams.delete(name)
  })

  it('lists consumers across every stream of the connection', async () => {
    const a = await stream()
    const b = await stream()
    await jsm.consumers.add(a, { durable_name: 'ca' })
    await jsm.consumers.add(b, { durable_name: 'cb1' })
    await jsm.consumers.add(b, { durable_name: 'cb2' })
    const all = await h.service.listAllConsumers(id)
    const mine = all
      .filter((c) => c.stream_name === a || c.stream_name === b)
      .map((c) => `${c.stream_name}/${c.name}`)
    expect(mine.sort()).toEqual([`${a}/ca`, `${b}/cb1`, `${b}/cb2`].sort())
    await jsm.streams.delete(a)
    await jsm.streams.delete(b)
  })

  it('handles 1,000 consumers on one stream', async () => {
    const name = await stream()
    let next = 0
    await Promise.all(
      Array.from({ length: 24 }, async () => {
        while (next < 1000) {
          const n = next++
          await jsm.consumers.add(name, {
            durable_name: `c${String(n).padStart(4, '0')}`,
            mem_storage: true
          })
        }
      })
    )
    const started = Date.now()
    const list = await h.service.listConsumers(id, name)
    expect(list).toHaveLength(1000)
    expect(Date.now() - started).toBeLessThan(10_000)
    await jsm.streams.delete(name)
  }, 60_000)
})

describe('PBI-051 consumer detail and lag', () => {
  it('reports position, lag and configuration', async () => {
    const name = await stream(25)
    await jsm.consumers.add(name, {
      durable_name: 'worker',
      ack_policy: 'explicit' as never,
      max_ack_pending: 50,
      ack_wait: 30e9,
      description: 'the worker'
    })
    const consumer = await js.consumers.get(name, 'worker')
    const batch = await consumer.fetch({ max_messages: 10, expires: 2000 })
    for await (const m of batch) m.ack()
    await new Promise((r) => setTimeout(r, 100))

    const info = await h.service.consumerInfo(id, name, 'worker')
    expect(info.config).toMatchObject({
      description: 'the worker',
      max_ack_pending: 50,
      ack_wait: 30e9,
      deliver_policy: 'all',
      replay_policy: 'instant'
    })
    expect(info.num_pending).toBe(15)
    expect(info.delivered).toMatchObject({ consumer_seq: 10, stream_seq: 10 })
    expect(info.ack_floor).toMatchObject({ consumer_seq: 10, stream_seq: 10 })
    // The next message the consumer has not been delivered is delivered.stream_seq + 1.
    const next = await h.service.getMessages(id, name, {
      direction: 'asc',
      start: { kind: 'seq', seq: info.delivered.stream_seq + 1 },
      limit: 1
    })
    expect(next.messages[0].seq).toBe(11)
    const streamInfo = await h.service.streamInfo(id, name)
    expect(streamInfo.state.last_seq - info.delivered.stream_seq).toBe(info.num_pending)
    await jsm.streams.delete(name)
  })

  it('reports a missing consumer as not found', async () => {
    const name = await stream()
    const err = await gatewayErr(h.service.consumerInfo(id, name, 'nobody'))
    expect(err.kind).toBe('not_found')
    expect(err.natsCode).toBe(10014)
    await jsm.streams.delete(name)
  })
})

describe('PBI-052 create, edit and delete a consumer', () => {
  it('creates a pull consumer with every field the form covers', async () => {
    const name = await stream(5)
    const config: ConsumerConfigDto = {
      durable_name: 'full',
      name: 'full',
      description: 'all the options',
      filter_subjects: [`${name}.odd`],
      deliver_policy: 'by_start_sequence',
      opt_start_seq: 2,
      ack_policy: 'explicit',
      ack_wait: 45e9,
      max_deliver: 5,
      backoff: [1e9, 5e9, 10e9],
      max_ack_pending: 200,
      replay_policy: 'instant',
      inactive_threshold: 3600e9
    }
    const created = await h.service.createConsumer(id, name, config)
    // With a backoff list the server uses its first step as the ack wait, whatever was asked for.
    expect(created.config).toMatchObject({ ...config, ack_wait: 1e9 })
    expect(created.name).toBe('full')
    // Five messages, "odd" on sequences 2 and 4; both are at or after the start sequence.
    expect(created.num_pending).toBe(2)
    await jsm.streams.delete(name)
  })

  it('creates consumers for each deliver policy', async () => {
    const name = await stream(6)
    const start = new Date(Date.now() - 3600_000).toISOString()
    const cases: [string, ConsumerConfigDto, number][] = [
      ['all', { deliver_policy: 'all' }, 6],
      ['last', { deliver_policy: 'last' }, 1],
      ['new', { deliver_policy: 'new' }, 0],
      ['by_time', { deliver_policy: 'by_start_time', opt_start_time: start }, 6],
      ['last_per_subject', { deliver_policy: 'last_per_subject', filter_subject: `${name}.>` }, 2]
    ]
    for (const [label, cfg, pending] of cases) {
      const info = await h.service.createConsumer(id, name, {
        durable_name: label,
        ack_policy: 'explicit',
        ...cfg
      })
      expect(info.num_pending, label).toBe(pending)
      expect(info.config.deliver_policy, label).toBe(cfg.deliver_policy)
    }
    await jsm.streams.delete(name)
  })

  it('creates a push consumer with a deliver group', async () => {
    const name = await stream()
    const info = await h.service.createConsumer(id, name, {
      durable_name: 'pusher',
      deliver_subject: `push.${name}`,
      deliver_group: 'workers',
      ack_policy: 'explicit'
    })
    expect(info.config).toMatchObject({ deliver_subject: `push.${name}`, deliver_group: 'workers' })
    await jsm.streams.delete(name)
  })

  it('edits the fields the server allows', async () => {
    const name = await stream()
    const created = await h.service.createConsumer(id, name, {
      durable_name: 'editable',
      ack_policy: 'explicit',
      ack_wait: 30e9,
      max_deliver: 3
    })
    const updated = await h.service.updateConsumer(id, name, 'editable', {
      ...created.config,
      ack_wait: 90e9,
      max_deliver: 10,
      description: 'edited',
      max_ack_pending: 77
    })
    expect(updated.config).toMatchObject({
      ack_wait: 90e9,
      max_deliver: 10,
      description: 'edited',
      max_ack_pending: 77
    })
    expect((await jsm.consumers.info(name, 'editable')).config.ack_wait).toBe(90e9)

    // The ack policy cannot change after creation; the server says so.
    const err = await gatewayErr(
      h.service.updateConsumer(id, name, 'editable', { ...updated.config, ack_policy: 'none' })
    )
    expect(err.kind).toBe('jetstream')
    expect(err.natsCode).toBeGreaterThan(10000)
    await jsm.streams.delete(name)
  })

  it('shows server validation errors', async () => {
    const name = await stream()
    // Three backoff steps need max_deliver to be more than three.
    const err = await gatewayErr(
      h.service.createConsumer(id, name, {
        durable_name: 'bad',
        ack_policy: 'explicit',
        max_deliver: 2,
        backoff: [1e9, 2e9, 3e9]
      })
    )
    expect(err.kind).toBe('jetstream')
    expect(err.message).toMatch(/max deliver.*\(JetStream error \d+\)/i)
    expect(await h.service.listConsumers(id, name)).toEqual([])
    await jsm.streams.delete(name)
  })

  it('deletes a consumer', async () => {
    const name = await stream()
    await h.service.createConsumer(id, name, { durable_name: 'gone', ack_policy: 'explicit' })
    await h.service.deleteConsumer(id, name, 'gone')
    expect(await h.service.listConsumers(id, name)).toEqual([])
    expect((await gatewayErr(h.service.deleteConsumer(id, name, 'gone'))).kind).toBe('not_found')
    await jsm.streams.delete(name)
  })
})

describe('PBI-053 pause and resume a consumer', () => {
  it('pauses until a time and resumes early', async () => {
    const name = await stream(3)
    await h.service.createConsumer(id, name, { durable_name: 'pausable', ack_policy: 'explicit' })
    const until = new Date(Date.now() + 120_000)
    const paused = await h.service.pauseConsumer(id, name, 'pausable', until.toISOString())
    expect(paused.paused).toBe(true)
    expect(paused.pause_remaining).toBeGreaterThan(100e9)
    expect(paused.pause_remaining).toBeLessThanOrEqual(120e9)
    expect((await h.service.listConsumers(id, name))[0].paused).toBe(true)

    // A paused consumer delivers nothing.
    const consumer = await js.consumers.get(name, 'pausable')
    const batch = await consumer.fetch({ max_messages: 3, expires: 1000 })
    let got = 0
    for await (const _ of batch) got++
    expect(got).toBe(0)

    const resumed = await h.service.resumeConsumer(id, name, 'pausable')
    expect(resumed.paused).toBeFalsy()
    const batch2 = await consumer.fetch({ max_messages: 3, expires: 2000 })
    for await (const m of batch2) {
      m.ack()
      got++
    }
    expect(got).toBe(3)
    await jsm.streams.delete(name)
  })

  it('rejects a pause time in the past', async () => {
    const name = await stream()
    await h.service.createConsumer(id, name, { durable_name: 'p', ack_policy: 'explicit' })
    const err = await gatewayErr(
      h.service.pauseConsumer(id, name, 'p', new Date(Date.now() - 1000).toISOString())
    )
    expect(err.kind).toBe('validation')
    await jsm.streams.delete(name)
  })
})

describe('PBI-054 unhealthy consumers', () => {
  it('flags redeliveries, a full ack-pending window and a stalled consumer', async () => {
    const name = await stream(20)
    await jsm.consumers.add(name, {
      durable_name: 'struggling',
      ack_policy: 'explicit' as never,
      ack_wait: 300e6,
      max_ack_pending: 5,
      max_deliver: 10
    })
    await jsm.consumers.add(name, { durable_name: 'fine', ack_policy: 'explicit' as never })

    // Take five messages and never acknowledge them: the window fills up and they are redelivered.
    const consumer = await js.consumers.get(name, 'struggling')
    for (let round = 0; round < 3; round++) {
      const batch = await consumer.fetch({ max_messages: 5, expires: 1000 })
      for await (const _ of batch) void 0
      await new Promise((r) => setTimeout(r, 350))
    }

    await h.service.setSetting(`conn:${id}:health`, { redelivered: 3, stalledSeconds: 1 })
    await new Promise((r) => setTimeout(r, 1200))
    const list = await h.service.listConsumers(id, name)
    const struggling = list.find((c) => c.name === 'struggling')!
    expect(struggling.num_redelivered).toBeGreaterThan(3)
    expect(struggling.health).toContain('redeliveries')
    expect(struggling.health).toContain('ack_pending_max')
    expect(struggling.health).toContain('stalled')
    // "fine" has messages pending and nobody is reading them, so it is stalled too, but nothing else.
    expect(list.find((c) => c.name === 'fine')!.health).toEqual(['stalled'])

    // With default thresholds the same consumer is only flagged for the full window.
    await h.service.setSetting(`conn:${id}:health`, null)
    const relaxed = await h.service.consumerInfo(id, name, 'struggling')
    expect(relaxed.health).toEqual(['ack_pending_max'])
    await jsm.streams.delete(name)
  }, 30_000)
})
