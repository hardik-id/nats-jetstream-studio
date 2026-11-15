import type { ConsumerInfoDto, MetricsSeries, StreamInfoDto } from '@shared/api'
import type { ConsumerSample } from '@shared/health'
import type { ManagedConnection } from './natsConnection'

export interface SamplerOptions {
  intervalMs: number
  /** How much history to keep. */
  retentionMs: number
  /** Streams and consumers that get history; beyond this only recently viewed ones are kept. */
  maxStreams: number
  maxConsumers: number
}

export const DEFAULT_SAMPLER_OPTIONS: SamplerOptions = {
  intervalMs: 5000,
  retentionMs: 60 * 60 * 1000,
  maxStreams: 500,
  maxConsumers: 2000
}

/** Fixed columns of numbers with a shared time axis. Old rows fall off the front. */
class Series {
  readonly t: number[] = []
  readonly cols: number[][]

  constructor(columns: number) {
    this.cols = Array.from({ length: columns }, () => [])
  }

  push(t: number, values: number[], maxRows: number): void {
    this.t.push(t)
    for (let i = 0; i < this.cols.length; i++) this.cols[i].push(values[i])
    while (this.t.length > maxRows) {
      this.t.shift()
      for (const col of this.cols) col.shift()
    }
  }

  /** Index of the first row at or after `since`. */
  indexSince(since: number): number {
    let i = 0
    while (i < this.t.length && this.t[i] < since) i++
    return i
  }
}

const key = (stream: string, consumer: string): string => `${stream}\u0000${consumer}`

/**
 * Samples stream and consumer counters while a connection is open (PBI-080).
 * History lives in memory only: it starts when the connection opens and is gone when it closes.
 */
export class MetricsSampler {
  latestStreams: StreamInfoDto[] = []
  latestConsumers: ConsumerInfoDto[] = []
  sampledAt = 0

  private readonly streams = new Map<string, Series>()
  private readonly consumers = new Map<string, Series>()
  private readonly watched = new Map<string, number>()
  private timer: ReturnType<typeof setInterval> | undefined
  private running = false
  private skip = 0
  private failures = 0

  constructor(
    private readonly conn: ManagedConnection,
    private readonly opts: SamplerOptions = DEFAULT_SAMPLER_OPTIONS,
    private readonly onTick?: (sampler: MetricsSampler, now: number) => void
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs)
    // Do not keep the process alive just for sampling.
    this.timer.unref?.()
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** Marks a stream as being looked at so it keeps history even on very large accounts. */
  watch(stream: string): void {
    this.watched.set(stream, Date.now())
  }

  private get maxRows(): number {
    return Math.max(2, Math.ceil(this.opts.retentionMs / this.opts.intervalMs))
  }

  async tick(now = Date.now()): Promise<void> {
    // Sampling stops while the connection is down; the gap shows up in the charts.
    if (this.running || this.conn.state.status !== 'connected') return
    if (this.skip > 0) {
      this.skip--
      return
    }
    this.running = true
    try {
      const jsm = await this.conn.jsm()
      const infos: StreamInfoDto[] = []
      for await (const info of jsm.streams.list()) infos.push(info as unknown as StreamInfoDto)

      const recently = now - this.opts.retentionMs
      const isWatched = (name: string): boolean => (this.watched.get(name) ?? 0) >= recently
      const ordered = [...infos].sort(
        (a, b) => Number(isWatched(b.config.name)) - Number(isWatched(a.config.name))
      )
      const chosen = ordered.slice(0, this.opts.maxStreams)

      const seenStreams = new Set<string>()
      for (const info of chosen) {
        const name = info.config.name
        seenStreams.add(name)
        let series = this.streams.get(name)
        if (!series) this.streams.set(name, (series = new Series(3)))
        series.push(now, [info.state.messages, info.state.bytes, info.state.last_seq], this.maxRows)
      }
      for (const name of this.streams.keys()) if (!seenStreams.has(name)) this.streams.delete(name)

      const consumers: ConsumerInfoDto[] = []
      const seenConsumers = new Set<string>()
      let budget = this.opts.maxConsumers
      for (const info of chosen) {
        if (budget <= 0) break
        if (info.state.consumer_count === 0) continue
        for await (const ci of jsm.consumers.list(info.config.name)) {
          const dto = ci as unknown as ConsumerInfoDto
          consumers.push(dto)
          const k = key(dto.stream_name, dto.name)
          seenConsumers.add(k)
          let series = this.consumers.get(k)
          if (!series) this.consumers.set(k, (series = new Series(3)))
          series.push(
            now,
            [dto.num_pending, dto.num_ack_pending, dto.num_redelivered],
            this.maxRows
          )
          if (--budget <= 0) break
        }
      }
      for (const k of this.consumers.keys()) if (!seenConsumers.has(k)) this.consumers.delete(k)

      this.latestStreams = infos
      this.latestConsumers = consumers
      this.sampledAt = now
      this.failures = 0
      this.onTick?.(this, now)
    } catch {
      // JetStream may be disabled for this account or the user may lack permission. Back off quietly.
      this.failures = Math.min(this.failures + 1, 6)
      this.skip = 2 ** this.failures - 1
    } finally {
      this.running = false
    }
  }

  streamSeries(stream: string, rangeMs: number, now = Date.now()): MetricsSeries {
    const series = this.streams.get(stream)
    const empty: MetricsSeries = {
      t: [],
      series: { messages: [], bytes: [], rate: [] },
      intervalMs: this.opts.intervalMs
    }
    if (!series) return empty
    const from = series.indexSince(now - rangeMs)
    const t = series.t.slice(from)
    const lastSeq = series.cols[2]
    const rate: number[] = []
    for (let i = from; i < series.t.length; i++) {
      if (i === 0) {
        rate.push(0)
        continue
      }
      const seconds = (series.t[i] - series.t[i - 1]) / 1000
      rate.push(seconds > 0 ? Math.max(0, (lastSeq[i] - lastSeq[i - 1]) / seconds) : 0)
    }
    return {
      t,
      series: { messages: series.cols[0].slice(from), bytes: series.cols[1].slice(from), rate },
      intervalMs: this.opts.intervalMs
    }
  }

  consumerSeries(
    stream: string,
    consumer: string,
    rangeMs: number,
    now = Date.now()
  ): MetricsSeries {
    const series = this.consumers.get(key(stream, consumer))
    if (!series) {
      return {
        t: [],
        series: { pending: [], ackPending: [], redelivered: [] },
        intervalMs: this.opts.intervalMs
      }
    }
    const from = series.indexSince(now - rangeMs)
    return {
      t: series.t.slice(from),
      series: {
        pending: series.cols[0].slice(from),
        ackPending: series.cols[1].slice(from),
        redelivered: series.cols[2].slice(from)
      },
      intervalMs: this.opts.intervalMs
    }
  }

  /** The most recent samples for one consumer, oldest first. Used by the health rules. */
  consumerSamples(stream: string, consumer: string, count: number): ConsumerSample[] {
    const series = this.consumers.get(key(stream, consumer))
    if (!series) return []
    const from = Math.max(0, series.t.length - count)
    const out: ConsumerSample[] = []
    for (let i = from; i < series.t.length; i++) {
      out.push({
        t: series.t[i],
        pending: series.cols[0][i],
        ackPending: series.cols[1][i],
        redelivered: series.cols[2][i]
      })
    }
    return out
  }
}
