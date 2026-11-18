import { useMemo, type ReactNode } from 'react'
import { formatTime } from '@shared/format'
import { Badge } from '../../../components/ui'
import { DataTable, type Column } from '../../../components/DataTable'
import { CONSUMER_STATES } from '../../messages/MessageConsumers'
import { formatSpan, type TraceHop } from '../model/trace'
import type { TraceViewProps } from './types'

/** Consumer badges shown in a row; the rest are counted. */
const BADGES = 3

/** The gap since the previous message: a bar scaled to the largest gap, and the time as text. */
function Gap({ hop, max }: { hop: TraceHop; max: number }): ReactNode {
  if (hop.gapMs === null) return <span className="text-faint">start</span>
  const width = max > 0 ? Math.max(hop.gapMs > 0 ? 2 : 0, Math.round((hop.gapMs / max) * 100)) : 0
  return (
    <span className="flex items-center gap-2">
      <span
        className="h-2 w-16 shrink-0 overflow-hidden rounded-sm bg-raised"
        aria-hidden
        data-testid="gap-bar"
      >
        <span className="block h-full rounded-sm bg-accent" style={{ width: `${width}%` }} />
      </span>
      <span className="tabular text-xs whitespace-nowrap">+{formatSpan(hop.gapMs)}</span>
    </span>
  )
}

function Consumers({ hop }: { hop: TraceHop }): ReactNode {
  if (hop.consumers.length === 0) return <span className="text-faint">-</span>
  const shown = hop.consumers.slice(0, BADGES)
  const more = hop.consumers.length - shown.length
  return (
    <span className="flex items-center gap-1">
      {shown.map((c) => {
        const { Icon, tone } = CONSUMER_STATES[c.state]
        return (
          <Badge key={c.name} tone={tone} title={`${c.name}: ${c.label}. ${c.tooltip}`}>
            <Icon className="mr-1 h-3 w-3 shrink-0" aria-hidden />
            <span className="max-w-24 truncate">{c.name}</span>
            <span className="sr-only">: {c.label}</span>
          </Badge>
        )
      })}
      {more > 0 && (
        <span
          className="text-xs text-faint"
          title={hop.consumers
            .slice(BADGES)
            .map((c) => `${c.name}: ${c.label}`)
            .join('\n')}
        >
          +{more}
        </span>
      )}
    </span>
  )
}

/**
 * One row per message in time order (PBI-138). The gap bar makes the slow hop stand out. Rows are
 * virtualized by the shared table, which also gives the keyboard: arrows move the selection and
 * Enter opens the detail.
 */
export function TimelineView({ trace, selected, onSelect, onOpen }: TraceViewProps): ReactNode {
  // A trace within one day shows the time only (the date is in the tooltip).
  const oneDay = useMemo(
    () => new Set(trace.hops.map((h) => formatTime(h.message.time).slice(0, 10))).size <= 1,
    [trace.hops]
  )
  const columns = useMemo<Column<TraceHop>[]>(
    () => [
      {
        id: 'time',
        header: 'Time',
        width: oneDay ? '112px' : '188px',
        mono: true,
        cell: (h) => {
          const text = formatTime(h.message.time)
          return oneDay ? text.slice(11) : text
        },
        title: (h) =>
          `${formatTime(h.message.time)} (${new Date(h.message.time).toISOString()} UTC)`
      },
      {
        id: 'gap',
        header: 'Since previous',
        width: '160px',
        cell: (h) => <Gap hop={h} max={trace.maxGapMs} />
      },
      {
        id: 'stream',
        header: 'Stream',
        width: 'minmax(112px, 0.7fr)',
        cell: (h) => h.message.stream,
        title: (h) => h.message.stream
      },
      {
        id: 'subject',
        header: 'Subject',
        width: 'minmax(140px, 1.4fr)',
        mono: true,
        cell: (h) => h.message.subject,
        title: (h) => h.message.subject
      },
      {
        id: 'consumers',
        header: 'Consumers',
        width: 'minmax(130px, 1fr)',
        cell: (h) => <Consumers hop={h} />
      }
    ],
    [trace.maxGapMs, oneDay]
  )
  return (
    <DataTable
      ariaLabel="Trace timeline"
      rows={trace.hops}
      columns={columns}
      rowKey={(h) => h.id}
      selectedKey={selected}
      onSelect={(h) => onSelect(h.id)}
      onOpen={(h) => onOpen(h.id)}
      compact
    />
  )
}
