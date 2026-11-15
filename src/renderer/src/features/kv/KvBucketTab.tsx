import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Eraser, Pencil, Plus, Radio, RefreshCw, Trash2 } from 'lucide-react'
import { GatewayError, type KvEntryDto } from '@shared/api'
import { fromBase64, textToBase64, tryDecodeText } from '@shared/encoding'
import { formatBytes, formatCount, formatTime } from '@shared/format'
import { DataTable, type Column } from '../../components/DataTable'
import { PayloadViewer } from '../../components/PayloadViewer'
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Notice,
  Page,
  readOnlyProps,
  Spinner,
  TextArea
} from '../../components/ui'
import { useGateway } from '../../gateway'
import { useConnection, useDebounced } from '../../lib/hooks'
import { useTabs } from '../../state/tabs'
import { toast } from '../../state/toasts'

interface KeyRow {
  key: string
}

const OPERATION_TONE = { PUT: 'neutral', DEL: 'warn', PURGE: 'danger' } as const
const OPERATION_LABEL = { PUT: 'put', DEL: 'deleted', PURGE: 'purged' } as const

/** One KV bucket: keys, the value and history of a key, and live changes (PBI-070). */
export function KvBucketTab({
  tabId,
  connId,
  bucket
}: {
  tabId: string
  connId: string
  bucket: string
}): ReactNode {
  const gateway = useGateway()
  const client = useQueryClient()
  const conn = useConnection(connId)
  const tabs = useTabs()
  const readOnly = conn?.readOnly

  const [search, setSearch] = useState('')
  const query = useDebounced(search.trim().toLowerCase(), 150)
  const [selected, setSelected] = useState<string | null>(null)
  const [revision, setRevision] = useState<number | undefined>(undefined)
  const [dialog, setDialog] = useState<
    null | { kind: 'put'; key?: string } | { kind: 'delete' | 'purge'; key: string }
  >(null)
  const [watching, setWatching] = useState(false)
  const [changes, setChanges] = useState<KvEntryDto[]>([])
  const [watchError, setWatchError] = useState<unknown>(null)

  const keys = useQuery({
    queryKey: ['kvKeys', connId, bucket],
    queryFn: () => gateway.kvKeys(connId, bucket)
  })
  const entry = useQuery({
    queryKey: ['kvEntry', connId, bucket, selected, revision ?? 'latest'],
    queryFn: () => gateway.kvGet(connId, bucket, selected!, revision),
    enabled: selected !== null
  })
  const history = useQuery({
    queryKey: ['kvHistory', connId, bucket, selected],
    queryFn: () => gateway.kvHistory(connId, bucket, selected!),
    enabled: selected !== null
  })

  const rows = useMemo<KeyRow[]>(() => {
    const list = keys.data ?? []
    // A plain prefix or substring search; 100,000 keys filter in a few milliseconds.
    return (query ? list.filter((k) => k.toLowerCase().includes(query)) : list).map((key) => ({
      key
    }))
  }, [keys.data, query])

  const refreshKey = (key: string): void => {
    void client.invalidateQueries({ queryKey: ['kvKeys', connId, bucket] })
    void client.invalidateQueries({ queryKey: ['kvEntry', connId, bucket, key] })
    void client.invalidateQueries({ queryKey: ['kvHistory', connId, bucket, key] })
  }

  // Live changes: the gateway watches the bucket and reports each put, delete and purge.
  useEffect(() => {
    if (!watching) return
    return gateway.open('kvWatch', { connId, bucket }, (event) => {
      if (event.type === 'entry') {
        setChanges((list) => [event.entry, ...list].slice(0, 500))
        void client.invalidateQueries({ queryKey: ['kvKeys', connId, bucket] })
        void client.invalidateQueries({ queryKey: ['kvEntry', connId, bucket, event.entry.key] })
        void client.invalidateQueries({ queryKey: ['kvHistory', connId, bucket, event.entry.key] })
      } else {
        setWatchError(new GatewayError(event.error))
        setWatching(false)
      }
    })
  }, [watching, gateway, connId, bucket, client])

  if (keys.error instanceof GatewayError && keys.error.kind === 'not_found') {
    return (
      <EmptyState title={`Bucket ${bucket} no longer exists`}>
        <Button onClick={() => tabs.close(tabId)}>Close tab</Button>
      </EmptyState>
    )
  }

  const columns: Column<KeyRow>[] = [
    {
      id: 'key',
      header: `Key (${formatCount(rows.length)}${query ? ` of ${formatCount(keys.data?.length ?? 0)}` : ''})`,
      width: 'minmax(200px, 1fr)',
      mono: true,
      title: (r) => r.key,
      cell: (r) => r.key
    }
  ]
  const current = entry.data

  return (
    <Page
      scroll={false}
      title={<span className="font-mono">{bucket}</span>}
      subtitle="KV bucket"
      actions={
        <>
          <Button
            icon={<Radio className="h-3.5 w-3.5" aria-hidden />}
            aria-pressed={watching}
            variant={watching ? 'primary' : 'default'}
            onClick={() => {
              setWatchError(null)
              setWatching((v) => !v)
            }}
          >
            {watching ? 'Watching' : 'Watch changes'}
          </Button>
          <Button
            icon={<RefreshCw className="h-3.5 w-3.5" aria-hidden />}
            busy={keys.isFetching && !keys.isLoading}
            onClick={() => void keys.refetch()}
          >
            Refresh
          </Button>
          <Button
            variant="primary"
            icon={<Plus className="h-4 w-4" aria-hidden />}
            {...readOnlyProps(readOnly)}
            onClick={() => setDialog({ kind: 'put' })}
          >
            New key
          </Button>
        </>
      }
    >
      <div className="flex min-h-0 flex-1">
        <div className="flex w-[38%] max-w-[520px] min-w-[280px] shrink-0 flex-col border-r border-line bg-panel">
          <div className="shrink-0 border-b border-line p-2">
            <Input
              type="search"
              aria-label="Search keys"
              placeholder="Search keys"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {keys.error ? (
            <ErrorNote className="m-3" error={keys.error} onRetry={() => void keys.refetch()} />
          ) : keys.isLoading ? (
            <div className="p-4">
              <Spinner label="Loading keys" />
            </div>
          ) : (
            <div className="min-h-0 flex-1">
              <DataTable
                ariaLabel="Keys"
                rows={rows}
                columns={columns}
                rowKey={(r) => r.key}
                selectedKey={selected}
                onSelect={(r) => {
                  setSelected(r.key)
                  setRevision(undefined)
                }}
                empty={query ? 'No keys match' : 'This bucket has no keys'}
              />
            </div>
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto p-4">
          {watching && (
            <section className="mb-4 shrink-0 rounded-lg border border-line bg-panel">
              <header className="flex items-center justify-between border-b border-line px-3 py-1.5">
                <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">
                  Live changes ({changes.length})
                </h3>
                <Button size="sm" variant="ghost" onClick={() => setChanges([])}>
                  Clear
                </Button>
              </header>
              <ul className="max-h-40 overflow-y-auto p-2 text-xs" aria-live="polite">
                {changes.length === 0 && (
                  <li className="text-muted">Waiting for changes to this bucket...</li>
                )}
                {changes.map((c) => (
                  <li key={`${c.key}:${c.revision}`} className="flex items-center gap-2 py-0.5">
                    <span className="tabular text-faint">{formatTime(c.created).slice(11)}</span>
                    <Badge tone={OPERATION_TONE[c.operation]}>{OPERATION_LABEL[c.operation]}</Badge>
                    <button
                      className="truncate font-mono text-accent hover:underline"
                      onClick={() => {
                        setSelected(c.key)
                        setRevision(undefined)
                      }}
                    >
                      {c.key}
                    </button>
                    <span className="ml-auto text-faint">
                      rev {c.revision} · {formatBytes(c.size)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <ErrorNote className="mb-3" error={watchError} />

          {selected === null ? (
            <EmptyState title="Select a key to see its value and history" />
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-3">
              <header className="flex shrink-0 flex-wrap items-center gap-2">
                <h2
                  className="mr-auto min-w-0 truncate font-mono text-sm font-semibold"
                  title={selected}
                >
                  {selected}
                </h2>
                <Button
                  size="sm"
                  icon={<Pencil className="h-3.5 w-3.5" aria-hidden />}
                  {...readOnlyProps(readOnly)}
                  onClick={() => setDialog({ kind: 'put', key: selected })}
                >
                  Edit value
                </Button>
                <Button
                  size="sm"
                  icon={<Trash2 className="h-3.5 w-3.5" aria-hidden />}
                  {...(readOnly
                    ? readOnlyProps(true)
                    : { title: 'Adds a delete marker; the history is kept' })}
                  onClick={() => setDialog({ kind: 'delete', key: selected })}
                >
                  Delete
                </Button>
                <Button
                  size="sm"
                  icon={<Eraser className="h-3.5 w-3.5" aria-hidden />}
                  {...(readOnly
                    ? readOnlyProps(true)
                    : { title: 'Removes the key and its whole history' })}
                  onClick={() => setDialog({ kind: 'purge', key: selected })}
                >
                  Purge
                </Button>
              </header>
              <ErrorNote error={entry.error} />
              {entry.isLoading && <Spinner />}
              {current === null && (
                <Notice>
                  This key has no value{revision !== undefined ? ' at that revision' : ''}.
                </Notice>
              )}
              {current && (
                <>
                  <p className="shrink-0 text-muted">
                    Revision <strong className="text-fg">{current.revision}</strong> ·{' '}
                    {formatTime(current.created)} ·{' '}
                    <Badge tone={OPERATION_TONE[current.operation]}>
                      {OPERATION_LABEL[current.operation]}
                    </Badge>
                    {revision !== undefined && (
                      <button
                        className="ml-2 text-accent hover:underline"
                        onClick={() => setRevision(undefined)}
                      >
                        Show the latest revision
                      </button>
                    )}
                  </p>
                  {current.operation === 'PUT' ? (
                    <PayloadViewer
                      className="min-h-40 flex-1"
                      payload={current.value ?? ''}
                      size={current.size}
                      truncated={current.truncated}
                    />
                  ) : (
                    <Notice tone="warn">
                      This revision is a {current.operation === 'DEL' ? 'delete' : 'purge'} marker,
                      so the key currently has no value.
                    </Notice>
                  )}
                </>
              )}
              <section className="shrink-0">
                <h3 className="pb-1 text-xs font-semibold text-muted">History</h3>
                <ErrorNote error={history.error} />
                <ul className="max-h-48 overflow-y-auto rounded-md border border-line">
                  {(history.data ?? []).map((h) => (
                    <li key={h.revision} className="border-t border-line first:border-t-0">
                      <button
                        aria-current={current?.revision === h.revision}
                        className={`flex w-full items-center gap-3 px-2 py-1 text-left text-xs hover:bg-hover ${current?.revision === h.revision ? 'bg-accent-soft' : ''}`}
                        onClick={() => setRevision(h.revision)}
                      >
                        <span className="tabular w-16">rev {h.revision}</span>
                        <Badge tone={OPERATION_TONE[h.operation]}>
                          {OPERATION_LABEL[h.operation]}
                        </Badge>
                        <span className="tabular">{formatTime(h.created)}</span>
                        <span className="ml-auto text-faint">{formatBytes(h.size)}</span>
                      </button>
                    </li>
                  ))}
                  {history.data?.length === 0 && (
                    <li className="px-2 py-1 text-xs text-muted">No history</li>
                  )}
                </ul>
              </section>
            </div>
          )}
        </div>
      </div>

      {dialog?.kind === 'put' && (
        <PutDialog
          connId={connId}
          bucket={bucket}
          existingKey={dialog.key}
          initial={
            dialog.key && current?.operation === 'PUT' && current.key === dialog.key
              ? current
              : undefined
          }
          onClose={() => setDialog(null)}
          onSaved={(key) => {
            refreshKey(key)
            setSelected(key)
            setRevision(undefined)
          }}
        />
      )}
      {(dialog?.kind === 'delete' || dialog?.kind === 'purge') && (
        <ConfirmDialog
          title={dialog.kind === 'delete' ? `Delete key ${dialog.key}` : `Purge key ${dialog.key}`}
          confirmLabel={dialog.kind === 'delete' ? 'Delete key' : 'Purge key'}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            if (dialog.kind === 'delete') await gateway.kvDelete(connId, bucket, dialog.key)
            else await gateway.kvPurge(connId, bucket, dialog.key)
            toast.ok(
              dialog.kind === 'delete' ? `Deleted key ${dialog.key}` : `Purged key ${dialog.key}`
            )
            refreshKey(dialog.key)
            setRevision(undefined)
          }}
        >
          {dialog.kind === 'delete' ? (
            <>
              This marks <span className="font-mono">{dialog.key}</span> as deleted in bucket{' '}
              <span className="font-mono">{bucket}</span>. Earlier revisions stay in the history.
            </>
          ) : (
            <>
              This removes <span className="font-mono">{dialog.key}</span> and{' '}
              <strong>all of its history</strong> from bucket{' '}
              <span className="font-mono">{bucket}</span>. It cannot be undone.
            </>
          )}
        </ConfirmDialog>
      )}
    </Page>
  )
}

function PutDialog({
  connId,
  bucket,
  existingKey,
  initial,
  onSaved,
  onClose
}: {
  connId: string
  bucket: string
  existingKey?: string
  initial?: KvEntryDto
  onSaved: (key: string) => void
  onClose: () => void
}): ReactNode {
  const gateway = useGateway()
  const initialText = initial?.value !== undefined ? tryDecodeText(fromBase64(initial.value)) : ''
  const binary = initialText === null
  const [key, setKey] = useState(existingKey ?? '')
  const [value, setValue] = useState(initialText ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const keyError =
    key && !/^[-/_=.a-zA-Z0-9]+$/.test(key)
      ? 'Keys may contain letters, digits and - / _ = . only'
      : key.startsWith('.') || key.endsWith('.')
        ? 'A key cannot start or end with "."'
        : null

  const submit = async (): Promise<void> => {
    if (!key || keyError || binary) return
    setBusy(true)
    setError(null)
    try {
      const result = await gateway.kvPut(connId, bucket, key, textToBase64(value))
      toast.ok(`Saved ${key} as revision ${result.revision}`)
      onSaved(key)
      onClose()
    } catch (err) {
      setError(err)
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={existingKey ? `Edit ${existingKey}` : `New key in ${bucket}`}
      onClose={onClose}
      width={600}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={!key || !!keyError || binary}
            onClick={() => void submit()}
          >
            Save
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <Field label="Key" error={keyError}>
          {(id) => (
            <Input
              id={id}
              mono
              autoFocus={!existingKey}
              disabled={!!existingKey}
              invalid={!!keyError}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          )}
        </Field>
        {binary ? (
          <Notice tone="warn">
            The current value is binary and cannot be edited as text here.
          </Notice>
        ) : (
          <Field label="Value" hint="Saved as a new revision.">
            {(id) => (
              <TextArea
                id={id}
                rows={12}
                autoFocus={!!existingKey}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            )}
          </Field>
        )}
        <ErrorNote error={error} />
      </form>
    </Dialog>
  )
}
