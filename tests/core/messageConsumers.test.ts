import type { JetStreamClient, JetStreamManager } from '@nats-io/jetstream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { messageConsumerStatus } from '@shared/messageConsumers'
import { createHarness, uniqueName, type Harness } from '../helpers/studio'

let h: Harness
let id: string
let jsm: JetStreamManager
let js: JetStreamClient
beforeAll(async () => {
  h = await createHarness()
  id = await h.connect({ name: 'message-consumers' })
  ;({ jsm, js } = await h.client())
})
afterAll(async () => {
  await h.dispose()
})

describe('PBI-049 which consumers have received a message', () => {
  it('works out each consumer state for each message against a real server', async () => {
    const name = uniqueName('MC')
    await jsm.streams.add({ name, subjects: [`${name}.>`] })
    for (let i = 1; i <= 6; i++) await js.publish(`${name}.${i % 2 ? 'odd' : 'even'}`, `m${i}`)

    // "all" reads four messages and acknowledges the first two; 3 and 4 stay pending.
    await jsm.consumers.add(name, { durable_name: 'all', ack_policy: 'explicit' as never })
    const all = await js.consumers.get(name, 'all')
    let n = 0
    for await (const m of await all.fetch({ max_messages: 4, expires: 2000 })) if (n++ < 2) m.ack()

    // "bysq" starts at sequence 4 and takes everything with ack policy none.
    await jsm.consumers.add(name, {
      durable_name: 'bysq',
      ack_policy: 'none' as never,
      deliver_policy: 'by_start_sequence' as never,
      opt_start_seq: 4
    })
    const bysq = await js.consumers.get(name, 'bysq')
    for await (const m of await bysq.fetch({ max_messages: 3, expires: 2000 })) void m

    // "odd" only sees odd subjects.
    await jsm.consumers.add(name, {
      durable_name: 'odd',
      ack_policy: 'explicit' as never,
      filter_subject: `${name}.odd`
    })

    // "new" is created after message 6 and then sees messages 7 and 8.
    await new Promise((r) => setTimeout(r, 50))
    await jsm.consumers.add(name, {
      durable_name: 'new',
      ack_policy: 'explicit' as never,
      deliver_policy: 'new' as never
    })
    await js.publish(`${name}.odd`, 'm7')
    await js.publish(`${name}.even`, 'm8')
    const fresh = await js.consumers.get(name, 'new')
    for await (const m of await fresh.fetch({ max_messages: 1, expires: 2000 })) m.ack()
    await new Promise((r) => setTimeout(r, 150))

    const consumers = await h.service.listConsumers(id, name)
    const stateOf = async (seq: number, consumer: string): Promise<string> => {
      const m = await h.service.getMessage(id, name, seq)
      const info = consumers.find((c) => c.name === consumer)!
      return messageConsumerStatus({ seq, subject: m.subject, time: m.time }, info).state
    }

    // all: 1-2 acknowledged, 3-4 waiting, 5-8 not delivered.
    expect(await Promise.all([1, 2, 3, 4, 5, 8].map((s) => stateOf(s, 'all')))).toEqual([
      'done',
      'done',
      'waiting-ack',
      'waiting-ack',
      'not-delivered',
      'not-delivered'
    ])
    // by_start_sequence 4 with ack none: 1-3 before the start, 4-6 delivered, 7 not yet.
    expect(await Promise.all([1, 3, 4, 6, 7].map((s) => stateOf(s, 'bysq')))).toEqual([
      'before-start',
      'before-start',
      'done',
      'done',
      'not-delivered'
    ])
    // new: everything stored before it was created is before the start; 7 was acknowledged.
    expect(await Promise.all([1, 6, 7, 8].map((s) => stateOf(s, 'new')))).toEqual([
      'before-start',
      'before-start',
      'done',
      'not-delivered'
    ])
    // odd: even-subject messages are not for it; 7 is odd and not delivered.
    expect(await Promise.all([2, 8, 1, 7].map((s) => stateOf(s, 'odd')))).toEqual([
      'not-for-consumer',
      'not-for-consumer',
      'not-delivered',
      'not-delivered'
    ])

    // The check only reads: no consumer was added or changed by asking.
    expect((await h.service.listConsumers(id, name)).map((c) => c.name).sort()).toEqual([
      'all',
      'bysq',
      'new',
      'odd'
    ])
    await jsm.streams.delete(name)
  }, 30_000)
})
