import { describe, expect, it } from 'vitest'
import type { ConsumerConfigDto, ConsumerInfoDto } from '@shared/api'
import {
  consumerFilterSubjects,
  messageConsumerStatus,
  retentionNote,
  type MessageRef
} from '@shared/messageConsumers'

const CREATED = '2026-01-01T12:00:00Z'
const BEFORE = '2026-01-01T11:00:00Z'
const AFTER = '2026-01-01T13:00:00Z'

function consumer(
  config: ConsumerConfigDto = {},
  progress: { delivered?: number; floor?: number; ackPending?: number } = {}
): ConsumerInfoDto {
  return {
    stream_name: 'S',
    name: 'c',
    created: CREATED,
    config: { ack_policy: 'explicit', deliver_policy: 'all', ...config },
    delivered: { consumer_seq: progress.delivered ?? 0, stream_seq: progress.delivered ?? 0 },
    ack_floor: { consumer_seq: progress.floor ?? 0, stream_seq: progress.floor ?? 0 },
    num_ack_pending: progress.ackPending ?? 0,
    num_redelivered: 0,
    num_waiting: 0,
    num_pending: 0
  }
}

const msg = (over: Partial<MessageRef> = {}): MessageRef => ({
  seq: 5,
  subject: 'orders.eu.new',
  time: AFTER,
  ...over
})

describe('PBI-049 filter subjects', () => {
  it('treats no filter as all subjects', () => {
    expect(messageConsumerStatus(msg(), consumer()).state).not.toBe('not-for-consumer')
  })

  it('matches wildcards * and >', () => {
    const ok = (filter: string): boolean =>
      messageConsumerStatus(msg(), consumer({ filter_subject: filter })).state !==
      'not-for-consumer'
    expect(ok('orders.*.new')).toBe(true)
    expect(ok('orders.>')).toBe(true)
    expect(ok('orders.eu.new')).toBe(true)
    expect(ok('orders.*')).toBe(false)
    expect(ok('orders.us.>')).toBe(false)
    expect(ok('billing.>')).toBe(false)
  })

  it('uses any of several filter subjects, and both fields', () => {
    const c = consumer({ filter_subjects: ['billing.>', 'orders.*.new'] })
    expect(messageConsumerStatus(msg(), c).state).not.toBe('not-for-consumer')
    const none = consumer({ filter_subjects: ['billing.>', 'audit.*'] })
    const s = messageConsumerStatus(msg(), none)
    expect(s.state).toBe('not-for-consumer')
    expect(s.label).toBe('Not for this consumer')
    expect(
      consumerFilterSubjects(consumer({ filter_subject: 'a', filter_subjects: ['b'] }))
    ).toEqual(['b', 'a'])
  })

  it('is checked before the start position and the progress', () => {
    const c = consumer(
      { deliver_policy: 'by_start_sequence', opt_start_seq: 100, filter_subject: 'x' },
      { delivered: 50, floor: 50 }
    )
    expect(messageConsumerStatus(msg(), c).state).toBe('not-for-consumer')
  })
})

describe('PBI-049 start position', () => {
  it('all: nothing is before the start', () => {
    expect(messageConsumerStatus(msg({ seq: 1, time: BEFORE }), consumer()).state).toBe(
      'not-delivered'
    )
  })

  it('by_start_sequence: below opt_start_seq is before the start, the start itself is not', () => {
    const c = consumer({ deliver_policy: 'by_start_sequence', opt_start_seq: 5 })
    expect(messageConsumerStatus(msg({ seq: 4 }), c).state).toBe('before-start')
    expect(messageConsumerStatus(msg({ seq: 5 }), c).state).toBe('not-delivered')
    expect(messageConsumerStatus(msg({ seq: 4 }), c).note).toBeUndefined()
  })

  it('by_start_time: stored before opt_start_time is before the start', () => {
    const c = consumer({ deliver_policy: 'by_start_time', opt_start_time: CREATED })
    expect(messageConsumerStatus(msg({ time: BEFORE }), c).state).toBe('before-start')
    expect(messageConsumerStatus(msg({ time: AFTER }), c).state).toBe('not-delivered')
    expect(messageConsumerStatus(msg({ time: Date.parse(BEFORE) }), c).state).toBe('before-start')
  })

  it('new: stored before created is before the start', () => {
    const c = consumer({ deliver_policy: 'new' })
    expect(messageConsumerStatus(msg({ time: BEFORE }), c).state).toBe('before-start')
    expect(messageConsumerStatus(msg({ time: AFTER }), c).state).toBe('not-delivered')
  })

  it.each(['last', 'last_per_subject'] as const)(
    '%s: before created is "probably not delivered"',
    (policy) => {
      const c = consumer({ deliver_policy: policy })
      const s = messageConsumerStatus(msg({ time: BEFORE }), c)
      expect(s.state).toBe('before-start')
      expect(s.note).toContain('Probably not delivered: only the last message')
      expect(s.note).toContain(policy === 'last' ? 'at creation' : 'per subject at creation')
      expect(s.tooltip).toContain('probably not delivered')
      expect(messageConsumerStatus(msg({ time: AFTER }), c).state).toBe('not-delivered')
    }
  )

  it('a message before the start is not reported as done even when below the ack floor', () => {
    // A new consumer's ack floor starts at the sequence before its start.
    const c = consumer({ deliver_policy: 'new' }, { delivered: 10, floor: 10 })
    expect(messageConsumerStatus(msg({ seq: 3, time: BEFORE }), c).state).toBe('before-start')
  })
})

