import { useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowRight, Pause, Pencil, Play, RefreshCw, Trash2 } from 'lucide-react'
import { GatewayError, type ConsumerInfoDto } from '@shared/api'
import { formatDuration, parseDuration } from '@shared/duration'
import { formatAgo, formatCount, formatLimit, formatTime } from '@shared/format'
import { HEALTH_LABELS } from '@shared/health'
import { versionAtLeast } from '@shared/semver'
import { MetricsPanel } from '../../components/MetricsPanel'
import { StarButton } from '../../components/StarButton'
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  CopyButton,
  Dialog,
  EmptyState,
  ErrorNote,
  Facts,
  Field,
  Input,
  Notice,
  Page,
  readOnlyProps,
  Spinner
} from '../../components/ui'
import { useGateway } from '../../gateway'
import { useConnection, useNow, useRefetchInterval } from '../../lib/hooks'
import { useTabs } from '../../state/tabs'
import { toast } from '../../state/toasts'
import { openMessages } from '../shell/nav'
import { ConsumerForm } from './ConsumerForm'
import { consumerFilters, lastActive } from './ConsumersPanel'

/** One consumer: where it is, how far behind, and its configuration (PBI-051). */
export function ConsumerTab({
  tabId,
  connId,
  stream,
  consumer
}: {
  tabId: string
  connId: string
  stream: string
  consumer: string
}): ReactNode {
  const gateway = useGateway()
  const client = useQueryClient()
  const conn = useConnection(connId)
  const tabs = useTabs()
  const now = useNow(1000)
  const refetchInterval = useRefetchInterval()
  const query = useQuery({
    queryKey: ['consumer', connId, stream, consumer],
    queryFn: () => gateway.consumerInfo(connId, stream, consumer),
    refetchInterval
  })
  const streamQuery = useQuery({
    queryKey: ['stream', connId, stream],
    queryFn: () => gateway.streamInfo(connId, stream),
    refetchInterval
  })
  const [dialog, setDialog] = useState<'edit' | 'delete' | 'pause' | null>(null)
  const info = query.data
  const readOnly = conn?.readOnly
  const canPause = versionAtLeast(conn?.state.version, '2.11.0')

  if (query.error instanceof GatewayError && query.error.kind === 'not_found') {
    return (
      <EmptyState title={`Consumer ${consumer} no longer exists`}>
        <Button onClick={() => tabs.close(tabId)}>Close tab</Button>
      </EmptyState>
    )
  }

  const resume = async (): Promise<void> => {
    try {
      await gateway.resumeConsumer(connId, stream, consumer)
      await client.invalidateQueries({ queryKey: ['consumer', connId, stream, consumer] })
      toast.ok(`Resumed consumer ${consumer}`)
    } catch (err) {
      toast.error(err)
    }
  }

  const pauseProps = !canPause
    ? {
        disabled: true,
        title: `Pausing consumers needs NATS Server 2.11 or newer. This server runs ${conn?.state.version ?? 'an older version'}.`
      }
    : readOnlyProps(readOnly)

  return (
    <Page
      title={
        <span className="flex items-center gap-2">
          <StarButton connId={connId} favorite={{ kind: 'consumer', stream, consumer }} />
          <span className="font-mono">{consumer}</span>
          {info && (
            <>
              <Badge>{info.config.durable_name ? 'durable' : 'ephemeral'}</Badge>
              <Badge>{info.config.deliver_subject ? 'push' : 'pull'}</Badge>
              {info.paused && (
                <Badge tone="warn">
                  <Pause className="mr-0.5 h-3 w-3" aria-hidden />
                  paused
                </Badge>
              )}
            </>
          )}
        </span>
      }
      subtitle={
        <>
          on stream{' '}
          <button
            className="font-mono text-accent hover:underline"
            onClick={() => tabs.open({ kind: 'stream', connId, stream })}
          >
            {stream}
          </button>
          {info?.config.description ? ` · ${info.config.description}` : ''}
        </>
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
          {info?.paused ? (
            <Button
              icon={<Play className="h-3.5 w-3.5" aria-hidden />}
              {...pauseProps}
              onClick={() => void resume()}
            >
              Resume
            </Button>
          ) : (
            <Button
              icon={<Pause className="h-3.5 w-3.5" aria-hidden />}
              {...pauseProps}
              onClick={() => setDialog('pause')}
            >
              Pause
            </Button>
          )}
          <Button
            icon={<Pencil className="h-3.5 w-3.5" aria-hidden />}
            {...readOnlyProps(readOnly)}
            onClick={() => setDialog('edit')}
          >
            Edit
          </Button>
          <Button
            variant="danger"
            icon={<Trash2 className="h-3.5 w-3.5" aria-hidden />}
            {...readOnlyProps(readOnly)}
            onClick={() => setDialog('delete')}
          >
            Delete
          </Button>
        </>
      }
    >
      <ErrorNote error={query.error} onRetry={() => void query.refetch()} />
      {query.isLoading && <Spinner label="Loading consumer" />}
      {info && (
        <div className="flex flex-col gap-4">
          {info.paused && (
            <Notice tone="warn">
              Delivery is paused
              {info.config.pause_until ? ` until ${formatTime(info.config.pause_until)}` : ''}
              {info.pause_remaining
                ? ` (${formatDuration(Math.round(info.pause_remaining / 1e9) * 1e9)} remaining)`
                : ''}
              .
            </Notice>
          )}
          {(info.health?.length ?? 0) > 0 && (
            <Notice tone="warn" className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
              <span>Needs attention: {info.health!.map((f) => HEALTH_LABELS[f]).join(', ')}.</span>
            </Notice>
          )}

          <Card title="Progress">
            <Position
              info={info}
              streamLastSeq={streamQuery.data?.state.last_seq}
              now={now}
              onShowNext={() =>
                openMessages(connId, { stream, seq: info.delivered.stream_seq + 1 })
              }
            />
          </Card>

          <MetricsPanel connId={connId} target={{ kind: 'consumer', stream, consumer }} />

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
                  [
                    'Replicas',
                    (info.cluster.replicas ?? [])
                      .map(
                        (r) =>
                          `${r.name}${r.offline ? ' (offline)' : r.current ? '' : ' (lagging)'}`
                      )
                      .join(', ') || 'none'
                  ]
                ]}
              />
            </Card>
          )}

          <Card title="Configuration">
            <Facts
              columns={3}
              items={[
                [
                  'Filter subjects',
                  <span key="f" className="font-mono text-xs">
                    {consumerFilters(info).join(', ') || 'all subjects'}
                  </span>
                ],
                ['Start delivering from', deliverLabel(info)],
                [
                  'Replay',
                  info.config.replay_policy === 'original'
                    ? 'At the original pace'
                    : 'As fast as possible'
                ],
                ['Ack policy', info.config.ack_policy],
                [
                  'Ack wait',
                  info.config.ack_wait ? formatDuration(info.config.ack_wait) : undefined
                ],
                ['Max deliveries', formatLimit(info.config.max_deliver)],
                ['Backoff', info.config.backoff?.map((ns) => formatDuration(ns)).join(', ')],
                ['Max ack pending', formatLimit(info.config.max_ack_pending)],
                [
                  'Max waiting pulls',
                  info.config.max_waiting ? formatCount(info.config.max_waiting) : undefined
                ],
                [
                  'Inactive threshold',
                  info.config.inactive_threshold
                    ? formatDuration(info.config.inactive_threshold)
                    : undefined
                ],
                ['Deliver subject', info.config.deliver_subject],
                ['Deliver group', info.config.deliver_group],
                [
                  'Replicas',
                  info.config.num_replicas ? String(info.config.num_replicas) : 'same as the stream'
                ],
                ['Created', formatTime(info.created)]
              ]}
            />
          </Card>

          <Card
            title="Raw configuration"
            actions={
              <CopyButton
                text={JSON.stringify(info.config, null, 2)}
                label="Copy configuration JSON"
              />
            }
          >
            <pre className="max-h-96 overflow-auto rounded-md bg-code p-3 font-mono text-xs leading-5">
              {JSON.stringify(info.config, null, 2)}
            </pre>
          </Card>
        </div>
      )}

      {info && dialog === 'edit' && (
        <ConsumerForm
          connId={connId}
          stream={stream}
          existing={info}
          onClose={() => setDialog(null)}
        />
      )}
      {info && dialog === 'pause' && (
        <PauseDialog
          connId={connId}
          stream={stream}
          consumer={consumer}
          onClose={() => setDialog(null)}
        />
      )}
      {info && dialog === 'delete' && (
        <ConfirmDialog
          title={`Delete consumer ${consumer}`}
          confirmLabel="Delete consumer"
          typeToConfirm={consumer}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await gateway.deleteConsumer(connId, stream, consumer)
            await client.invalidateQueries({ queryKey: ['consumers', connId] })
            toast.ok(`Deleted consumer ${consumer}`)
            tabs.close(tabId)
          }}
        >
          On <strong>{conn?.name}</strong>, this deletes consumer{' '}
          <span className="font-mono">{consumer}</span> of stream{' '}
          <span className="font-mono">{stream}</span>. Its position is lost:{' '}
          <strong>{formatCount(info.num_pending)}</strong> messages are still pending and{' '}
          <strong>{formatCount(info.num_ack_pending)}</strong> are waiting for an acknowledgement.
        </ConfirmDialog>
      )}
    </Page>
  )
}

