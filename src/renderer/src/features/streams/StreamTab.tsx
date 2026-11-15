import { useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Eraser, Pencil, RefreshCw, Trash2 } from 'lucide-react'
import {
  GatewayError,
  type PeerInfoDto,
  type StreamConfigDto,
  type StreamInfoDto
} from '@shared/api'
import { formatDuration } from '@shared/duration'
import { formatAgo, formatBytes, formatCount, formatLimit, formatTime } from '@shared/format'
import { MetricsPanel } from '../../components/MetricsPanel'
import { StarButton } from '../../components/StarButton'
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  CopyButton,
  EmptyState,
  ErrorNote,
  Facts,
  Page,
  readOnlyProps,
  Spinner,
  SubTabs
} from '../../components/ui'
import { useGateway } from '../../gateway'
import { useConnection, useNow, useRefetchInterval } from '../../lib/hooks'
import { useTabs, type StreamSection } from '../../state/tabs'
import { toast } from '../../state/toasts'
import { ConsumersPanel } from '../consumers/ConsumersPanel'
import { MessageBrowser } from '../messages/MessageBrowser'
import { PurgeDialog } from './PurgeDialog'
import { StreamForm } from './StreamForm'
import { ExportDialog } from './StreamsTab'
import { StreamSubjects } from './StreamSubjects'

const SECTIONS: { id: StreamSection; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'messages', label: 'Messages' },
  { id: 'consumers', label: 'Consumers' },
  { id: 'subjects', label: 'Subjects' },
  { id: 'config', label: 'Configuration' }
]

/** One stream: state, messages, consumers, subjects and configuration (PBI-031). */
export function StreamTab({
  tabId,
  connId,
  stream,
  section = 'overview',
  subject,
  seq
}: {
  tabId: string
  connId: string
  stream: string
  section?: StreamSection
  subject?: string
  seq?: number
}): ReactNode {
  const gateway = useGateway()
  const client = useQueryClient()
  const conn = useConnection(connId)
  const tabs = useTabs()
  const refetchInterval = useRefetchInterval()
  const query = useQuery({
    queryKey: ['stream', connId, stream],
    queryFn: () => gateway.streamInfo(connId, stream),
    refetchInterval
  })
  const [dialog, setDialog] = useState<'edit' | 'purge' | 'delete' | 'export' | null>(null)
  // Sections are created on first visit and then kept, so the message browser keeps its place.
  const [visited, setVisited] = useState<Set<StreamSection>>(() => new Set([section]))
  const info = query.data
  const readOnly = conn?.readOnly

  const go = (next: StreamSection, patch: { subject?: string; seq?: number } = {}): void => {
    setVisited((v) => new Set(v).add(next))
    tabs.patch(tabId, { section: next, ...patch })
  }
  if (!visited.has(section)) setVisited((v) => new Set(v).add(section))

  if (query.error instanceof GatewayError && query.error.kind === 'not_found') {
    return (
      <EmptyState title={`Stream ${stream} no longer exists`}>
        <Button onClick={() => tabs.close(tabId)}>Close tab</Button>
      </EmptyState>
    )
  }

  return (
    <Page
      scroll={false}
      title={
        <span className="flex items-center gap-2">
          <StarButton connId={connId} favorite={{ kind: 'stream', stream }} />
          <span className="font-mono">{stream}</span>
          {info && (
            <>
              <Badge>{info.config.storage}</Badge>
              <Badge>{info.config.retention}</Badge>
              {(info.config.num_replicas ?? 1) > 1 && <Badge>R{info.config.num_replicas}</Badge>}
              {info.config.sealed && <Badge tone="warn">sealed</Badge>}
            </>
          )}
        </span>
      }
      subtitle={info?.config.description}
      actions={
        <Button
          icon={<RefreshCw className="h-3.5 w-3.5" aria-hidden />}
          busy={query.isFetching && !query.isLoading}
          onClick={() => void query.refetch()}
        >
          Refresh
        </Button>
      }
    >
      <div className="shrink-0 bg-panel">
        <SubTabs tabs={SECTIONS} active={section} onChange={(next) => go(next)} />
      </div>
      {query.error ? (
        <ErrorNote className="m-4" error={query.error} onRetry={() => void query.refetch()} />
      ) : !info ? (
        <div className="p-6">
          <Spinner label="Loading stream" />
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <div hidden={section !== 'overview'} className="h-full overflow-y-auto p-4">
            {visited.has('overview') && <Overview connId={connId} info={info} />}
          </div>
          <div hidden={section !== 'messages'} className="h-full">
            {visited.has('messages') && (
              <MessageBrowser
                connId={connId}
                info={info}
                requestSubject={subject}
                requestSeq={seq}
              />
            )}
          </div>
          <div hidden={section !== 'consumers'} className="h-full">
            {visited.has('consumers') && <ConsumersPanel connId={connId} stream={stream} />}
          </div>
          <div hidden={section !== 'subjects'} className="h-full">
            {visited.has('subjects') && (
              <StreamSubjects
                connId={connId}
                stream={stream}
                onBrowse={(s) => go('messages', { subject: s, seq: undefined })}
              />
            )}
          </div>
          <div hidden={section !== 'config'} className="h-full overflow-y-auto p-4">
            {visited.has('config') && (
              <Configuration
                info={info}
                actions={
                  <>
                    <Button
                      icon={<Pencil className="h-3.5 w-3.5" aria-hidden />}
                      {...readOnlyProps(readOnly)}
                      onClick={() => setDialog('edit')}
                    >
                      Edit
                    </Button>
                    <Button
                      icon={<Download className="h-3.5 w-3.5" aria-hidden />}
                      onClick={() => setDialog('export')}
                    >
                      Export
                    </Button>
                    <Button
                      icon={<Eraser className="h-3.5 w-3.5" aria-hidden />}
                      {...(info.config.deny_purge
                        ? {
                            disabled: true,
                            title: 'This stream does not allow purging (deny_purge)'
                          }
                        : readOnlyProps(readOnly))}
                      onClick={() => setDialog('purge')}
                    >
                      Purge
                    </Button>
                    <Button
                      variant="danger"
                      icon={<Trash2 className="h-3.5 w-3.5" aria-hidden />}
                      {...readOnlyProps(readOnly)}
                      onClick={() => setDialog('delete')}
                    >
                      Delete stream
                    </Button>
                  </>
                }
              />
            )}
          </div>
        </div>
      )}

      {info && dialog === 'edit' && (
        <StreamForm connId={connId} existing={info} onClose={() => setDialog(null)} />
      )}
      {info && dialog === 'purge' && (
        <PurgeDialog connId={connId} info={info} onClose={() => setDialog(null)} />
      )}
      {info && dialog === 'export' && (
        <ExportDialog connId={connId} streams={[info]} onClose={() => setDialog(null)} />
      )}
      {info && dialog === 'delete' && (
        <ConfirmDialog
          title={`Delete stream ${stream}`}
          confirmLabel="Delete stream"
          typeToConfirm={stream}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await gateway.deleteStream(connId, stream)
            await client.invalidateQueries({ queryKey: ['streams', connId] })
            toast.ok(`Deleted stream ${stream}`)
            tabs.close(tabId)
          }}
        >
          On <strong>{conn?.name}</strong>, this deletes stream{' '}
          <span className="font-mono">{stream}</span> with its{' '}
          <strong>{formatCount(info.state.messages)}</strong> messages and{' '}
          <strong>{formatCount(info.state.consumer_count)}</strong> consumers. This cannot be
          undone.
        </ConfirmDialog>
      )}
    </Page>
  )
}

