import { useEffect, useState, useSyncExternalStore } from 'react'
import type { TraceMessage, TraceQuery } from '@shared/trace'
import { runTrace, type StreamProgress, type TraceGateway } from './model/collect'

export type TraceStatus = 'idle' | 'scanning' | 'done' | 'cancelled' | 'failed'

/** Everything the screen shows about the last run. The tab spec holds the query, not this. */
export interface TraceRunState {
  status: TraceStatus
  streams: StreamProgress[]
  messages: TraceMessage[]
  /** A failure that is not one stream's (the stream list could not be read). */
  error?: string
  /** When the run started: what a "last 24 h" window counted back from. */
  startedAt?: number
}

const IDLE: TraceRunState = { status: 'idle', streams: [], messages: [] }

/**
 * Runs one trace at a time and keeps its state outside React, so that starting a run from an
 * effect sets no state in the effect and a stale run can never overwrite a newer one.
 */
export class TraceRunner {
  private state: TraceRunState = IDLE
  private listeners = new Set<() => void>()
  private abort: AbortController | null = null
  private last: TraceQuery | null = null

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  getSnapshot = (): TraceRunState => this.state

  private set(state: TraceRunState): void {
    this.state = state
    for (const l of this.listeners) l()
  }

  /** Runs `query` unless it is the one already run (the same object): the effect can call this freely. */
  ensure(gateway: TraceGateway, connId: string, query: TraceQuery): void {
    if (this.last !== query) this.start(gateway, connId, query)
  }

  /** Runs `query` now, stopping a run that is still going. */
  start(gateway: TraceGateway, connId: string, query: TraceQuery): void {
    this.abort?.abort()
    const abort = new AbortController()
    this.abort = abort
    this.last = query
    const startedAt = Date.now()
    this.set({ status: 'scanning', streams: [], messages: [], startedAt })
    const current = (): boolean => this.abort === abort
    runTrace(gateway, connId, query, {
      signal: abort.signal,
      now: startedAt,
      onProgress: (streams) => {
        if (current()) this.set({ ...this.state, streams })
      }
    })
      .then((result) => {
        if (!current()) return
        this.set({
          status: result.cancelled ? 'cancelled' : 'done',
          streams: result.streams,
          messages: result.messages,
          startedAt
        })
      })
      .catch((err: unknown) => {
        if (!current()) return
        this.set({
          status: 'failed',
          streams: [],
          messages: [],
          startedAt,
          error: err instanceof Error ? err.message : String(err)
        })
      })
  }

  /** Stops the run; what was found so far stays. */
  cancel(): void {
    this.abort?.abort()
  }

  /** Forgets the last query, so that `ensure` runs it again. */
  reset(): void {
    this.cancel()
    this.abort = null
    this.last = null
  }
}

/**
 * The run state of a Trace tab and the ways to change it. This hook, with the effect in
 * `TraceTab`, is the only place a trace is started; views only draw what it hands them.
 */
export function useTrace(): {
  runner: TraceRunner
  state: TraceRunState
} {
  const [runner] = useState(() => new TraceRunner())
  const state = useSyncExternalStore(runner.subscribe, runner.getSnapshot)
  // A closed tab stops its scans. (In development the effect runs twice: the runner starts again.)
  useEffect(() => () => runner.reset(), [runner])
  return { runner, state }
}
