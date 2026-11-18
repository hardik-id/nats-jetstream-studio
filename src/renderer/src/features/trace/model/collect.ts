import type { ScanRequest, NatsGateway } from '@shared/api'
import {
  DEFAULT_MATCH_CAP,
  ruleToCondition,
  scanLimitOf,
  windowFor,
  type TraceMessage,
  type TraceQuery
} from '@shared/trace'
import { isSystemStream } from '../../subjects/subjectTree'

/** What `runTrace` needs of the gateway: the stream list and the scan stream. */
export type TraceGateway = Pick<NatsGateway, 'open' | 'listStreams'>

export type StreamState = 'waiting' | 'scanning' | 'done' | 'error'

/** How far one stream is. Kept apart per stream, so one failing stream does not hide the others. */
export interface StreamProgress {
  stream: string
  state: StreamState
  scanned: number
  matched: number
  /** Why the stream may hold more matches than shown: its scan limit or the match cap was hit. */
  partial?: 'limit' | 'cap'
  error?: string
}

export interface TraceResult {
  /** De-duplicated by (stream, seq) and sorted by time, then stream, then sequence. */
  messages: TraceMessage[]
  streams: StreamProgress[]
  cancelled: boolean
}

export interface RunOptions {
  /** Called with every stream's progress each time one changes. */
  onProgress?: (streams: StreamProgress[]) => void
  signal?: AbortSignal
  /** The time "last 1 h" counts back from. */
  now?: number
  /** Scans running at once (default 3). */
  concurrency?: number
  /** Most matches kept per stream and rule (default 500). */
  matchCap?: number
}

export const DEFAULT_CONCURRENCY = 3

/** The streams a query searches: the ones it names, or every stream but the system ones. */
export async function streamsToSearch(
  gateway: TraceGateway,
  connId: string,
  query: TraceQuery
): Promise<string[]> {
  if (query.streams && query.streams.length > 0) return query.streams
  const all = (await gateway.listStreams(connId)).map((s) => s.config.name).sort()
  return query.includeSystem ? all : all.filter((n) => !isSystemStream(n))
}

/** Orders messages by time, then stream, then sequence. */
export function compareMessages(a: TraceMessage, b: TraceMessage): number {
  return a.ms - b.ms || a.stream.localeCompare(b.stream) || a.seq - b.seq
}

/** Merges lists of messages: the same (stream, seq) once, in trace order. */
export function mergeMessages(lists: readonly (readonly TraceMessage[])[]): TraceMessage[] {
  const seen = new Map<string, TraceMessage>()
  for (const list of lists)
    for (const m of list)
      if (!seen.has(`${m.stream}\u0000${m.seq}`)) seen.set(`${m.stream}\u0000${m.seq}`, m)
  return [...seen.values()].sort(compareMessages)
}

interface Job {
  stream: string
  rule: number
}

/**
 * Finds the messages of a trace: one scan per stream and per rule, a few at a time. A scan reads
 * with the get-message APIs and no consumer. Rules are ORed by merging what each one found. A
 * stream whose scan fails is reported in `streams` and the others carry on. Aborting the signal
 * stops the scans and returns what was found so far.
 */
export async function runTrace(
  gateway: TraceGateway,
  connId: string,
  query: TraceQuery,
  options: RunOptions = {}
): Promise<TraceResult> {
  const { signal, onProgress } = options
  const cap = options.matchCap ?? DEFAULT_MATCH_CAP
  const names = await streamsToSearch(gateway, connId, query)
  const window = windowFor(query.window, options.now ?? Date.now())
  const from = new Date(window.from).getTime()
  const to = window.to ? new Date(window.to).getTime() : Number.POSITIVE_INFINITY
  const scanLimit = scanLimitOf(query)
  const conditions = query.rules.map(ruleToCondition)

  const progress = new Map<string, StreamProgress>(
    names.map((stream) => [stream, { stream, state: 'waiting', scanned: 0, matched: 0 }])
  )
  const jobs: Job[] = names.flatMap((stream) => conditions.map((_, rule) => ({ stream, rule })))
  // Per job: what it found so far and where it stands, summed into the stream's progress.
  const found = new Map<Job, TraceMessage[]>()
  const counts = new Map<Job, { scanned: number; running: boolean }>()
  const report = (): void => onProgress?.(names.map((n) => ({ ...progress.get(n)! })))

  const refresh = (stream: string): void => {
    const mine = jobs.filter((j) => j.stream === stream)
    const p = progress.get(stream)!
    p.scanned = mine.reduce((n, j) => n + (counts.get(j)?.scanned ?? 0), 0)
    p.matched = mergeMessages(mine.map((j) => found.get(j) ?? [])).length
    if (p.state === 'waiting' && mine.some((j) => counts.has(j))) p.state = 'scanning'
    if (mine.every((j) => counts.get(j) && !counts.get(j)!.running) && !signal?.aborted)
      p.state = p.error ? 'error' : 'done'
  }

  const runJob = (job: Job): Promise<void> =>
    new Promise((resolve) => {
      const list: TraceMessage[] = []
      found.set(job, list)
      const count = { scanned: 0, running: true }
      counts.set(job, count)
      const p = progress.get(job.stream)!
      const request: ScanRequest = {
        direction: 'asc',
        start: { kind: 'time', time: window.from },
        until: window.to,
        limit: cap,
        scanLimit,
        filters: { conditions: [conditions[job.rule]] }
      }
      let stop: () => void = () => {}
      const finish = (): void => {
        if (!count.running) return
        count.running = false
        signal?.removeEventListener('abort', onAbort)
        refresh(job.stream)
        report()
        resolve()
      }
      const onAbort = (): void => {
        stop()
        finish()
      }
      if (signal?.aborted) return finish()
      signal?.addEventListener('abort', onAbort, { once: true })
      stop = gateway.open('scan', { connId, stream: job.stream, request }, (event) => {
        if (!count.running) return
        if (event.type === 'matches') {
          for (const m of event.messages) {
            const ms = new Date(m.time).getTime()
            // A time start past the last message clamps to it: keep only what is in the window.
            if (ms >= from && ms <= to) list.push({ ...m, stream: job.stream, ms })
          }
        } else if (event.type === 'progress') {
          count.scanned = event.scanned
        } else if (event.type === 'done') {
          count.scanned = event.scanned
          if (event.reason === 'limit') p.partial = 'limit'
          else if (event.reason === 'page' && !p.partial) p.partial = 'cap'
          if (event.reason === 'error') p.error = event.error?.message ?? 'The scan failed'
          finish()
          return
        } else if ((event as { type: string }).type === 'error') {
          p.error =
            (event as unknown as { error?: { message?: string } }).error?.message ??
            'The scan failed'
          finish()
          return
        }
        refresh(job.stream)
        report()
      })
      // A stream that opened and finished while `open` ran is already done; closing is harmless.
      if (!count.running) stop()
    })

  report()
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < jobs.length && !signal?.aborted) await runJob(jobs[next++])
  }
  const workers = Math.max(1, Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, jobs.length))
  await Promise.all(Array.from({ length: workers }, worker))

  const streams = names.map((n) => ({ ...progress.get(n)! }))
  return {
    messages: mergeMessages([...found.values()]),
    streams,
    cancelled: signal?.aborted ?? false
  }
}