function deliverLabel(info: ConsumerInfoDto): string {
  switch (info.config.deliver_policy) {
    case 'last':
      return 'The last message'
    case 'new':
      return 'New messages only'
    case 'by_start_sequence':
      return `Sequence ${info.config.opt_start_seq}`
    case 'by_start_time':
      return `Time ${formatTime(info.config.opt_start_time)}`
    case 'last_per_subject':
      return 'The last message of each subject'
    default:
      return 'All messages'
  }
}

function Position({
  info,
  streamLastSeq,
  now,
  onShowNext
}: {
  info: ConsumerInfoDto
  streamLastSeq: number | undefined
  now: number
  onShowNext: () => void
}): ReactNode {
  const active = lastActive(info)
  const tile = (label: string, value: ReactNode, hint: string, tone?: 'warn'): ReactNode => (
    <div className="min-w-0">
      <p className="text-xs text-muted">{label}</p>
      <p
        className={`tabular text-xl font-semibold ${tone === 'warn' ? 'text-warn' : ''}`}
        data-testid={`consumer-${label.toLowerCase().replace(/\s+/g, '-')}`}
      >
        {value}
      </p>
      <p className="text-xs text-faint">{hint}</p>
    </div>
  )
  const atMax =
    (info.config.max_ack_pending ?? 0) > 0 &&
    info.num_ack_pending >= (info.config.max_ack_pending ?? 0)
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {tile('Pending', formatCount(info.num_pending), 'Not yet delivered (the lag)')}
        {tile(
          'Ack pending',
          formatCount(info.num_ack_pending),
          atMax ? 'At the maximum: delivery is held back' : 'Delivered, waiting for an ack',
          atMax ? 'warn' : undefined
        )}
        {tile('Redelivered', formatCount(info.num_redelivered), 'Delivered more than once')}
        {tile('Waiting pulls', formatCount(info.num_waiting), 'Clients asking for messages')}
      </div>
      <Facts
        columns={3}
        items={[
          [
            'Last delivered',
            `stream #${formatCount(info.delivered.stream_seq)} · consumer #${formatCount(info.delivered.consumer_seq)}`
          ],
          [
            'Ack floor',
            `stream #${formatCount(info.ack_floor.stream_seq)} · consumer #${formatCount(info.ack_floor.consumer_seq)}`
          ],
          [
            'Stream last sequence',
            streamLastSeq !== undefined ? `#${formatCount(streamLastSeq)}` : undefined
          ],
          [
            'Last delivery',
            info.delivered.last_active
              ? `${formatTime(info.delivered.last_active)} (${formatAgo(info.delivered.last_active, now)})`
              : 'never'
          ],
          [
            'Last ack',
            info.ack_floor.last_active
              ? `${formatTime(info.ack_floor.last_active)} (${formatAgo(info.ack_floor.last_active, now)})`
              : 'never'
          ],
          ['Last active', active ? formatAgo(active, now) : 'never']
        ]}
      />
      <div>
        <Button
          icon={<ArrowRight className="h-3.5 w-3.5" aria-hidden />}
          disabled={info.num_pending === 0}
          title={info.num_pending === 0 ? 'Nothing is waiting to be delivered' : undefined}
          onClick={onShowNext}
        >
          Show the next undelivered message
        </Button>
      </div>
    </div>
  )
}

