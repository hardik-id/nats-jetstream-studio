import { type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import type { AccountStatsDto } from '@shared/api'
import { formatBytes, formatCount, formatLimit } from '@shared/format'
import { HEALTH_LABELS } from '@shared/health'
import {
  Badge,
  Button,
  Card,
  ErrorNote,
  Facts,
  Meter,
  Notice,
  Page,
  Spinner
} from '../../components/ui'
import { useGateway } from '../../gateway'
import { useRefetchInterval } from '../../lib/hooks'
import { useTabs } from '../../state/tabs'

/** Server details, JetStream usage against limits, consumer health and cluster topology. */
export function OverviewTab({ connId }: { connId: string }): ReactNode {
  const gateway = useGateway()
  const open = useTabs((s) => s.open)
  const refetchInterval = useRefetchInterval()
  const server = useQuery({
    queryKey: ['serverInfo', connId],
    queryFn: () => gateway.serverInfo(connId),
    refetchInterval
  })
  const account = useQuery({
    queryKey: ['accountInfo', connId],
    queryFn: () => gateway.accountInfo(connId),
    refetchInterval
  })
  const health = useQuery({
    queryKey: ['healthSummary', connId],
    queryFn: () => gateway.healthSummary(connId),
    refetchInterval
  })
  const cluster = useQuery({
    queryKey: ['clusterInfo', connId],
    queryFn: () => gateway.clusterInfo(connId),
    refetchInterval: useRefetchInterval(15_000)
  })
  const s = server.data

  const refresh = (): void => {
    void server.refetch()
    void account.refetch()
    void health.refetch()
    void cluster.refetch()
  }

  return (
    <Page
      title="Overview"
      subtitle={s ? `${s.serverName} · NATS ${s.version}` : undefined}
      actions={
        <Button
          icon={<RefreshCw className="h-3.5 w-3.5" aria-hidden />}
          busy={server.isFetching && !server.isLoading}
          onClick={refresh}
        >
          Refresh
        </Button>
      }
    >
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card title="Server">
          <ErrorNote error={server.error} />
          {server.isLoading && <Spinner />}
          {s && (
            <Facts
              columns={3}
              items={[
                ['Server name', s.serverName],
                ['Version', s.version],
                ['Cluster', s.cluster],
                [
                  'Connected to',
                  <span key="u" className="font-mono text-xs">
                    {s.connectedUrl}
                  </span>
                ],
                ['Round trip', `${s.rttMs} ms`],
                ['Max payload', formatBytes(s.maxPayload)],
                ['TLS', s.tls ? 'In use' : 'Not in use'],
                ['JetStream domain', s.jsDomain],
                ['User', s.user],
                ['Account', s.account],
                ['Client ID', String(s.clientId)],
                ['Client IP', s.clientIp]
              ]}
            />
          )}
        </Card>

        <Card title="JetStream account">
          <ErrorNote error={account.error} />
          {account.isLoading && <Spinner />}
          {account.data && !account.data.enabled && (
            <Notice tone="warn">{account.data.reason}</Notice>
          )}
          {account.data?.enabled && <AccountUsage stats={account.data.stats} />}
        </Card>

        <Card title="Consumer health">
          <ErrorNote error={health.error} />
          {health.data &&
            (health.data.total === 0 ? (
              <p className="text-muted">No consumers have been sampled yet.</p>
            ) : health.data.unhealthy === 0 ? (
              <p>
                <Badge tone="ok">Healthy</Badge>{' '}
                <span className="ml-1">
                  All {formatCount(health.data.total)} consumers look fine.
                </span>
              </p>
            ) : (
              <>
                <p className="mb-2">
                  <Badge tone="warn">{health.data.unhealthy} need attention</Badge>{' '}
                  <span className="ml-1 text-muted">
                    of {formatCount(health.data.total)} consumers
                  </span>
                </p>
                <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto">
                  {health.data.items.map((item) => (
                    <li key={`${item.stream}/${item.consumer}`} className="flex items-center gap-2">
                      <button
                        className="truncate font-mono text-xs text-accent hover:underline"
                        onClick={() =>
                          open({
                            kind: 'consumer',
                            connId,
                            stream: item.stream,
                            consumer: item.consumer
                          })
                        }
                      >
                        {item.stream} / {item.consumer}
                      </button>
                      {item.flags.map((flag) => (
                        <Badge key={flag} tone="warn">
                          {HEALTH_LABELS[flag]}
                        </Badge>
                      ))}
                    </li>
                  ))}
                </ul>
              </>
            ))}
        </Card>

        <Card title="Cluster">
          <ErrorNote error={cluster.error} />
          {cluster.isLoading && <Spinner />}
          {cluster.data && !cluster.data.available && (
            <p className="text-muted">{cluster.data.reason}</p>
          )}
          {cluster.data?.available && (
            <div className="flex flex-col gap-3">
              <p className="text-xs text-muted">
                The leader and replica state of each stream and consumer are on its own page.{' '}
                <button
                  className="text-accent hover:underline"
                  onClick={() => open({ kind: 'streams', connId })}
                >
                  Open streams
                </button>
              </p>
              {cluster.data.meta && (
                <Facts
                  columns={3}
                  items={[
                    ['JetStream meta leader', cluster.data.meta.leader || 'No leader'],
                    [
                      'Meta group size',
                      cluster.data.meta.clusterSize
                        ? String(cluster.data.meta.clusterSize)
                        : undefined
                    ],
                    [
                      'Meta replicas',
                      cluster.data.meta.replicas.length
                        ? cluster.data.meta.replicas
                            .map(
                              (r) =>
                                `${r.name}${r.offline ? ' (offline)' : r.current ? '' : ' (lagging)'}`
                            )
                            .join(', ')
                        : undefined
                    ]
                  ]}
                />
              )}
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="text-left text-muted">
                      {[
                        'Server',
                        'Version',
                        'Conns',
                        'Subs',
                        'CPU',
                        'Memory',
                        'Routes',
                        'Gateways',
                        'Leaf nodes',
                        'JS streams',
                        'JS storage'
                      ].map((h) => (
                        <th key={h} className="py-1 pr-3 font-semibold whitespace-nowrap">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {cluster.data.servers.map((srv) => (
                      <tr key={srv.id} className="border-t border-line">
                        <td className="py-1 pr-3 font-medium whitespace-nowrap">
                          {srv.name}
                          {cluster.data.meta?.leader === srv.name && (
                            <Badge tone="accent" className="ml-1.5">
                              meta leader
                            </Badge>
                          )}
                        </td>
                        <td className="py-1 pr-3">{srv.version}</td>
                        <td className="tabular py-1 pr-3">{formatCount(srv.connections)}</td>
                        <td className="tabular py-1 pr-3">{formatCount(srv.subscriptions)}</td>
                        <td className="tabular py-1 pr-3">{srv.cpu.toFixed(1)}%</td>
                        <td className="tabular py-1 pr-3">{formatBytes(srv.mem)}</td>
                        <td className="py-1 pr-3" title={srv.routes.map((r) => r.name).join(', ')}>
                          {srv.routes.length}
                        </td>
                        <td
                          className="py-1 pr-3"
                          title={srv.gateways.map((g) => g.name).join(', ')}
                        >
                          {srv.gateways.length}
                        </td>
                        <td className="tabular py-1 pr-3">{srv.leafnodes}</td>
                        <td className="tabular py-1 pr-3">
                          {srv.jetstream ? formatCount(srv.jetstream.streams) : '-'}
                        </td>
                        <td className="tabular py-1 pr-3">
                          {srv.jetstream ? formatBytes(srv.jetstream.storageUsed) : '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </Card>
      </div>
    </Page>
  )
}

function AccountUsage({ stats }: { stats: AccountStatsDto }): ReactNode {
  const rows: { label: string; used: number; max: number; bytes: boolean }[] = [
    { label: 'File storage', used: stats.storage, max: stats.limits.max_storage, bytes: true },
    { label: 'Memory storage', used: stats.memory, max: stats.limits.max_memory, bytes: true },
    { label: 'Streams', used: stats.streams, max: stats.limits.max_streams, bytes: false },
    { label: 'Consumers', used: stats.consumers, max: stats.limits.max_consumers, bytes: false }
  ]
  const show = (n: number, bytes: boolean): string => (bytes ? formatBytes(n) : formatCount(n))
  return (
    <div className="flex flex-col gap-3">
      {rows.map((row) => (
        <div key={row.label} data-testid={`usage-${row.label}`}>
          <div className="flex items-baseline justify-between pb-1">
            <span className="text-muted">{row.label}</span>
            <span className="tabular">
              <strong className="font-semibold">{show(row.used, row.bytes)}</strong>
              <span className="text-muted"> of {formatLimit(row.max, row.bytes)}</span>
              {row.max > 0 && (
                <span className="ml-1.5 text-faint">
                  ({((row.used / row.max) * 100).toFixed(row.used / row.max < 0.1 ? 1 : 0)}%)
                </span>
              )}
            </span>
          </div>
          <Meter value={row.used} max={row.max} label={row.label} />
        </div>
      ))}
      <Facts
        columns={3}
        items={[
          ['API requests', formatCount(stats.api.total)],
          [
            'API errors',
            stats.api.errors > 0 ? (
              <span key="e" className="text-warn">
                {formatCount(stats.api.errors)}
              </span>
            ) : (
              '0'
            )
          ],
          ['Domain', stats.domain]
        ]}
      />
    </div>
  )
}