describe('PBI-049 progress', () => {
  it('done at or below the ack floor, and the tooltip says what that means', () => {
    const c = consumer({}, { delivered: 8, floor: 5, ackPending: 3 })
    const s = messageConsumerStatus(msg({ seq: 5 }), c)
    expect(s.state).toBe('done')
    expect(s.label).toBe('Done')
    expect(s.tooltip).toMatch(/acknowledged, terminated or out of delivery attempts/)
  })

  it('explicit: above the floor and delivered is waiting for ack, with the out-of-order note', () => {
    const c = consumer({}, { delivered: 8, floor: 5, ackPending: 3 })
    const s = messageConsumerStatus(msg({ seq: 6 }), c)
    expect(s.state).toBe('waiting-ack')
    expect(s.label).toBe('Delivered, waiting for ack')
    expect(s.note).toMatch(/may already be done out of order/i)
    expect(s.tooltip).toContain('may already be done out of order')
    expect(messageConsumerStatus(msg({ seq: 8 }), c).state).toBe('waiting-ack')
  })

  it('all: waiting for ack has no out-of-order note because the floor is exact', () => {
    const c = consumer({ ack_policy: 'all' }, { delivered: 8, floor: 5, ackPending: 3 })
    const s = messageConsumerStatus(msg({ seq: 7 }), c)
    expect(s.state).toBe('waiting-ack')
    expect(s.note).toBeUndefined()
    expect(s.tooltip).not.toContain('out of order')
  })

  it('shows Done when num_ack_pending is 0 although above the floor', () => {
    const c = consumer({}, { delivered: 8, floor: 5, ackPending: 0 })
    const s = messageConsumerStatus(msg({ seq: 7 }), c)
    expect(s.state).toBe('done')
    expect(s.label).toBe('Done')
  })

  it('not delivered yet above the last delivered sequence', () => {
    const c = consumer({}, { delivered: 8, floor: 5, ackPending: 3 })
    expect(messageConsumerStatus(msg({ seq: 9 }), c).state).toBe('not-delivered')
  })

  it('ack policy none: delivered reads "Delivered, no ack needed", using the delivered sequence', () => {
    const c = consumer({ ack_policy: 'none' }, { delivered: 8, floor: 2, ackPending: 0 })
    const s = messageConsumerStatus(msg({ seq: 7 }), c)
    expect(s.state).toBe('done')
    expect(s.label).toBe('Delivered, no ack needed')
    expect(messageConsumerStatus(msg({ seq: 9 }), c).state).toBe('not-delivered')
  })

  it('a push consumer with nothing delivered yet has not delivered anything', () => {
    expect(messageConsumerStatus(msg({ seq: 1 }), consumer()).state).toBe('not-delivered')
  })
})

describe('PBI-049 retention notes', () => {
  it('explains work-queue and interest streams, and nothing for limits', () => {
    expect(retentionNote('workqueue')).toMatch(/removed once its consumer acknowledges/)
    expect(retentionNote('workqueue')).toMatch(/ack policy none, once it is delivered/)
    expect(retentionNote('interest')).toMatch(/every interested consumer/)
    expect(retentionNote('limits')).toBeUndefined()
    expect(retentionNote(undefined)).toBeUndefined()
  })
})
