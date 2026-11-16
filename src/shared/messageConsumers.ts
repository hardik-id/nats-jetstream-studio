/**
 * Which consumers have received one stream message (PBI-049).
 *
 * NATS keeps no per-message receipt, so the answer is worked out from the consumer's info: its
 * filter subjects, deliver policy and start options, ack policy, `created`, the last delivered
 * stream sequence and the ack floor. Nothing here reads or changes server state.
 */
import type { ConsumerInfoDto, StreamConfigDto } from './api'
import { subjectMatches } from './subject'

export type MessageConsumerState =
  'not-for-consumer' | 'before-start' | 'done' | 'waiting-ack' | 'not-delivered'

export interface MessageRef {
  seq: number
  subject: string
  /** ISO string or epoch ms: when the stream stored the message. */
  time: string | number
}

export interface MessageConsumerStatus {
  state: MessageConsumerState
  label: string
  /** The rule that was used, in a sentence or two. */
  tooltip: string
  /** Extra caution shown beside the state, when the answer is not certain. */
  note?: string
}

/** The consumer's filter subjects: `filter_subjects` and `filter_subject`; empty means all. */
export function consumerFilterSubjects(c: ConsumerInfoDto): string[] {
  const list = [...(c.config.filter_subjects ?? [])]
  if (c.config.filter_subject) list.push(c.config.filter_subject)
  return list.filter((f) => f !== '')
}

function toMs(t: string | number | undefined): number | undefined {
  if (t === undefined) return undefined
  const ms = typeof t === 'number' ? t : new Date(t).getTime()
  return Number.isNaN(ms) ? undefined : ms
}

/** What the studio can say about one message and one consumer. */
export function messageConsumerStatus(
  message: MessageRef,
  consumer: ConsumerInfoDto
): MessageConsumerStatus {
  const { config } = consumer

  // 1. Filter.
  const filters = consumerFilterSubjects(consumer)
  if (filters.length > 0 && !filters.some((f) => subjectMatches(f, message.subject))) {
    return {
      state: 'not-for-consumer',
      label: 'Not for this consumer',
      tooltip: `The subject ${message.subject} matches none of its filter subjects (${filters.join(', ')}), so it never receives this message.`
    }
  }

  // 2. Start position.
  const policy = config.deliver_policy ?? 'all'
  const time = toMs(message.time)
  const created = toMs(consumer.created)
  let before = false
  let startRule = ''
  switch (policy) {
    case 'all':
      break
    case 'by_start_sequence': {
      const start = config.opt_start_seq ?? 0
      before = message.seq < start
      startRule = `The consumer starts at sequence ${start} and this message is sequence ${message.seq}.`
      break
    }
    case 'by_start_time': {
      const start = toMs(config.opt_start_time)
      before = time !== undefined && start !== undefined && time < start
      startRule = `The consumer starts at ${config.opt_start_time} and this message was stored before that.`
      break
    }
    case 'new':
      before = time !== undefined && created !== undefined && time < created
      startRule = `The consumer only receives messages stored after it was created (${consumer.created}), and this one was stored before.`
      break
    case 'last':
    case 'last_per_subject':
      before = time !== undefined && created !== undefined && time < created
      startRule = `The consumer started from the ${policy === 'last' ? "stream's last message" : 'last message of each subject'} at its creation (${consumer.created}) and this one was stored before.`
      break
  }
  if (before) {
    const probable = policy === 'last' || policy === 'last_per_subject'
    return {
      state: 'before-start',
      label: 'Before the consumer started',
      tooltip: probable
        ? `${startRule} NATS does not record which message that was, so this one was probably not delivered.`
        : `${startRule} It was never delivered to this consumer.`,
      note: probable
        ? `Probably not delivered: only the last message${policy === 'last_per_subject' ? ' per subject' : ''} at creation was`
        : undefined
    }
  }

  const ackFloor = consumer.ack_floor?.stream_seq ?? 0
  const delivered = consumer.delivered?.stream_seq ?? 0
  const ackPolicy = config.ack_policy ?? 'explicit'

  // 3. Done.
  if (ackPolicy === 'none') {
    if (message.seq <= delivered) {
      return {
        state: 'done',
        label: 'Delivered, no ack needed',
        tooltip: `Ack policy is none, so a delivered message needs no acknowledgement. Its sequence ${message.seq} is at or below the last delivered sequence ${delivered}.`
      }
    }
  } else if (message.seq <= ackFloor) {
    return {
      state: 'done',
      label: 'Done',
      tooltip: `Sequence ${message.seq} is at or below the consumer's ack floor ${ackFloor}. That means acknowledged, terminated or out of delivery attempts: NATS does not tell these apart.`
    }
  }

  // 4. Delivered, waiting for ack.
  if (message.seq <= delivered) {
    if (consumer.num_ack_pending === 0) {
      return {
        state: 'done',
        label: 'Done',
        tooltip: `Sequence ${message.seq} was delivered (last delivered ${delivered}) and the consumer has no acknowledgements outstanding, so it is finished with it.`
      }
    }
    const explicit = ackPolicy === 'explicit'
    return {
      state: 'waiting-ack',
      label: 'Delivered, waiting for ack',
      tooltip:
        `Sequence ${message.seq} is above the ack floor ${ackFloor} and at or below the last delivered sequence ${delivered}.` +
        (explicit
          ? ' With ack policy explicit this message may already be done out of order: NATS does not expose individual acks above the floor.'
          : ' With ack policy all, acks are cumulative, so the floor is exact.'),
      note: explicit ? 'May already be done out of order' : undefined
    }
  }

  // 5. Not delivered yet.
  return {
    state: 'not-delivered',
    label: 'Not delivered yet',
    tooltip: `Sequence ${message.seq} is above the last delivered sequence ${delivered}.`
  }
}

/** What to say about the whole stream above the list, from its retention policy. */
export function retentionNote(retention: StreamConfigDto['retention']): string | undefined {
  if (retention === 'workqueue')
    return 'On a work-queue stream a message is removed once its consumer acknowledges it (or, with ack policy none, once it is delivered), so a message you can still see has not been finished.'
  if (retention === 'interest')
    return 'On an interest stream a message is removed once every interested consumer has finished with it.'
  return undefined
}
