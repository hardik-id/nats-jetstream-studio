import { useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, RefreshCw, Trash2 } from 'lucide-react'
import type { ObjBucketDto } from '@shared/api'
import { formatBytes, formatCount, parseBytes } from '@shared/format'
import { DataTable, type Column } from '../../components/DataTable'
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  ErrorNote,
  Field,
  Input,
  Page,
  readOnlyProps,
  Select,
  Spinner
} from '../../components/ui'
import { useGateway } from '../../gateway'
import { useConnection, useRefetchInterval } from '../../lib/hooks'
import { useTabs } from '../../state/tabs'
import { toast } from '../../state/toasts'

/** Object Store buckets of a connection (PBI-071). */
export function ObjectsTab({ connId }: { connId: string }): ReactNode {
  const gateway = useGateway()
  const client = useQueryClient()
  const conn = useConnection(connId)
  const open = useTabs((s) => s.open)
  const refetchInterval = useRefetchInterval(10_000)
  const query = useQuery({
    queryKey: ['objBuckets', connId],
    queryFn: () => gateway.listObjBuckets(connId),
    refetchInterval
  })
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<ObjBucketDto | null>(null)
  const readOnly = conn?.readOnly

  const columns: Column<ObjBucketDto>[] = [
    {
      id: 'bucket',
      header: 'Bucket',
      width: 'minmax(180px, 2fr)',
      sort: (b) => b.bucket,
      cell: (b) => (
        <span className="flex items-center gap-1.5">
          <button
            className="truncate font-medium text-accent hover:underline"
            onClick={() => open({ kind: 'objBucket', connId, bucket: b.bucket })}
          >
            {b.bucket}
          </button>
          {b.sealed && <Badge tone="warn">sealed</Badge>}
        </span>
      )
    },
    {
      id: 'description',
      header: 'Description',
      width: 'minmax(140px, 2fr)',
      cell: (b) => b.description ?? ''
    },
    {
      id: 'objects',
      header: 'Objects',
      width: '96px',
      align: 'right',
      sort: (b) => b.objects,
      cell: (b) => formatCount(b.objects)
    },
    {
      id: 'size',
      header: 'Size',
      width: '104px',
      align: 'right',
      sort: (b) => b.size,
      cell: (b) => formatBytes(b.size)
    },
    {
      id: 'storage',
      header: 'Storage',
      width: '80px',
      sort: (b) => b.storage,
      cell: (b) => b.storage
    },
    {
      id: 'replicas',
      header: 'Replicas',
      width: '80px',
      align: 'right',
      sort: (b) => b.replicas,
      cell: (b) => b.replicas
    },
    {
      id: 'actions',
      header: '',
      width: '44px',
      cell: (b) => (
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Delete bucket ${b.bucket}`}
          icon={<Trash2 className="h-3.5 w-3.5" aria-hidden />}
          {...(readOnly ? readOnlyProps(true) : { title: 'Delete bucket' })}
          onClick={(e) => {
            e.stopPropagation()
            setDeleting(b)
          }}
        />
      )
    }
  ]

  return (
    <Page
      scroll={false}
      title="Object stores"
      subtitle={
        query.data
          ? `${formatCount(query.data.length)} ${query.data.length === 1 ? 'bucket' : 'buckets'}`
          : undefined
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
            icon={<Plus className="h-4 w-4" aria-hidden />}
            {...readOnlyProps(readOnly)}
            onClick={() => setCreating(true)}
          >
            New bucket
          </Button>
        </>
      }
    >
      {query.error ? (
        <ErrorNote className="m-4" error={query.error} onRetry={() => void query.refetch()} />
      ) : query.isLoading ? (
        <div className="p-6">
          <Spinner label="Loading buckets" />
        </div>
      ) : (
        <div className="min-h-0 flex-1 bg-panel">
          <DataTable
            ariaLabel="Object store buckets"
            rows={query.data ?? []}
            columns={columns}
            rowKey={(b) => b.bucket}
            defaultSort={{ id: 'bucket', dir: 'asc' }}
            onOpen={(b) => open({ kind: 'objBucket', connId, bucket: b.bucket })}
            empty="This account has no object store buckets"
          />
        </div>
      )}

      {creating && <ObjBucketForm connId={connId} onClose={() => setCreating(false)} />}
      {deleting && (
        <ConfirmDialog
          title={`Delete object store ${deleting.bucket}`}
          confirmLabel="Delete bucket"
          typeToConfirm={deleting.bucket}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await gateway.deleteObjBucket(connId, deleting.bucket)
            await client.invalidateQueries({ queryKey: ['objBuckets', connId] })
            toast.ok(`Deleted bucket ${deleting.bucket}`)
          }}
        >
          On <strong>{conn?.name}</strong>, this deletes bucket{' '}
          <span className="font-mono">{deleting.bucket}</span> and its{' '}
          <strong>{formatCount(deleting.objects)}</strong> objects ({formatBytes(deleting.size)}).
          This cannot be undone.
        </ConfirmDialog>
      )}
    </Page>
  )
}

function ObjBucketForm({ connId, onClose }: { connId: string; onClose: () => void }): ReactNode {
  const gateway = useGateway()
  const client = useQueryClient()
  const open = useTabs((s) => s.open)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [storage, setStorage] = useState<'file' | 'memory'>('file')
  const [replicas, setReplicas] = useState('1')
  const [maxBytes, setMaxBytes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const nameError =
    name && !/^[A-Za-z0-9_-]+$/.test(name) ? 'Use letters, digits, "_" and "-" only' : null
  const bytes = maxBytes.trim() ? parseBytes(maxBytes) : 0
  const bytesError = bytes === null ? 'Enter a size such as 100MB or 1GiB' : null
  const valid = name && !nameError && !bytesError

  const submit = async (): Promise<void> => {
    if (!valid) return
    setBusy(true)
    setError(null)
    try {
      await gateway.createObjBucket(connId, {
        bucket: name,
        description: description.trim() || undefined,
        storage,
        replicas: Number(replicas) || 1,
        maxBytes: bytes || undefined
      })
      await client.invalidateQueries({ queryKey: ['objBuckets', connId] })
      toast.ok(`Created bucket ${name}`)
      open({ kind: 'objBucket', connId, bucket: name })
      onClose()
    } catch (err) {
      setError(err)
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="New object store bucket"
      onClose={onClose}
      width={520}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} disabled={!valid} onClick={() => void submit()}>
            Create bucket
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
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name" error={nameError}>
            {(id) => (
              <Input
                id={id}
                mono
                autoFocus
                invalid={!!nameError}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          <Field label="Description">
            {(id) => (
              <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} />
            )}
          </Field>
          <Field label="Storage">
            {(id) => (
              <Select
                id={id}
                value={storage}
                onChange={(e) => setStorage(e.target.value as 'file' | 'memory')}
              >
                <option value="file">File</option>
                <option value="memory">Memory</option>
              </Select>
            )}
          </Field>
          <Field label="Replicas">
            {(id) => (
              <Input
                id={id}
                type="number"
                min={1}
                max={5}
                value={replicas}
                onChange={(e) => setReplicas(e.target.value)}
              />
            )}
          </Field>
          <Field label="Max size" error={bytesError} hint="Empty: unlimited.">
            {(id) => (
              <Input
                id={id}
                placeholder="unlimited"
                invalid={!!bytesError}
                value={maxBytes}
                onChange={(e) => setMaxBytes(e.target.value)}
              />
            )}
          </Field>
        </div>
        <ErrorNote error={error} />
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}
