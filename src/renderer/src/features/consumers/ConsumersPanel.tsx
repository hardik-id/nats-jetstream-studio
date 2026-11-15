import { useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Plus, RefreshCw } from 'lucide-react'
import type { ConsumerInfoDto } from '@shared/api'
import { formatAgo, formatCount } from '@shared/format'
import type { HealthFlag } from '@shared/api'
import { HEALTH_LABELS } from '@shared/health'
import { DataTable, type Column } from '../../components/DataTable'
import { StarButton } from '../../components/StarButton'
import {
  Badge,
  Button,
  Checkbox,
  ErrorNote,
  Input,
  readOnlyProps,
  Spinner
} from '../../components/ui'
import { useGateway } from '../../gateway'
import { useConnection, useNow, useRefetchInterval } from '../../lib/hooks'
import { useTabs } from '../../state/tabs'
import { ConsumerForm } from './ConsumerForm'

export function consumerFilters(c: ConsumerInfoDto): string[] {
  return c.config.filter_subjects?.length
    ? c.config.filter_subjects
    : c.config.filter_subject
      ? [c.config.filter_subject]
      : []
}

const HEALTH_BADGE_TEXT: Partial<Record<HealthFlag, string>> = {
  lag_growing: 'Lagging',
  stalled: 'Inactive'
}

/** Status badges for one consumer: Paused, one per problem found, or Healthy. */
export function HealthBadges({ c }: { c: ConsumerInfoDto }): ReactNode {
  const flags = c.health ?? []
  if (!c.paused && flags.length === 0)
    return (
      <Badge status="ok" title="No problems found">
        Healthy
      </Badge>
    )
  // One badge, then "+N" for the rest: the cell stays one line and nothing is clipped. The full
  // list is in the tooltip.
  const items: { key: string; status: 'neutral' | 'warn'; text: string; hint: string }[] = [
    ...(c.paused
      ? [{ key: 'paused', status: 'neutral' as const, text: 'Paused', hint: 'Delivery is paused' }]
      : []),
    ...flags.map((f) => ({
      key: f,
      status: 'warn' as const,
      text: HEALTH_BADGE_TEXT[f] ?? HEALTH_LABELS[f],
      hint: HEALTH_LABELS[f]
    }))
  ]
  const [first, ...rest] = items
  const all = items.map((i) => i.hint).join(', ')
  return (
    <span className="flex items-center gap-1" title={all}>
      <Badge status={first.status} title={all}>
        {first.text}
      </Badge>
      {rest.length > 0 && (
        <span
          className="text-xs whitespace-nowrap text-muted"
          aria-label={`and ${rest.length} more: ${all}`}
        >
          +{rest.length}
        </span>
      )}
    </span>
  )
}

/** The figures of the summary cards. Consumers that KV and Object Store create are left out. */
export function consumerTotals(list: ConsumerInfoDto[]): {
  pending: number
  ackPending: number
  attention: number
} {
  let pending = 0
  let ackPending = 0
  let attention = 0
  for (const c of list) {
    if (c.stream_name.startsWith('KV_') || c.stream_name.startsWith('OBJ_')) continue
    pending += c.num_pending
    ackPending += c.num_ack_pending
    if ((c.health?.length ?? 0) > 0) attention++
  }
  return { pending, ackPending, attention }
}

function SummaryCard({
  label,
  value,
  hint,
  warn
}: {
  label: string
  value: string
  hint: string
  warn?: boolean
}): ReactNode {
  return (
    <div
      className={
        'min-w-40 flex-1 rounded-md border px-3 py-2 ' +
        (warn ? 'border-warn bg-warn-soft' : 'border-line bg-raised')
      }
      data-testid="summary-card"
    >
      <div className="text-xs text-faint">{label}</div>
      <div className={'text-xl font-semibold tabular-nums ' + (warn ? 'text-warn' : 'text-fg')}>
        {value}
      </div>
      <div className="text-xs text-faint">{hint}</div>
    </div>
  )
}

export function lastActive(c: ConsumerInfoDto): string | undefined {
  const times = [c.delivered?.last_active, c.ack_floor?.last_active].filter(
    (t): t is string => !!t && !t.startsWith('0001')
  )
  return times.sort().at(-1)
}

