import type { ConsumerInfoDto } from '@shared/api'
import { messageConsumerStatus, type MessageConsumerState } from '@shared/messageConsumers'
import type { TraceMessage } from '@shared/trace'

/** The id of a message in a trace: a stream sequence is only unique within its stream. */
export function messageId(m: Pick<TraceMessage, 'stream' | 'seq'>): string {
  return `${m.stream}#${m.seq}`
}

/** Where one consumer stands with one message, short enough for a badge. */
export interface ConsumerBadge {
  name: string
  state: MessageConsumerState
  label: string
  tooltip: string
}

/** One hop of the trace. */
export interface TraceHop {
  id: string
  message: TraceMessage
  /** Milliseconds since the previous message; null for the first. */
  gapMs: number | null
  /** Milliseconds since the first message. */
  offsetMs: number
  /** Consumers that did or will receive the message (those it is not for are left out). */
  consumers: ConsumerBadge[]
}

export interface Trace {
  hops: TraceHop[]
  /** The largest gap, which the gap bars are scaled to. */
  maxGapMs: number
  /** First message to last. */
  durationMs: number
  streams: string[]
  /** Distinct subjects. */
  subjects: number
}

/** Consumers by stream name; a stream that is not in it has not been read (yet). */
export type ConsumersByStream = Readonly<Record<string, readonly ConsumerInfoDto[] | undefined>>

/** The consumers that matter for a message: not "not for this consumer", not "before its start". */
const RELEVANT: ReadonlySet<MessageConsumerState> = new Set([
  'done',
  'waiting-ack',
  'not-delivered'
])

/**
 * Turns the messages of a trace (already in time order, see `mergeMessages`) into hops: the gap
 * since the previous message, the offset from the first, and the consumers that have the message.
 * Pure: the consumers are passed in, so this runs without a server.
 */
export function buildTrace(
  messages: readonly TraceMessage[],
  consumers: ConsumersByStream = {}
): Trace {
  const hops = messages.map((message, i): TraceHop => {
    const badges: ConsumerBadge[] = []
    for (const c of consumers[message.stream] ?? []) {
      const status = messageConsumerStatus(message, c)
      if (RELEVANT.has(status.state))
        badges.push({
          name: c.name,
          state: status.state,
          label: status.label,
          tooltip: status.tooltip
        })
    }
    return {
      id: messageId(message),
      message,
      gapMs: i === 0 ? null : Math.max(0, message.ms - messages[i - 1].ms),
      offsetMs: message.ms - messages[0].ms,
      consumers: badges
    }
  })
  return {
    hops,
    maxGapMs: hops.reduce((max, h) => Math.max(max, h.gapMs ?? 0), 0),
    durationMs: hops.length ? hops[hops.length - 1].offsetMs : 0,
    streams: [...new Set(messages.map((m) => m.stream))],
    subjects: new Set(messages.map((m) => m.subject)).size
  }
}

/**
 * The index of the message after the slowest hop: the largest gap (the first one on a tie). Null
 * unless there are at least three messages (two gaps) and the largest gap is longer than the
 * smallest, because a single gap, or equal gaps, have no slowest one. The views that mark the slowest hop use this, so
 * they always agree.
 */
export function slowestHop(hops: readonly Pick<TraceHop, 'gapMs'>[]): number | null {
  let slowest: number | null = null
  let most = 0
  let least = Infinity
  hops.forEach((h, i) => {
    if (h.gapMs === null) return
    least = Math.min(least, h.gapMs)
    if (h.gapMs > most) {
      most = h.gapMs
      slowest = i
    }
  })
  return hops.length < 3 || most <= least ? null : slowest
}

/** A span of time as text: `850 ms`, `1.4 s`, `2 min 5 s`, `1 h 3 min`, `2 d 4 h`. */
export function formatSpan(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} s`
  const min = Math.floor(s / 60)
  if (min < 60) return s % 60 ? `${min} min ${s % 60} s` : `${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`
  const d = Math.floor(h / 24)
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`
}