/** Pauses delivery until a chosen time (PBI-053). */
function PauseDialog({
  connId,
  stream,
  consumer,
  onClose
}: {
  connId: string
  stream: string
  consumer: string
  onClose: () => void
}): ReactNode {
  const gateway = useGateway()
  const client = useQueryClient()
  const [text, setText] = useState('15m')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const ns = parseDuration(text)
  const invalid = ns === null || ns <= 0
  const now = useNow(1000)
  const until = invalid ? null : new Date(now + ns / 1e6)

  const submit = async (): Promise<void> => {
    if (!until) return
    setBusy(true)
    setError(null)
    try {
      await gateway.pauseConsumer(connId, stream, consumer, until.toISOString())
      await client.invalidateQueries({ queryKey: ['consumer', connId, stream, consumer] })
      await client.invalidateQueries({ queryKey: ['consumers', connId] })
      toast.ok(`Paused consumer ${consumer} until ${formatTime(until.getTime())}`)
      onClose()
    } catch (err) {
      setError(err)
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={`Pause consumer ${consumer}`}
      onClose={onClose}
      width={420}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} disabled={invalid} onClick={() => void submit()}>
            Pause
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
        <p className="text-muted">
          The server stops delivering messages to this consumer until the time is up. Nothing is
          lost; you can resume earlier.
        </p>
        <Field
          label="Pause for"
          error={invalid ? 'Enter a duration such as 15m, 2h or 1d' : null}
          hint={until ? `Until ${formatTime(until.getTime())}` : undefined}
        >
          {(id) => (
            <Input
              id={id}
              autoFocus
              invalid={invalid}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          )}
        </Field>
        <div className="flex gap-1.5">
          {['5m', '15m', '1h', '4h', '1d'].map((preset) => (
            <Button key={preset} size="sm" onClick={() => setText(preset)}>
              {preset}
            </Button>
          ))}
        </div>
        <ErrorNote error={error} />
      </form>
    </Dialog>
  )
}
