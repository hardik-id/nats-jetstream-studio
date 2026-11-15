import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, RefreshCw, Trash2, Upload, X } from 'lucide-react'
import { GatewayError, type ObjectInfoDto } from '@shared/api'
import { fromBase64, toBase64 } from '@shared/encoding'
import { formatBytes, formatCount, formatTime } from '@shared/format'
import { DataTable, type Column } from '../../components/DataTable'
import { PayloadViewer } from '../../components/PayloadViewer'
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorNote,
  Facts,
  Input,
  Notice,
  Page,
  readOnlyProps,
  Spinner
} from '../../components/ui'
import { useGateway } from '../../gateway'
import { pickFile, saveBlob } from '../../lib/files'
import { useConnection } from '../../lib/hooks'
import { useTabs } from '../../state/tabs'
import { toast } from '../../state/toasts'

const PREVIEW_LIMIT = 1024 * 1024
const UPLOAD_CHUNK = 256 * 1024
const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml'
}

interface Transfer {
  kind: 'upload' | 'download'
  name: string
  done: number
  total: number
  cancel: () => void
}

/** One Object Store bucket: list, preview, download, upload and delete (PBI-071). */
export function ObjBucketTab({
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
  const query = useQuery({
    queryKey: ['objects', connId, bucket],
    queryFn: () => gateway.objList(connId, bucket)
  })
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<ObjectInfoDto | null>(null)
  const [transfer, setTransfer] = useState<Transfer | null>(null)
  const [error, setError] = useState<unknown>(null)
  const cancelRef = useRef<(() => void) | null>(null)
  useEffect(() => () => cancelRef.current?.(), [])

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q
      ? (query.data ?? []).filter((o) => o.name.toLowerCase().includes(q))
      : (query.data ?? [])
  }, [query.data, search])
  const info = selected ? (query.data ?? []).find((o) => o.name === selected) : undefined
  const previewable = info !== undefined && info.size <= PREVIEW_LIMIT
  const preview = useQuery({
    queryKey: ['objPreview', connId, bucket, selected, info?.digest],
    queryFn: () => gateway.objPreview(connId, bucket, selected!, PREVIEW_LIMIT),
    enabled: previewable,
    staleTime: 60_000
  })

  if (query.error instanceof GatewayError && query.error.kind === 'not_found') {
    return (
      <EmptyState title={`Bucket ${bucket} no longer exists`}>
        <Button onClick={() => tabs.close(tabId)}>Close tab</Button>
      </EmptyState>
    )
  }

  const download = (object: ObjectInfoDto): void => {
    setError(null)
    const chunks: Uint8Array[] = []
    let done = 0
    const close = gateway.open('objDownload', { connId, bucket, name: object.name }, (event) => {
      if (event.type === 'chunk') {
        const bytes = fromBase64(event.data)
        // Copy: the decoded view may share a buffer that is reused.
        chunks.push(bytes.slice())
        done += bytes.length
        setTransfer((t) => (t ? { ...t, done } : t))
      } else if (event.type === 'done') {
        cancelRef.current = null
        setTransfer(null)
        saveBlob(object.name.split('/').pop() || 'object', new Blob(chunks as BlobPart[]))
        toast.ok(`Downloaded ${object.name} (${formatBytes(event.bytes)})`)
      } else {
        cancelRef.current = null
        setTransfer(null)
        setError(new GatewayError(event.error))
      }
    })
    const cancel = (): void => {
      close()
      cancelRef.current = null
      setTransfer(null)
    }
    cancelRef.current = cancel
    setTransfer({ kind: 'download', name: object.name, done: 0, total: object.size, cancel })
  }

  const upload = async (): Promise<void> => {
    const file = await pickFile()
    if (!file) return
    setError(null)
    let cancelled = false
    let uploadId: string | undefined
    const cancel = (): void => {
      cancelled = true
      if (uploadId) void gateway.objUploadAbort(uploadId)
      cancelRef.current = null
      setTransfer(null)
    }
    cancelRef.current = cancel
    setTransfer({ kind: 'upload', name: file.name, done: 0, total: file.size, cancel })
    try {
      uploadId = (await gateway.objUploadStart(connId, bucket, file.name)).uploadId
      for (let offset = 0; offset < file.size && !cancelled; offset += UPLOAD_CHUNK) {
        const chunk = new Uint8Array(await file.slice(offset, offset + UPLOAD_CHUNK).arrayBuffer())
        await gateway.objUploadChunk(uploadId, toBase64(chunk))
        const done = Math.min(file.size, offset + UPLOAD_CHUNK)
        setTransfer((t) => (t ? { ...t, done } : t))
      }
      if (cancelled) return
      const saved = await gateway.objUploadFinish(uploadId)
      toast.ok(`Uploaded ${saved.name} (${formatBytes(saved.size)})`)
      await client.invalidateQueries({ queryKey: ['objects', connId, bucket] })
      await client.invalidateQueries({ queryKey: ['objBuckets', connId] })
      setSelected(saved.name)
    } catch (err) {
      if (!cancelled) setError(err)
      if (uploadId) void gateway.objUploadAbort(uploadId)
    } finally {
      cancelRef.current = null
      setTransfer(null)
    }
  }

  const columns: Column<ObjectInfoDto>[] = [
    {
      id: 'name',
      header: 'Name',
      width: 'minmax(220px, 3fr)',
      mono: true,
      sort: (o) => o.name,
      title: (o) => o.name,
      cell: (o) => o.name
    },
    {
      id: 'size',
      header: 'Size',
      width: '100px',
      align: 'right',
      sort: (o) => o.size,
      cell: (o) => formatBytes(o.size)
    },
    {
      id: 'modified',
      header: 'Modified',
      width: '176px',
      sort: (o) => new Date(o.mtime).getTime(),
      cell: (o) => <span className="tabular">{formatTime(o.mtime).slice(0, 19)}</span>
    },
    {
      id: 'chunks',
      header: 'Chunks',
      width: '76px',
      align: 'right',
      sort: (o) => o.chunks,
      cell: (o) => formatCount(o.chunks)
    },
    {
      id: 'description',
      header: 'Description',
      width: 'minmax(120px, 1.5fr)',
      title: (o) => o.description,
      cell: (o) => o.description ?? ''
    }
  ]

  const extension = info?.name.split('.').pop()?.toLowerCase() ?? ''
  const imageType = IMAGE_TYPES[extension]

  return (
    <Page
      scroll={false}
      title={<span className="font-mono">{bucket}</span>}
      subtitle={
        query.data
          ? `Object store · ${formatCount(query.data.length)} objects · ${formatBytes(query.data.reduce((sum, o) => sum + o.size, 0))}`
          : 'Object store'
      }
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
            variant="primary"
            icon={<Upload className="h-3.5 w-3.5" aria-hidden />}
            {...(transfer
              ? { disabled: true, title: 'A transfer is in progress' }
              : readOnlyProps(readOnly))}
            onClick={() => void upload()}
          >
            Upload file
          </Button>
        </>
      }
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-line bg-panel px-4 py-2">
        <Input
          className="w-80"
          type="search"
          aria-label="Search objects"
          placeholder="Search objects by name"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {(transfer !== null || error != null) && (
        <div className="flex shrink-0 flex-col gap-1.5 bg-panel px-4 py-2">
          <ErrorNote error={error} />
          {transfer && (
            <Notice tone="accent" className="flex items-center gap-3">
              <span className="min-w-0 flex-1" role="status">
                <span className="block truncate">
                  {transfer.kind === 'upload' ? 'Uploading' : 'Downloading'}{' '}
                  <span className="font-mono">{transfer.name}</span>: {formatBytes(transfer.done)}{' '}
                  of {formatBytes(transfer.total)}
                </span>
                <progress
                  className="mt-1 h-1.5 w-full accent-[var(--accent)]"
                  max={Math.max(1, transfer.total)}
                  value={transfer.done}
                  aria-label={`${transfer.kind} progress`}
                />
              </span>
              <Button
                size="sm"
                icon={<X className="h-3.5 w-3.5" aria-hidden />}
                onClick={transfer.cancel}
              >
                Cancel
              </Button>
            </Notice>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 bg-panel">
          {query.error ? (
            <ErrorNote className="m-4" error={query.error} onRetry={() => void query.refetch()} />
          ) : query.isLoading ? (
            <div className="p-6">
              <Spinner label="Loading objects" />
            </div>
          ) : (
            <DataTable
              ariaLabel="Objects"
              rows={rows}
              columns={columns}
              rowKey={(o) => o.name}
              selectedKey={selected}
              onSelect={(o) => setSelected(o.name)}
              defaultSort={{ id: 'name', dir: 'asc' }}
              empty={search ? 'No objects match' : 'This bucket is empty'}
            />
          )}
        </div>

        {info && (
          <aside
            aria-label="Object detail"
            className="flex w-[44%] max-w-[720px] min-w-[360px] shrink-0 flex-col gap-3 overflow-y-auto border-l border-line bg-panel p-3"
          >
            <header className="flex shrink-0 items-center gap-1">
              <h3
                className="mr-auto min-w-0 truncate font-mono text-sm font-semibold"
                title={info.name}
              >
                {info.name}
              </h3>
              <Button
                size="sm"
                icon={<Download className="h-3.5 w-3.5" aria-hidden />}
                disabled={!!transfer}
                onClick={() => download(info)}
              >
                Download
              </Button>
              <Button
                size="sm"
                aria-label="Delete object"
                icon={<Trash2 className="h-3.5 w-3.5" aria-hidden />}
                {...(readOnly ? readOnlyProps(true) : { title: 'Delete object' })}
                onClick={() => setDeleting(info)}
              />
              <Button
                size="sm"
                variant="ghost"
                aria-label="Close object detail"
                icon={<X className="h-4 w-4" aria-hidden />}
                onClick={() => setSelected(null)}
              />
            </header>
            <Facts
              columns={2}
              items={[
                ['Size', formatBytes(info.size)],
                ['Modified', formatTime(info.mtime)],
                ['Chunks', formatCount(info.chunks)],
                ...(info.revision === undefined
                  ? []
                  : [['Revision', String(info.revision)] as [string, ReactNode]]),
                ['Description', info.description],
                [
                  'Digest',
                  <span key="d" className="font-mono text-xs" title={info.digest}>
                    {info.digest}
                  </span>
                ],
                ...Object.entries(info.metadata ?? {}).map(
                  ([k, v]) => [`Metadata: ${k}`, v] as [string, ReactNode]
                ),
                ...info.headers.map(([k, v]) => [`Header: ${k}`, v] as [string, ReactNode])
              ]}
            />
            <section className="flex min-h-48 flex-1 flex-col">
              <h4 className="pb-1 text-xs font-semibold text-muted">Preview</h4>
              {!previewable ? (
                <Notice>
                  This object is larger than {formatBytes(PREVIEW_LIMIT)}, so it is not previewed.
                  Download it to see the content.
                </Notice>
              ) : preview.error ? (
                <ErrorNote error={preview.error} />
              ) : preview.isLoading || !preview.data ? (
                <Spinner />
              ) : imageType ? (
                <img
                  alt={`Preview of ${info.name}`}
                  className="max-h-full max-w-full self-start rounded-md border border-line object-contain"
                  src={`data:${imageType};base64,${preview.data.data}`}
                />
              ) : (
                <PayloadViewer
                  className="min-h-0 flex-1"
                  payload={preview.data.data}
                  size={preview.data.size}
                />
              )}
            </section>
          </aside>
        )}
      </div>

      {deleting && (
        <ConfirmDialog
          title={`Delete object ${deleting.name}`}
          confirmLabel="Delete object"
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await gateway.objDelete(connId, bucket, deleting.name)
            await client.invalidateQueries({ queryKey: ['objects', connId, bucket] })
            await client.invalidateQueries({ queryKey: ['objBuckets', connId] })
            toast.ok(`Deleted ${deleting.name}`)
            setSelected(null)
          }}
        >
          This deletes <span className="font-mono">{deleting.name}</span> (
          {formatBytes(deleting.size)}) from bucket <span className="font-mono">{bucket}</span>. It
          cannot be undone.
        </ConfirmDialog>
      )}
    </Page>
  )
}
