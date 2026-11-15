import { useState, type ReactNode } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react'
import type { SubjectCount } from '@shared/api'
import { formatCount } from '@shared/format'
import { validateSubject } from '@shared/subject'
import { DataTable, type Column } from '../../components/DataTable'
import { StarButton } from '../../components/StarButton'
import { Button, ErrorNote, Input, Select, Spinner } from '../../components/ui'
import { useGateway } from '../../gateway'
import { useDebounced } from '../../lib/hooks'

const PAGE = 1000

/** Subjects stored in a stream with their message counts (PBI-034). */
export function StreamSubjects({
  connId,
  stream,
  onBrowse
}: {
  connId: string
  stream: string
  onBrowse: (subject: string) => void
}): ReactNode {
  const gateway = useGateway()
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<'count' | 'subject'>('count')
  const [offset, setOffset] = useState(0)
  const debounced = useDebounced(filter.trim(), 300)
  const invalid = debounced ? validateSubject(debounced) : null

  const query = useQuery({
    queryKey: ['subjects', connId, stream, debounced, sort, offset],
    queryFn: () =>
      gateway.streamSubjects(connId, stream, {
        filter: debounced || undefined,
        sort,
        offset,
        limit: PAGE
      }),
    enabled: !invalid,
    placeholderData: keepPreviousData
  })
  const page = query.data
  const total = page?.total ?? 0

  const columns: Column<SubjectCount>[] = [
    {
      id: 'subject',
      header: 'Subject',
      width: 'minmax(260px, 3fr)',
      title: (s) => s.subject,
      cell: (s) => (
        <span className="flex items-center gap-1">
          <StarButton connId={connId} favorite={{ kind: 'subject', stream, subject: s.subject }} />
          <button
            className="truncate font-mono text-xs text-accent hover:underline"
            onClick={() => onBrowse(s.subject)}
          >
            {s.subject}
          </button>
        </span>
      )
    },
    {
      id: 'count',
      header: 'Messages',
      width: '140px',
      align: 'right',
      cell: (s) => formatCount(s.count)
    }
  ]

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-panel px-4 py-2">
        <Input
          className="w-80"
          mono
          aria-label="Filter subjects"
          placeholder="Filter, for example orders.*.created or orders.>"
          invalid={!!invalid}
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value)
            setOffset(0)
          }}
        />
        <Select
          className="w-52"
          aria-label="Sort subjects"
          value={sort}
          onChange={(e) => setSort(e.target.value as 'count' | 'subject')}
        >
          <option value="count">Most messages first</option>
          <option value="subject">By subject name</option>
        </Select>
        <Button
          icon={<RefreshCw className="h-3.5 w-3.5" aria-hidden />}
          busy={query.isFetching && !query.isLoading}
          onClick={() => void query.refetch()}
        >
          Refresh
        </Button>
        <span className="ml-auto text-muted" role="status">
          {invalid ? (
            <span className="text-danger">{invalid}</span>
          ) : page ? (
            `${formatCount(total)} ${total === 1 ? 'subject' : 'subjects'}`
          ) : (
            ''
          )}
        </span>
        {total > PAGE && (
          <span className="flex items-center gap-1">
            <Button
              size="sm"
              aria-label="Previous page"
              disabled={offset === 0}
              icon={<ChevronLeft className="h-4 w-4" aria-hidden />}
              onClick={() => setOffset(Math.max(0, offset - PAGE))}
            />
            <span className="tabular text-xs text-muted">
              {formatCount(offset + 1)} to {formatCount(Math.min(total, offset + PAGE))}
            </span>
            <Button
              size="sm"
              aria-label="Next page"
              disabled={offset + PAGE >= total}
              icon={<ChevronRight className="h-4 w-4" aria-hidden />}
              onClick={() => setOffset(offset + PAGE)}
            />
          </span>
        )}
      </div>
      {query.error ? (
        <ErrorNote className="m-4" error={query.error} onRetry={() => void query.refetch()} />
      ) : query.isLoading ? (
        <div className="p-6">
          <Spinner label="Counting subjects" />
        </div>
      ) : (
        <div className="min-h-0 flex-1 bg-panel">
          <DataTable
            ariaLabel="Subjects"
            rows={page?.subjects ?? []}
            columns={columns}
            rowKey={(s) => s.subject}
            onOpen={(s) => onBrowse(s.subject)}
            empty={debounced ? 'No subjects match this filter' : 'This stream holds no messages'}
          />
        </div>
      )}
    </div>
  )
}
