import { useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  CheckCircle2,
  CircleDashed,
  FilterX,
  Hourglass,
  Pause,
  RefreshCw,
  SkipBack,
  type LucideIcon
} from 'lucide-react'
import type { StreamConfigDto } from '@shared/api'
import { formatTime } from '@shared/format'
import {
  messageConsumerStatus,
  retentionNote,
  type MessageConsumerState,
  type MessageRef
} from '@shared/messageConsumers'
import { useDetailSection } from '../../components/detailSections'
import { Badge, Button, CollapsibleSection, ErrorNote, Input, Spinner } from '../../components/ui'
import { useGateway } from '../../gateway'
import { useRefetchInterval } from '../../lib/hooks'
import { useTabs } from '../../state/tabs'

const STATES: Record<
  MessageConsumerState,
  { Icon: LucideIcon; tone: 'neutral' | 'accent' | 'ok' | 'warn' }
> = {
  'not-for-consumer': { Icon: FilterX, tone: 'neutral' },
  'before-start': { Icon: SkipBack, tone: 'neutral' },
  done: { Icon: CheckCircle2, tone: 'ok' },
  'waiting-ack': { Icon: Hourglass, tone: 'warn' },
  'not-delivered': { Icon: CircleDashed, tone: 'accent' }
}

/** Rows shown before "Show more": a stream can have thousands of consumers. */
const PAGE = 100
const SEARCH_FROM = 8

/**
 * The "Consumers" section of the message panel (PBI-049): for one stream message, where each
 * consumer of the stream is with it. Worked out from the consumer list, which is only read.
 */
export function MessageConsumers({
  connId,
  stream,
  retention,
  message
}: {
  connId: string
  stream: string
  retention: StreamConfigDto['retention']
  message: MessageRef
}): ReactNode {
  const gateway = useGateway()
  const open = useTabs((s) => s.open)
  const section = useDetailSection('consumers')
  const refetchInterval = useRefetchInterval()
  // The same key as the consumers list, so both share one cache and one refresh.
  const query = useQuery({
    queryKey: ['consumers', connId, stream],
    queryFn: () => gateway.listConsumers(connId, stream),
    refetchInterval
  })
  const [search, setSearch] = useState('')
  const [shown, setShown] = useState(PAGE)

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (query.data ?? [])
      .filter((c) => !q || c.name.toLowerCase().includes(q))
      .map((c) => ({ c, status: messageConsumerStatus(message, c) }))
  }, [query.data, search, message])

  const total = query.data?.length ?? 0
  const note = retentionNote(retention)
  const read = query.dataUpdatedAt ? formatTime(query.dataUpdatedAt) : undefined

  return (
    <CollapsibleSection
      aria-label="Consumers"
      data-testid="message-consumers"
      title={`Consumers${query.data ? ` (${total})` : ''}`}
      open={section.open}
      onToggle={section.toggle}
      actions={
        <>
          {read && (
            <span className="text-[11px] text-faint" data-testid="consumers-read-at">
              Read at {read}
            </span>
          )}
          <Button
            size="sm"
            variant="ghost"
            aria-label="Refresh consumers"
            title="Read the consumers again"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
            icon={
              <RefreshCw
                className={'h-3.5 w-3.5' + (query.isFetching ? ' spin' : '')}
                aria-hidden
              />
            }
          />
        </>
      }
    >
      {note && <p className="pb-1 text-xs text-muted">{note}</p>}
      {query.isError ? (
        <ErrorNote error={query.error} onRetry={() => void query.refetch()} />
      ) : !query.data ? (
        <Spinner label="Reading consumers" />
      ) : total === 0 ? (
        <p className="text-faint">This stream has no consumers</p>
      ) : (
        <>
          {total >= SEARCH_FROM && (
            <Input
              className="mb-1 w-full"
              type="search"
              aria-label="Search consumers"
              placeholder="Search consumers"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setShown(PAGE)
              }}
            />
          )}
          <ul className="max-h-72 divide-y divide-line overflow-y-auto rounded-md border border-line">
            {rows.slice(0, shown).map(({ c, status }) => {
              const { Icon, tone } = STATES[status.state]
              return (
                <li key={c.name} className="flex flex-col gap-0.5 px-2 py-1.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <button
                      className="min-w-0 truncate text-left font-mono text-xs text-accent hover:underline"
                      title={`Open consumer ${c.name}`}
                      onClick={() =>
                        open({ kind: 'consumer', connId, stream: c.stream_name, consumer: c.name })
                      }
                    >
                      {c.name}
                    </button>
                    {c.paused && (
                      <Badge className="gap-1" title="Delivery is paused">
                        <Pause className="h-3 w-3" aria-hidden />
                        Paused
                      </Badge>
                    )}
                    <Badge tone={tone} title={status.tooltip} className="ml-auto gap-1">
                      <Icon className="h-3 w-3 shrink-0" aria-hidden />
                      {status.label}
                    </Badge>
                  </div>
                  {status.note && <p className="text-[11px] text-faint">{status.note}</p>}
                  <span className="sr-only">{status.tooltip}</span>
                </li>
              )
            })}
            {rows.length === 0 && <li className="px-2 py-1.5 text-faint">No consumer matches</li>}
          </ul>
          {rows.length > shown && (
            <Button size="sm" className="mt-1" onClick={() => setShown((n) => n + PAGE)}>
              Show more ({rows.length - shown} left)
            </Button>
          )}
        </>
      )}
    </CollapsibleSection>
  )
}
