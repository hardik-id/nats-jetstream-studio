import { useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Download, Plus, RefreshCw, Upload } from 'lucide-react'
import type { StreamConfigDto, StreamInfoDto } from '@shared/api'
import { formatAgo, formatBytes, formatCount } from '@shared/format'
import { DataTable, type Column } from '../../components/DataTable'
import { StarButton } from '../../components/StarButton'
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  ErrorNote,
  Input,
  Page,
  readOnlyProps,
  Select,
  Spinner
} from '../../components/ui'
import { useGateway } from '../../gateway'
import { pickFile, saveText } from '../../lib/files'
import { useConnection, useNow, useRefetchInterval } from '../../lib/hooks'
import { useTabs } from '../../state/tabs'
import { toast } from '../../state/toasts'
import { StreamForm } from './StreamForm'

const isBucketStream = (name: string): boolean => name.startsWith('KV_') || name.startsWith('OBJ_')

/** Every stream of a connection, searchable and sortable (PBI-030). */
export function StreamsTab({ connId }: { connId: string }): ReactNode {
  const gateway = useGateway()
  const conn = useConnection(connId)
  const open = useTabs((s) => s.open)
  const now = useNow(5000)
  const refetchInterval = useRefetchInterval()
  const query = useQuery({
    queryKey: ['streams', connId],
    queryFn: () => gateway.listStreams(connId),
    refetchInterval
  })

  const [search, setSearch] = useState('')
  const [storage, setStorage] = useState('')
  const [retention, setRetention] = useState('')
  const [showBuckets, setShowBuckets] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [creating, setCreating] = useState<{ initial?: StreamConfigDto } | null>(null)
  const [exporting, setExporting] = useState(false)

  const all = query.data
  const hiddenBuckets = useMemo(
    () => (all ?? []).filter((s) => isBucketStream(s.config.name)).length,
    [all]
  )
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (all ?? []).filter((s) => {
      if (!showBuckets && isBucketStream(s.config.name)) return false
      if (storage && s.config.storage !== storage) return false
      if (retention && s.config.retention !== retention) return false
      if (!q) return true
      return (
        s.config.name.toLowerCase().includes(q) ||
        (s.config.subjects ?? []).some((subject) => subject.toLowerCase().includes(q))
      )
    })
  }, [all, search, storage, retention, showBuckets])

  const totalBytes = useMemo(() => (rows ?? []).reduce((sum, s) => sum + s.state.bytes, 0), [rows])

  const toggle = (name: string): void =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  const columns: Column<StreamInfoDto>[] = [
    {
      id: 'select',
      header: (
        <input
          type="checkbox"
          aria-label="Select all streams"
          className="accent-[var(--accent)]"
          checked={rows.length > 0 && rows.every((r) => selected.has(r.config.name))}
          onChange={(e) =>
            setSelected(e.target.checked ? new Set(rows.map((r) => r.config.name)) : new Set())
          }
        />
      ),
      width: '32px',
      cell: (s) => (
        <input
          type="checkbox"
          aria-label={`Select ${s.config.name}`}
          className="accent-[var(--accent)]"
          checked={selected.has(s.config.name)}
          onClick={(e) => e.stopPropagation()}
          onChange={() => toggle(s.config.name)}
        />
      )
    },
    {
      id: 'name',
      header: 'Name',
      width: 'minmax(150px, 1.4fr)',
      sort: (s) => s.config.name,
      title: (s) => s.config.description || s.config.name,
      cell: (s) => (
        <span className="flex items-center gap-1">
          <StarButton connId={connId} favorite={{ kind: 'stream', stream: s.config.name }} />
          <button
            className="truncate font-medium text-accent hover:underline"
            onClick={() => open({ kind: 'stream', connId, stream: s.config.name })}
          >
            {s.config.name}
          </button>
          {s.config.mirror && <Badge title={`Mirror of ${s.config.mirror.name}`}>mirror</Badge>}
          {s.config.sealed && <Badge tone="warn">sealed</Badge>}
        </span>
      )
    },
    {
      id: 'subjects',
      header: 'Subjects',
      width: 'minmax(130px, 1.6fr)',
      mono: true,
      sort: (s) => (s.config.subjects ?? []).join(' '),
      title: (s) => (s.config.subjects ?? []).join('\n'),
      cell: (s) => (s.config.subjects ?? []).join(', ') || <span className="text-faint">-</span>
    },
    {
      id: 'storage',
      header: 'Storage',
      width: '72px',
      sort: (s) => s.config.storage,
      cell: (s) => s.config.storage
    },
    {
      id: 'retention',
      header: 'Retention',
      width: '88px',
      sort: (s) => s.config.retention,
      cell: (s) => s.config.retention
    },
    {
      id: 'replicas',
      header: 'Replicas',
      width: '78px',
      align: 'right',
      sort: (s) => s.config.num_replicas ?? 1,
      cell: (s) => s.config.num_replicas ?? 1
    },
    {
      id: 'messages',
      header: 'Messages',
      width: '96px',
      align: 'right',
      sort: (s) => s.state.messages,
      cell: (s) => formatCount(s.state.messages)
    },
    {
      id: 'bytes',
      header: 'Size',
      width: '88px',
      align: 'right',
      sort: (s) => s.state.bytes,
      cell: (s) => formatBytes(s.state.bytes)
    },
    {
      id: 'consumers',
      header: 'Consumers',
      width: '92px',
      align: 'right',
      sort: (s) => s.state.consumer_count,
      cell: (s) => formatCount(s.state.consumer_count)
    },
    {
      id: 'first',
      header: 'First seq',
      width: '84px',
      align: 'right',
      sort: (s) => s.state.first_seq,
      cell: (s) => formatCount(s.state.first_seq)
    },
    {
      id: 'last',
      header: 'Last seq',
      width: '84px',
      align: 'right',
      sort: (s) => s.state.last_seq,
      cell: (s) => formatCount(s.state.last_seq)
    },
    {
      id: 'lastTs',
      header: 'Last message',
      width: '104px',
      sort: (s) =>
        s.state.messages > 0 || s.state.last_seq > 0 ? new Date(s.state.last_ts).getTime() : 0,
      title: (s) => s.state.last_ts,
      cell: (s) => formatAgo(s.state.last_ts, now)
    }
  ]

  const importConfig = async (): Promise<void> => {
    const file = await pickFile('.json,application/json')
    if (!file) return
    try {
      const parsed = JSON.parse(await file.text())
      // Accept a bare config, a stream info document, or an export made by this studio.
      const config: unknown = Array.isArray(parsed) ? parsed[0]?.config : (parsed.config ?? parsed)
      if (
        typeof config !== 'object' ||
        config === null ||
        typeof (config as StreamConfigDto).name !== 'string'
      )
        throw new Error('This file does not look like a stream configuration')
      setCreating({ initial: config as StreamConfigDto })
    } catch (err) {
      toast.error(`Cannot import ${file.name}: ${(err as Error).message}`)
    }
  }

  return (
    <Page
      scroll={false}
      title="Streams"
      subtitle={
        all
          ? `${formatCount(rows.length)} of ${formatCount(all.length - (showBuckets ? 0 : hiddenBuckets))} streams · ${formatBytes(totalBytes)} stored`
          : undefined
      }
      filter={
        <>
          <Input
            className="w-52"
            type="search"
            aria-label="Search streams by name or subject"
            placeholder="Search by name or subject"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Select
            className="w-32"
            aria-label="Filter by storage"
            value={storage}
            onChange={(e) => setStorage(e.target.value)}
          >
            <option value="">Any storage</option>
            <option value="file">File</option>
            <option value="memory">Memory</option>
          </Select>
          <Select
            className="w-36"
            aria-label="Filter by retention"
            value={retention}
            onChange={(e) => setRetention(e.target.value)}
          >
            <option value="">Any retention</option>
            <option value="limits">Limits</option>
            <option value="interest">Interest</option>
            <option value="workqueue">Work queue</option>
          </Select>
        </>
      }
      actions={
        <>
          <Button
            aria-label="Refresh"
            title="Refresh"
            icon={<RefreshCw className="h-3.5 w-3.5" aria-hidden />}
            busy={query.isFetching && !query.isLoading}
            onClick={() => void query.refetch()}
          />
          <Button
            icon={<Download className="h-3.5 w-3.5" aria-hidden />}
            disabled={selected.size === 0}
            title={selected.size === 0 ? 'Select streams to export their configuration' : undefined}
            onClick={() => setExporting(true)}
          >
            Export{selected.size > 0 ? ` (${selected.size})` : ''}
          </Button>
          <Button
            aria-label="Import"
            icon={<Upload className="h-3.5 w-3.5" aria-hidden />}
            {...readOnlyProps(conn?.readOnly)}
            title={conn?.readOnly ? readOnlyProps(true).title : 'Import stream configuration'}
            onClick={() => void importConfig()}
          />
          <Button
            variant="primary"
            icon={<Plus className="h-4 w-4" aria-hidden />}
            {...readOnlyProps(conn?.readOnly)}
            onClick={() => setCreating({})}
          >
            New stream
          </Button>
        </>
      }
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-panel px-4 py-2">
        <Checkbox
          label={`Show KV and Object Store streams${hiddenBuckets ? ` (${hiddenBuckets})` : ''}`}
          checked={showBuckets}
          onChange={(e) => setShowBuckets(e.target.checked)}
        />
      </div>
      {query.error ? (
        <ErrorNote className="m-4" error={query.error} onRetry={() => void query.refetch()} />
      ) : query.isLoading ? (
        <div className="p-6">
          <Spinner label="Loading streams" />
        </div>
      ) : (
        <div className="min-h-0 flex-1 bg-panel">
          <DataTable
            ariaLabel="Streams"
            rows={rows}
            columns={columns}
            rowKey={(s) => s.config.name}
            defaultSort={{ id: 'name', dir: 'asc' }}
            onOpen={(s) => open({ kind: 'stream', connId, stream: s.config.name })}
            empty={
              all?.length ? 'No streams match these filters' : 'This account has no streams yet'
            }
          />
        </div>
      )}

      {creating && (
        <StreamForm
          connId={connId}
          initial={creating.initial}
          onClose={() => setCreating(null)}
          onSaved={(info) => open({ kind: 'stream', connId, stream: info.config.name })}
        />
      )}
      {exporting && (
        <ExportDialog
          connId={connId}
          streams={(all ?? []).filter((s) => selected.has(s.config.name))}
          onClose={() => setExporting(false)}
        />
      )}
    </Page>
  )
}

