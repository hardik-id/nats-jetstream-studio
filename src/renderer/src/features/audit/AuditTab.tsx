import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Download, RefreshCw } from 'lucide-react'
import type { AuditEntry } from '@shared/api'
import { formatTime } from '@shared/format'
import { DataTable, type Column } from '../../components/DataTable'
import { Badge, Button, ErrorNote, Field, Input, Page, Select, Spinner } from '../../components/ui'
import { useGateway } from '../../gateway'
import { saveText } from '../../lib/files'
import {
  useAppInfo,
  useConnections,
  useDebounced,
  useRefetchInterval,
  useSetting
} from '../../lib/hooks'
import { toast } from '../../state/toasts'

const TONE = { ok: 'ok', error: 'danger', blocked: 'warn' } as const
const LABEL = { ok: 'done', error: 'failed', blocked: 'blocked' } as const

/**
 * Everything changed from the studio (PBI-092): who did what to which target, and whether it
 * worked. Reads are not recorded, and neither are payloads or secrets.
 */
export function AuditTab({ connId }: { connId: string }): ReactNode {
  const gateway = useGateway()
  const appInfo = useAppInfo()
  const { data: connections = [] } = useConnections()
  const [scope, setScope] = useState<string>(connId)
  const [result, setResult] = useState<'' | AuditEntry['result']>('')
  const [search, setSearch] = useState('')
  const text = useDebounced(search.trim(), 250)
  const [retention, setRetention] = useSetting<number>('audit.retentionDays', 90)
  const [retentionDraft, setRetentionDraft] = useState<string | null>(null)
  const filter = {
    connId: scope || undefined,
    result: result || undefined,
    text: text || undefined
  }
  const query = useQuery({
    queryKey: ['audit', filter],
    queryFn: () => gateway.auditList({ ...filter, limit: 5000 }),
    refetchInterval: useRefetchInterval()
  })
  const web = appInfo?.mode === 'web'

  const columns: Column<AuditEntry & { key: number }>[] = [
    {
      id: 'time',
      header: 'Time',
      width: '176px',
      sort: (e) => e.time,
      title: (e) => `${e.time} UTC`,
      cell: (e) => <span className="tabular">{formatTime(e.time).slice(0, 19)}</span>
    },
    {
      id: 'conn',
      header: 'Connection',
      width: 'minmax(120px, 1fr)',
      sort: (e) => e.connName,
      cell: (e) => e.connName
    },
    ...(web
      ? [
          {
            id: 'user',
            header: 'User',
            width: 'minmax(120px, 1fr)',
            sort: (e: AuditEntry) => e.user ?? '',
            cell: (e: AuditEntry) => e.user ?? ''
          } as Column<AuditEntry & { key: number }>
        ]
      : []),
    {
      id: 'action',
      header: 'Action',
      width: '160px',
      mono: true,
      sort: (e) => e.action,
      cell: (e) => e.action
    },
    {
      id: 'target',
      header: 'Target',
      width: 'minmax(160px, 1.6fr)',
      mono: true,
      sort: (e) => e.target,
      title: (e) => e.target,
      cell: (e) => e.target
    },
    {
      id: 'result',
      header: 'Result',
      width: '88px',
      sort: (e) => e.result,
      cell: (e) => <Badge tone={TONE[e.result]}>{LABEL[e.result]}</Badge>
    },
    {
      id: 'detail',
      header: 'Detail',
      width: 'minmax(180px, 2fr)',
      title: (e) => e.detail,
      cell: (e) => <span className="text-muted">{e.detail ?? ''}</span>
    }
  ]
  const rows = (query.data ?? []).map((e, i) => ({ ...e, key: i }))

  const exportCsv = async (): Promise<void> => {
    try {
      saveText(
        `studio-audit-${new Date().toISOString().slice(0, 10)}.csv`,
        await gateway.auditExportCsv(filter),
        'text/csv'
      )
    } catch (err) {
      toast.error(err)
    }
  }

  const retentionText = retentionDraft ?? String(retention)
  const retentionValid = /^\d+$/.test(retentionText.trim()) && Number(retentionText) >= 1

  return (
    <Page
      scroll={false}
      title="Audit log"
      subtitle="Changes made from this studio. Stored on this computer only."
      actions={
        <>
          <Button
            icon={<RefreshCw className="h-3.5 w-3.5" aria-hidden />}
            busy={query.isFetching && !query.isLoading}
            onClick={() => void query.refetch()}
          >
            Refresh
          </Button>
          <Button
            icon={<Download className="h-3.5 w-3.5" aria-hidden />}
            onClick={() => void exportCsv()}
          >
            Export CSV
          </Button>
        </>
      }
    >
      <div className="flex shrink-0 flex-wrap items-end gap-2 border-b border-line bg-panel px-4 py-2">
        <Field label="Connection" className="w-52">
          {(id) => (
            <Select id={id} value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="">All connections</option>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Result" className="w-36">
          {(id) => (
            <Select
              id={id}
              value={result}
              onChange={(e) => setResult(e.target.value as '' | AuditEntry['result'])}
            >
              <option value="">Any result</option>
              <option value="ok">Done</option>
              <option value="error">Failed</option>
              <option value="blocked">Blocked (read-only)</option>
            </Select>
          )}
        </Field>
        <Field label="Search" className="w-64">
          {(id) => (
            <Input
              id={id}
              type="search"
              placeholder="Action, target or detail"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          )}
        </Field>
        <form
          className="ml-auto flex items-end gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            if (!retentionValid) return
            setRetention(Number(retentionText))
            setRetentionDraft(null)
            toast.ok(
              `Entries older than ${Number(retentionText)} days are removed when the studio starts`
            )
          }}
        >
          <Field
            label="Keep for (days)"
            className="w-32"
            error={retentionValid ? null : '1 or more'}
          >
            {(id) => (
              <Input
                id={id}
                inputMode="numeric"
                invalid={!retentionValid}
                value={retentionText}
                onChange={(e) => setRetentionDraft(e.target.value)}
              />
            )}
          </Field>
          <Button type="submit" disabled={retentionDraft === null || !retentionValid}>
            Save
          </Button>
        </form>
      </div>
      {query.error ? (
        <ErrorNote className="m-4" error={query.error} onRetry={() => void query.refetch()} />
      ) : query.isLoading ? (
        <div className="p-6">
          <Spinner label="Loading the audit log" />
        </div>
      ) : (
        <div className="min-h-0 flex-1 bg-panel">
          <DataTable
            ariaLabel="Audit log"
            rows={rows}
            columns={columns}
            rowKey={(e) => e.key}
            empty="Nothing recorded yet. Creating, changing, deleting, purging and publishing are recorded here."
          />
        </div>
      )}
    </Page>
  )
}