/**
 * The consumers of one stream, or of every stream when `stream` is left out (PBI-050).
 * Unhealthy consumers carry a badge and can be shown on their own (PBI-054).
 */
export function ConsumersPanel({ connId, stream }: { connId: string; stream?: string }): ReactNode {
  const gateway = useGateway()
  const conn = useConnection(connId)
  const open = useTabs((s) => s.open)
  const now = useNow(5000)
  const refetchInterval = useRefetchInterval()
  const query = useQuery({
    queryKey: ['consumers', connId, stream ?? '*'],
    queryFn: () =>
      stream ? gateway.listConsumers(connId, stream) : gateway.listAllConsumers(connId),
    refetchInterval
  })
  const [search, setSearch] = useState('')
  const [unhealthyOnly, setUnhealthyOnly] = useState(false)
  const [creating, setCreating] = useState(false)

  const all = query.data
  const unhealthy = useMemo(
    () => (all ?? []).filter((c) => (c.health?.length ?? 0) > 0).length,
    [all]
  )
  const totals = useMemo(() => consumerTotals(all ?? []), [all])
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (all ?? []).filter((c) => {
      // Consumers the KV and Object Store clients create for themselves are not the user's.
      if (!stream && (c.stream_name.startsWith('KV_') || c.stream_name.startsWith('OBJ_')))
        return false
      if (unhealthyOnly && !(c.health?.length ?? 0)) return false
      if (!q) return true
      return (
        c.name.toLowerCase().includes(q) ||
        c.stream_name.toLowerCase().includes(q) ||
        consumerFilters(c).some((f) => f.toLowerCase().includes(q))
      )
    })
  }, [all, search, unhealthyOnly, stream])

  const go = (c: ConsumerInfoDto): void =>
    open({ kind: 'consumer', connId, stream: c.stream_name, consumer: c.name })

  const columns: Column<ConsumerInfoDto>[] = [
    {
      id: 'name',
      header: 'Name',
      width: 'minmax(150px, 1.2fr)',
      sort: (c) => c.name,
      title: (c) => c.config.description || c.name,
      cell: (c) => (
        <span className="flex items-center gap-1">
          <StarButton
            connId={connId}
            favorite={{ kind: 'consumer', stream: c.stream_name, consumer: c.name }}
          />
          <button
            className="truncate font-medium text-accent hover:underline"
            onClick={() => go(c)}
          >
            {c.name}
          </button>
        </span>
      )
    },
    {
      id: 'health',
      header: 'Health',
      width: 'minmax(150px, 1fr)',
      sort: (c) => c.health?.length ?? 0,
      title: (c) =>
        c.health?.length ? c.health.map((f) => HEALTH_LABELS[f]).join(', ') : 'No problems found',
      cell: (c) => <HealthBadges c={c} />
    },
    ...(stream
      ? []
      : [
          {
            id: 'stream',
            header: 'Stream',
            width: 'minmax(120px, 1fr)',
            mono: true,
            sort: (c: ConsumerInfoDto) => c.stream_name,
            cell: (c: ConsumerInfoDto) => c.stream_name
          } as Column<ConsumerInfoDto>
        ]),
    {
      id: 'durable',
      header: 'Kind',
      width: '88px',
      sort: (c) => (c.config.durable_name ? 'durable' : 'ephemeral'),
      cell: (c) => (c.config.durable_name ? 'Durable' : 'Ephemeral')
    },
    {
      id: 'mode',
      header: 'Type',
      width: '56px',
      sort: (c) => (c.config.deliver_subject ? 'push' : 'pull'),
      cell: (c) => (c.config.deliver_subject ? 'Push' : 'Pull')
    },
    {
      id: 'filter',
      header: 'Filter subjects',
      width: 'minmax(140px, 1.2fr)',
      mono: true,
      sort: (c) => consumerFilters(c).join(' '),
      title: (c) => consumerFilters(c).join('\n'),
      cell: (c) => consumerFilters(c).join(', ') || <span className="text-faint">all</span>
    },
    {
      id: 'ack',
      header: 'Ack policy',
      width: '92px',
      sort: (c) => c.config.ack_policy,
      cell: (c) => c.config.ack_policy
    },
    {
      id: 'pending',
      header: 'Pending',
      width: '88px',
      align: 'right',
      sort: (c) => c.num_pending,
      title: () => 'Messages not yet delivered',
      cell: (c) => formatCount(c.num_pending)
    },
    {
      id: 'ackPending',
      header: 'Ack pending',
      width: '104px',
      align: 'right',
      sort: (c) => c.num_ack_pending,
      title: () => 'Delivered but not yet acknowledged',
      cell: (c) => formatCount(c.num_ack_pending)
    },
    {
      id: 'redelivered',
      header: 'Redelivered',
      width: '104px',
      align: 'right',
      sort: (c) => c.num_redelivered,
      cell: (c) => formatCount(c.num_redelivered)
    },
    {
      id: 'waiting',
      header: 'Waiting pulls',
      width: '112px',
      align: 'right',
      sort: (c) => c.num_waiting,
      cell: (c) => formatCount(c.num_waiting)
    },
    {
      id: 'active',
      header: 'Last active',
      width: '100px',
      sort: (c) => (lastActive(c) ? new Date(lastActive(c)!).getTime() : 0),
      title: (c) => lastActive(c),
      cell: (c) => formatAgo(lastActive(c) ?? null, now)
    }
  ]

  return (
    <div className="flex h-full min-h-0 flex-col">
      {all && (
        <div className="flex shrink-0 flex-wrap gap-3 border-b border-line bg-panel px-4 py-3">
          <SummaryCard
            label="Total pending"
            value={formatCount(totals.pending)}
            hint="Messages not yet delivered"
          />
          <SummaryCard
            label="Ack pending"
            value={formatCount(totals.ackPending)}
            hint="Delivered, not yet acknowledged"
          />
          <SummaryCard
            label="Needs attention"
            value={formatCount(totals.attention)}
            hint={totals.attention ? 'Consumers with problems' : 'All consumers healthy'}
            warn={totals.attention > 0}
          />
        </div>
      )}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-panel px-4 py-2">
        <Input
          className="w-72"
          type="search"
          aria-label="Search consumers"
          placeholder={
            stream ? 'Search by name or filter subject' : 'Search by name, stream or filter subject'
          }
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Checkbox
          label={`Unhealthy only${unhealthy ? ` (${unhealthy})` : ''}`}
          checked={unhealthyOnly}
          onChange={(e) => setUnhealthyOnly(e.target.checked)}
        />
        <span className="ml-auto text-muted" role="status">
          {all ? `${formatCount(rows.length)} ${rows.length === 1 ? 'consumer' : 'consumers'}` : ''}
        </span>
        <Button
          icon={<RefreshCw className="h-3.5 w-3.5" aria-hidden />}
          busy={query.isFetching && !query.isLoading}
          onClick={() => void query.refetch()}
        >
          Refresh
        </Button>
        {stream && (
          <Button
            variant="primary"
            icon={<Plus className="h-4 w-4" aria-hidden />}
            {...readOnlyProps(conn?.readOnly)}
            onClick={() => setCreating(true)}
          >
            New consumer
          </Button>
        )}
      </div>
      {query.error ? (
        <ErrorNote className="m-4" error={query.error} onRetry={() => void query.refetch()} />
      ) : query.isLoading ? (
        <div className="p-6">
          <Spinner label="Loading consumers" />
        </div>
      ) : (
        <div className="min-h-0 flex-1 bg-panel">
          <DataTable
            ariaLabel="Consumers"
            rows={rows}
            columns={columns}
            rowKey={(c) => `${c.stream_name}/${c.name}`}
            defaultSort={{ id: 'name', dir: 'asc' }}
            onOpen={go}
            empty={
              unhealthyOnly
                ? 'No unhealthy consumers'
                : search
                  ? 'No consumers match'
                  : stream
                    ? 'This stream has no consumers'
                    : 'This account has no consumers'
            }
          />
        </div>
      )}
      {creating && stream && (
        <ConsumerForm
          connId={connId}
          stream={stream}
          onClose={() => setCreating(false)}
          onSaved={go}
        />
      )}
    </div>
  )
}
