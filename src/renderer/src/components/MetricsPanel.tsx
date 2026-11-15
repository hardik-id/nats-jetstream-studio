import { useState, type ReactNode } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import type { MetricsTarget } from '@shared/api'
import { formatBytes, formatRate, formatTime } from '@shared/format'
import { useGateway } from '../gateway'
import { useRefetchInterval } from '../lib/hooks'
import { byteTick, byteTicks, compactNumber, LineChart } from './LineChart'
import { Card, cx, ErrorNote } from './ui'

const RANGES: { label: string; ms: number }[] = [
  { label: '5 min', ms: 5 * 60_000 },
  { label: '15 min', ms: 15 * 60_000 },
  { label: '1 hour', ms: 60 * 60_000 }
]

interface SeriesSpec {
  key: string
  title: string
  format: (v: number) => string
  formatTick?: (v: number) => string
  ticksFor?: (max: number) => number[]
}

const SERIES: Record<MetricsTarget['kind'], SeriesSpec[]> = {
  stream: [
    {
      key: 'rate',
      title: 'Messages per second',
      format: formatRate,
      formatTick: (v) => `${Number(v.toFixed(2))}/s`
    },
    { key: 'messages', title: 'Messages stored', format: compactNumber },
    {
      key: 'bytes',
      title: 'Bytes stored',
      format: formatBytes,
      formatTick: byteTick,
      ticksFor: byteTicks
    }
  ],
  consumer: [
    { key: 'pending', title: 'Pending (not yet delivered)', format: compactNumber },
    {
      key: 'ackPending',
      title: 'Ack pending (delivered, not acknowledged)',
      format: compactNumber
    },
    { key: 'redelivered', title: 'Redelivered', format: compactNumber }
  ]
}

/**
 * Charts for a stream or a consumer (PBI-080). Samples are taken by the gateway while the
 * connection is open and kept in memory for an hour; nothing is stored on disk.
 */
export function MetricsPanel({
  connId,
  target
}: {
  connId: string
  target: MetricsTarget
}): ReactNode {
  const gateway = useGateway()
  const [range, setRange] = useState(RANGES[0].ms)
  const [table, setTable] = useState(false)
  const refetchInterval = useRefetchInterval()
  const query = useQuery({
    queryKey: ['metrics', connId, target, range],
    queryFn: () => gateway.metrics(connId, target, range),
    refetchInterval,
    // Keep the previous render while the next sample loads, so the charts never flash.
    placeholderData: keepPreviousData
  })
  const data = query.data
  // The window ends at the newest sample, or at the time the data was fetched when there is none.
  const lastSample = data?.t.length ? data.t[data.t.length - 1] : 0
  const to = Math.max(query.dataUpdatedAt, lastSample)
  const from = to - range

  return (
    <Card
      title="Activity"
      actions={
        <>
          <div
            role="group"
            aria-label="Time range"
            className="flex gap-0.5 rounded-md bg-raised p-0.5"
          >
            {RANGES.map((r) => (
              <button
                key={r.ms}
                aria-pressed={r.ms === range}
                onClick={() => setRange(r.ms)}
                className={cx(
                  'rounded px-2 py-0.5 text-xs font-medium',
                  r.ms === range ? 'bg-panel text-fg shadow-sm' : 'text-muted hover:text-fg'
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
          <button
            aria-pressed={table}
            onClick={() => setTable((v) => !v)}
            className="rounded px-2 py-0.5 text-xs font-medium text-muted hover:text-fg"
          >
            {table ? 'Charts' : 'Table'}
          </button>
        </>
      }
    >
      <ErrorNote error={query.error} />
      {data && !table && (
        <div
          className={cx(
            'grid grid-cols-1 gap-x-6 gap-y-4 xl:grid-cols-3',
            query.isPlaceholderData && 'opacity-60'
          )}
        >
          {SERIES[target.kind].map((s) => (
            <LineChart
              key={s.key}
              title={s.title}
              t={data.t}
              values={data.series[s.key] ?? []}
              intervalMs={data.intervalMs}
              from={from}
              to={to}
              format={s.format}
              formatTick={s.formatTick}
              ticksFor={s.ticksFor}
            />
          ))}
        </div>
      )}
      {data && table && (
        <div className="max-h-64 overflow-auto">
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0 bg-panel">
              <tr>
                <th className="py-1 pr-3 text-left font-semibold text-muted">Time</th>
                {SERIES[target.kind].map((s) => (
                  <th key={s.key} className="py-1 pl-3 text-right font-semibold text-muted">
                    {s.title}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.t
                .map((_, i) => i)
                .reverse()
                .map((i) => (
                  <tr key={data.t[i]} className="border-t border-line">
                    <td className="tabular py-1 pr-3">{formatTime(data.t[i])}</td>
                    {SERIES[target.kind].map((s) => (
                      <td key={s.key} className="tabular py-1 pl-3 text-right">
                        {s.format(data.series[s.key]?.[i] ?? 0)}
                      </td>
                    ))}
                  </tr>
                ))}
              {data.t.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-3 text-center text-faint">
                    Collecting samples...
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <p className="pt-2 text-xs text-faint">
        Sampled every {Math.round((data?.intervalMs ?? 5000) / 1000)} seconds while this connection
        is open. History is kept in memory for one hour and starts again after a reconnect.
      </p>
    </Card>
  )
}
