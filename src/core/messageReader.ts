import type { JetStreamManager, StoredMsg } from '@nats-io/jetstream'
import { versionAtLeast } from '@shared/semver'

/**
 * Reads stored messages without creating a consumer (PBI-040).
 *
 * Everything goes through the get-message APIs, so nothing is acknowledged and no consumer state is
 * touched. That also makes it safe on WorkQueue and Interest streams, where creating a consumer
 * would either be refused or change what the stream keeps.
 *
 * Three ways to read, fastest first:
 *   batch   one direct-get request returns many messages (server 2.11+, stream allows direct get)
 *   direct  one direct-get request per message (stream allows direct get)
 *   api     one $JS.API.STREAM.MSG.GET request per message (always available)
 *
 * All three accept "the first message at or after this sequence matching this subject", which is
 * what lets the reader skip deleted messages and filter by subject on the server.
 */
export type ReadMode = 'batch' | 'direct' | 'api'

export interface StreamBounds {
  firstSeq: number
  lastSeq: number
  messages: number
}

const BATCH_SIZE = 200
/** Most messages collected from one backwards window before it is narrowed. */
const WINDOW_CAP = 256
const MAX_WINDOW = 1 << 20

function isNoMessage(err: unknown): boolean {
  const e = err as { code?: number; message?: string } | undefined
  return e?.code === 404 || /message not found|no results/i.test(e?.message ?? '')
}

export function pickReadMode(
  allowDirect: boolean | undefined,
  serverVersion: string | undefined
): ReadMode {
  if (!allowDirect) return 'api'
  return versionAtLeast(serverVersion, '2.11.0') ? 'batch' : 'direct'
}

export class MessageReader {
  constructor(
    private readonly jsm: JetStreamManager,
    private readonly stream: string,
    readonly mode: ReadMode
  ) {}

  /** The first message with sequence >= `seq` on a matching subject, or null when there is none. */
  async next(seq: number, subject?: string): Promise<StoredMsg | null> {
    const query = { seq, next_by_subj: subject || '>' }
    if (this.mode === 'api') {
      // The plain API takes the same request shape as direct get; the client's type just omits it.
      return this.jsm.streams.getMessage(this.stream, query as unknown as { seq: number })
    }
    return this.jsm.direct.getMessage(this.stream, query)
  }

  /**
   * Messages with `from <= seq < until` on a matching subject, oldest first.
   * `until` may be omitted to read to the end of the stream.
   */
  async *forward(
    from: number,
    until: number | undefined,
    subject: string | undefined,
    hint = BATCH_SIZE
  ): AsyncGenerator<StoredMsg> {
    let seq = Math.max(1, from)
    const end = until ?? Number.MAX_SAFE_INTEGER

    if (this.mode === 'batch') {
      let size = Math.min(Math.max(hint, 16), BATCH_SIZE)
      while (seq < end) {
        const batch: StoredMsg[] = []
        try {
          const iter = await this.jsm.direct.getBatch(this.stream, {
            seq,
            batch: size,
            next_by_subj: subject || '>'
          })
          for await (const msg of iter) batch.push(msg)
        } catch (err) {
          // "No message at or after this sequence" arrives as a 404 status, not as an empty batch.
          if (!isNoMessage(err)) throw err
        }
        if (batch.length === 0) return
        for (const msg of batch) {
          if (msg.seq >= end) return
          yield msg
        }
        if (batch.length < size) return
        seq = batch[batch.length - 1].seq + 1
        size = BATCH_SIZE
      }
      return
    }

    while (seq < end) {
      const msg = await this.next(seq, subject)
      if (!msg || msg.seq >= end) return
      yield msg
      seq = msg.seq + 1
    }
  }

  /**
   * Messages with `seq < before` on a matching subject, newest first.
   *
   * The server cannot walk backwards, so this reads windows of sequences forwards and reverses
   * them. Windows grow while they come back sparse (a rare subject in a big stream) and are halved
   * when they hold too many matches, so memory and requests stay bounded either way.
   */
  async *backward(
    before: number,
    firstSeq: number,
    subject: string | undefined,
    hint = 64
  ): AsyncGenerator<StoredMsg> {
    let hi = before
    let window = Math.min(Math.max(hint, 16), WINDOW_CAP)
    while (hi > firstSeq) {
      let lo = Math.max(firstSeq, hi - window)
      let found: StoredMsg[]
      for (;;) {
        found = []
        for await (const msg of this.forward(lo, hi, subject, WINDOW_CAP + 1)) {
          found.push(msg)
          if (found.length > WINDOW_CAP) break
        }
        if (found.length <= WINDOW_CAP || hi - lo <= 1) break
        // Too dense: keep only the newer half of the window and read it again.
        lo += Math.ceil((hi - lo) / 2)
      }
      for (let i = found.length - 1; i >= 0; i--) yield found[i]
      if (found.length < window / 4) window = Math.min(window * 4, MAX_WINDOW)
      hi = lo
    }
  }

  /**
   * The lowest sequence whose message was stored at or after `time`.
   * Returns `lastSeq + 1` when every message is older. Uses a binary search, which works on any
   * server version and costs about log2(messages) requests.
   */
  async seqForTime(time: Date, bounds: StreamBounds): Promise<number> {
    const target = time.getTime()
    let lo = bounds.firstSeq
    let hi = bounds.lastSeq + 1
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2)
      const msg = await this.next(mid)
      if (!msg || msg.seq >= hi || msg.time.getTime() >= target) {
        hi = mid
      } else {
        lo = msg.seq + 1
      }
    }
    return lo
  }
}
