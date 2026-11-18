import { type ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, Loader2, Route, XCircle } from 'lucide-react'
import { formatCount } from '@shared/format'
import { scanLimitOf, type TraceQuery } from '@shared/trace'
import { Button, EmptyState, Notice } from '../../components/ui'
import type { StreamProgress } from './model/collect'

/** What a trace is, with an example: shown before the first run. */
export function NothingRun(): ReactNode {
  return (
    <EmptyState
      icon={<Route className="h-10 w-10" aria-hidden />}
      title="Follow a request across streams"
    >
      <p>
        Give a value that travels with a request, such as a trace id in a header or an order id in
        the payload. The studio finds every stored message that carries it, in every stream, and
        lists them in time order with the consumers that received each one.
      </p>
      <p className="mt-2">
        For example: Header <span className="font-mono text-xs">trace-id</span> ={' '}
        <span className="font-mono text-xs">4f2a9c</span>, or JSON field{' '}
        <span className="font-mono text-xs">$.order.id</span> ={' '}
        <span className="font-mono text-xs">A-1042</span>. You can also open a message in Messages
        and press Follow next to a header or a field.
      </p>
      <p className="mt-2 text-xs text-faint">
        Only messages stored in JetStream are seen, and the order between streams is by the time
        they were stored.
      </p>
    </EmptyState>
  )
}

/** Per-stream progress while a trace runs, with Cancel. */
export function ScanProgress({
  streams,
  onCancel
}: {
  streams: StreamProgress[]
  onCancel: () => void
}): ReactNode {
  const finished = streams.filter((s) => s.state === 'done' || s.state === 'error').length
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 p-6" data-testid="trace-progress">
      <div className="flex items-center gap-3">
        <span role="status" className="flex items-center gap-2 font-medium">
          <Loader2 className="spin h-4 w-4" aria-hidden />
          Searching {streams.length} {streams.length === 1 ? 'stream' : 'streams'} ({finished} done)
        </span>
        <Button className="ml-auto" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <ul className="divide-y divide-line rounded-md border border-line">
        {streams.map((s) => (
          <li key={s.stream} className="flex items-center gap-3 px-3 py-1.5 text-[13px]">
            <StateIcon state={s.state} />
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{s.stream}</span>
            <span className="tabular text-xs text-muted">
              {s.state === 'waiting'
                ? 'waiting'
                : `${formatCount(s.scanned)} read, ${formatCount(s.matched)} found`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function StateIcon({ state }: { state: StreamProgress['state'] }): ReactNode {
  switch (state) {
    case 'done':
      return <CheckCircle2 className="h-4 w-4 shrink-0 text-ok" aria-label="Done" />
    case 'error':
      return <XCircle className="h-4 w-4 shrink-0 text-danger" aria-label="Failed" />
    case 'scanning':
      return <Loader2 className="spin h-4 w-4 shrink-0 text-accent" aria-label="Searching" />
    default:
      return <span className="h-4 w-4 shrink-0" aria-hidden />
  }
}

/** Nothing matched: say where it looked and suggest a wider window. */
export function NoMatches({
  streams,
  cancelled
}: {
  streams: StreamProgress[]
  cancelled: boolean
}): ReactNode {
  const scanned = streams.reduce((n, s) => n + s.scanned, 0)
  return (
    <EmptyState
      icon={<Route className="h-10 w-10" aria-hidden />}
      title={cancelled ? 'Cancelled before anything was found' : 'No message matches'}
    >
      <p>
        {formatCount(scanned)} messages were read in {streams.length}{' '}
        {streams.length === 1 ? 'stream' : 'streams'}.
      </p>
      <p className="mt-1">
        Try a wider window (Last 7 days, or ±1 h around the message), check the spelling of the name
        and the value, or include more streams. Messages that have already expired or been deleted
        cannot be found.
      </p>
    </EmptyState>
  )
}

/**
 * What the result leaves out or could not read: streams that stopped at their scan limit or at the
 * match cap (partial), and streams that failed. The streams that worked are shown regardless.
 */
export function StreamNotices({
  streams,
  query,
  cancelled,
  matchCap,
  onScanMore
}: {
  streams: StreamProgress[]
  query: TraceQuery
  /** The run was cancelled: the streams that did not finish were not searched. */
  cancelled: boolean
  /** The cap the run used (matches kept per stream and rule). */
  matchCap: number
  onScanMore: () => void
}): ReactNode {
  const limited = streams.filter((s) => s.partial === 'limit')
  const capped = streams.filter((s) => s.partial === 'cap')
  const failed = streams.filter((s) => s.error)
  if (!cancelled && limited.length + capped.length + failed.length === 0) return null
  return (
    <div className="flex flex-col gap-2 border-b border-line px-4 py-2" data-testid="trace-notices">
      {cancelled && (
        <Notice tone="warn" className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
          <span>{cancelledText(streams)}. Matches in the other streams may be missing.</span>
        </Notice>
      )}
      {limited.length > 0 && (
        <Notice tone="warn" className="flex flex-wrap items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">
            Partial result: {names(limited)} stopped at the scan limit of{' '}
            {formatCount(scanLimitOf(query))} messages, so older or later matches may be missing.
          </span>
          <Button size="sm" onClick={onScanMore}>
            Scan more
          </Button>
        </Notice>
      )}
      {capped.length > 0 && (
        <Notice tone="warn" className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
          <span>
            Partial result: {names(capped)} has more than {matchCap} matches. The first {matchCap}{' '}
            are shown; narrow the window or the value to see the rest.
          </span>
        </Notice>
      )}
      {failed.map((s) => (
        <Notice key={s.stream} tone="danger" className="flex items-center gap-2">
          <XCircle className="h-4 w-4 shrink-0" aria-hidden />
          <span className="min-w-0 break-words">
            <span className="font-mono text-xs">{s.stream}</span> could not be searched: {s.error}.
            The other streams are shown.
          </span>
        </Notice>
      ))}
    </div>
  )
}

/** "Cancelled: 2 of 5 streams were searched". */
export function cancelledText(streams: StreamProgress[]): string {
  const done = streams.filter((s) => s.state === 'done').length
  return `Cancelled: ${done} of ${streams.length} ${streams.length === 1 ? 'stream was' : 'streams were'} searched`
}

function names(streams: StreamProgress[]): ReactNode {
  return streams.map((s, i) => (
    <span key={s.stream}>
      {i > 0 && ', '}
      <span className="font-mono text-xs">{s.stream}</span>
    </span>
  ))
}