function peerStatus(peer: PeerInfoDto): ReactNode {
  if (peer.offline) return <Badge tone="danger">offline</Badge>
  if (!peer.current) return <Badge tone="warn">lagging</Badge>
  return <Badge tone="ok">current</Badge>
}

function Overview({ connId, info }: { connId: string; info: StreamInfoDto }): ReactNode {
  const now = useNow(5000)
  const s = info.state
  const hasMessages = s.messages > 0
  return (
    <div className="flex flex-col gap-4">
      <Card title="State">
        <Facts
          columns={3}
          items={[
            ['Messages', formatCount(s.messages)],
            ['Size', formatBytes(s.bytes)],
            ['Consumers', formatCount(s.consumer_count)],
            [
              'First sequence',
              hasMessages
                ? `${formatCount(s.first_seq)} · ${formatTime(s.first_ts)}`
                : formatCount(s.first_seq)
            ],
            [
              'Last sequence',
              s.last_seq > 0 ? `${formatCount(s.last_seq)} · ${formatTime(s.last_ts)}` : '0'
            ],
            ['Last message', formatAgo(s.last_ts, now)],
            ['Deleted messages', formatCount(s.num_deleted ?? 0)],
            ['Subjects', s.num_subjects !== undefined ? formatCount(s.num_subjects) : undefined],
            ['Created', formatTime(info.created)]
          ]}
        />
      </Card>

      <MetricsPanel connId={connId} target={{ kind: 'stream', stream: info.config.name }} />

      {info.cluster && (
        <Card title="Cluster">
          <Facts
            columns={3}
            items={[
              ['Cluster', info.cluster.name],
              [
                'Leader',
                info.cluster.leader || (
                  <Badge key="l" tone="danger">
                    no leader
                  </Badge>
                )
              ],
              ['Replicas', String((info.cluster.replicas?.length ?? 0) + 1)]
            ]}
          />
          {(info.cluster.replicas?.length ?? 0) > 0 && (
            <table className="mt-3 w-full border-collapse text-xs">
              <thead>
                <tr className="text-left text-muted">
                  <th className="py-1 pr-3 font-semibold">Replica</th>
                  <th className="py-1 pr-3 font-semibold">Status</th>
                  <th className="py-1 pr-3 font-semibold">Lag</th>
                  <th className="py-1 pr-3 font-semibold">Last active</th>
                </tr>
              </thead>
              <tbody>
                {info.cluster.replicas!.map((peer) => (
                  <tr key={peer.name} className="border-t border-line">
                    <td className="py-1 pr-3 font-medium">{peer.name}</td>
                    <td className="py-1 pr-3">{peerStatus(peer)}</td>
                    <td className="tabular py-1 pr-3">{formatCount(peer.lag ?? 0)}</td>
                    <td className="py-1 pr-3">{formatDuration(peer.active)} ago</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      {(info.mirror || info.sources?.length) && (
        <Card title="Mirror and sources">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="text-left text-muted">
                <th className="py-1 pr-3 font-semibold">Role</th>
                <th className="py-1 pr-3 font-semibold">Stream</th>
                <th className="py-1 pr-3 font-semibold">Lag</th>
                <th className="py-1 pr-3 font-semibold">Last active</th>
                <th className="py-1 pr-3 font-semibold">Error</th>
              </tr>
            </thead>
            <tbody>
              {[
                ...(info.mirror ? [{ role: 'Mirror of', ...info.mirror }] : []),
                ...(info.sources ?? []).map((src) => ({ role: 'Source', ...src }))
              ].map((src) => (
                <tr key={`${src.role}:${src.name}`} className="border-t border-line">
                  <td className="py-1 pr-3">{src.role}</td>
                  <td className="py-1 pr-3 font-mono">{src.name}</td>
                  <td className="tabular py-1 pr-3">
                    {src.lag > 0 ? (
                      <Badge tone="warn">{formatCount(src.lag)} behind</Badge>
                    ) : (
                      'In sync'
                    )}
                  </td>
                  <td className="py-1 pr-3">
                    {src.active < 0 ? 'never' : `${formatDuration(src.active)} ago`}
                  </td>
                  <td className="py-1 pr-3 text-danger">{src.error?.description ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  )
}

function Configuration({ info, actions }: { info: StreamInfoDto; actions: ReactNode }): ReactNode {
  const c: StreamConfigDto = info.config
  const yesNo = (v: unknown): string => (v ? 'Yes' : 'No')
  const json = JSON.stringify(c, null, 2)
  return (
    <div className="flex flex-col gap-4">
      <Card title="Settings" actions={actions}>
        <Facts
          columns={3}
          items={[
            [
              'Name',
              <span key="n" className="font-mono">
                {c.name}
              </span>
            ],
            ['Description', c.description],
            [
              'Subjects',
              <span key="s" className="font-mono text-xs" title={(c.subjects ?? []).join('\n')}>
                {(c.subjects ?? []).join(', ')}
              </span>
            ],
            ['Storage', c.storage],
            ['Retention', c.retention],
            ['Replicas', String(c.num_replicas ?? 1)],
            ['Max messages', formatLimit(c.max_msgs)],
            ['Max bytes', formatLimit(c.max_bytes, true)],
            ['Max age', c.max_age ? formatDuration(c.max_age) : 'unlimited'],
            ['Max message size', formatLimit(c.max_msg_size, true)],
            ['Max messages per subject', formatLimit(c.max_msgs_per_subject)],
            ['Max consumers', formatLimit(c.max_consumers)],
            ['When full', c.discard === 'new' ? 'Refuse new messages' : 'Discard oldest'],
            [
              'Duplicate window',
              c.duplicate_window ? formatDuration(c.duplicate_window) : undefined
            ],
            ['Compression', c.compression ?? 'none'],
            ['Allow direct get', yesNo(c.allow_direct)],
            ['Allow rollup headers', yesNo(c.allow_rollup_hdrs)],
            ['Deny delete', yesNo(c.deny_delete)],
            ['Deny purge', yesNo(c.deny_purge)],
            ['Mirror of', c.mirror?.name],
            ['Sources', c.sources?.map((s) => s.name).join(', ')]
          ]}
        />
      </Card>
      <Card
        title="Raw configuration"
        actions={<CopyButton text={json} label="Copy configuration JSON" />}
      >
        <pre
          className="max-h-[480px] overflow-auto rounded-md bg-code p-3 font-mono text-xs leading-5"
          data-testid="stream-config-json"
        >
          {json}
        </pre>
      </Card>
    </div>
  )
}