/**
 * Saves stream configurations as JSON (PBI-035). One stream is written as a plain config object,
 * which is what `nats stream add --config` reads; several are written as a list.
 */
export function ExportDialog({
  connId,
  streams,
  onClose
}: {
  connId: string
  streams: StreamInfoDto[]
  onClose: () => void
}): ReactNode {
  const gateway = useGateway()
  const [withConsumers, setWithConsumers] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const run = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const docs: { config: StreamConfigDto; consumers?: unknown[] }[] = []
      for (const s of streams) {
        const doc: { config: StreamConfigDto; consumers?: unknown[] } = { config: s.config }
        if (withConsumers)
          doc.consumers = (await gateway.listConsumers(connId, s.config.name)).map((c) => c.config)
        docs.push(doc)
      }
      const single = docs.length === 1
      const body = single && !withConsumers ? docs[0].config : single ? docs[0] : docs
      saveText(
        single ? `${streams[0].config.name}.stream.json` : `streams-${docs.length}.json`,
        JSON.stringify(body, null, 2) + '\n'
      )
      onClose()
    } catch (err) {
      setError(err)
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={
        streams.length === 1
          ? `Export configuration of ${streams[0].config.name}`
          : `Export configuration of ${streams.length} streams`
      }
      onClose={onClose}
      width={460}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={() => void run()}>
            Export
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-muted">
          {streams.length === 1 && !withConsumers
            ? 'The file holds the stream configuration and can be used with "nats stream add --config", or imported here into another server.'
            : 'The file holds each stream configuration. Import it here to recreate a stream on another server.'}
        </p>
        <Checkbox
          label="Include consumer configurations"
          checked={withConsumers}
          onChange={(e) => setWithConsumers(e.target.checked)}
        />
        <ErrorNote error={error} />
      </div>
    </Dialog>
  )
}
