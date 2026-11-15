import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  CheckCircle2,
  ChevronRight,
  CircleSlash,
  Hexagon,
  Loader2,
  Lock,
  LogOut,
  Search,
  XCircle
} from 'lucide-react'
import type { ConnectionStatus } from '../../../../shared/api'
import { Badge, Button, Kbd } from '../../components/ui'
import { useGateway } from '../../gateway'
import { useAppInfo, useConnection } from '../../lib/hooks'
import { useTabs } from '../../state/tabs'
import { useOverlays } from '../../state/ui'

function stateView(
  status: ConnectionStatus,
  rttMs: number | undefined
): { text: string; tone: string; icon: ReactNode } {
  const cls = 'h-3.5 w-3.5 shrink-0'
  switch (status) {
    case 'connected':
      return {
        text: rttMs === undefined ? 'Connected' : `Connected · ${rttMs} ms`,
        tone: 'text-ok',
        icon: <CheckCircle2 className={cls} aria-hidden />
      }
    case 'reconnecting':
      return {
        text: 'Reconnecting',
        tone: 'text-warn',
        icon: <Loader2 className={`${cls} animate-spin`} aria-hidden />
      }
    case 'connecting':
      return {
        text: 'Connecting',
        tone: 'text-warn',
        icon: <Loader2 className={`${cls} animate-spin`} aria-hidden />
      }
    case 'error':
      return { text: 'Error', tone: 'text-danger', icon: <XCircle className={cls} aria-hidden /> }
    default:
      return {
        text: 'Disconnected',
        tone: 'text-faint',
        icon: <CircleSlash className={cls} aria-hidden />
      }
  }
}

/** Shows which connection the visible tab belongs to, so it is always clear where an action goes. */
export function TopBar(): ReactNode {
  const gateway = useGateway()
  const active = useTabs((s) => s.tabs.find((t) => t.id === s.activeId)?.spec)
  const conn = useConnection(active?.connId)
  const appInfo = useAppInfo()
  const setOverlay = useOverlays((s) => s.set)
  const mac = navigator.platform.toLowerCase().includes('mac')
  const stream = active && 'stream' in active ? active.stream : undefined
  const connected = conn?.state.status === 'connected'
  const { data: info } = useQuery({
    queryKey: ['serverInfo', active?.connId],
    queryFn: () => gateway.serverInfo(active!.connId),
    enabled: connected,
    refetchInterval: 15_000
  })
  const view = conn ? stateView(conn.state.status, connected ? info?.rttMs : undefined) : undefined

  return (
    <header className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-panel px-3 py-1">
      <div className="flex shrink-0 items-center gap-2 font-semibold">
        <Hexagon className="h-4 w-4 text-accent" aria-hidden />
        <span className="hidden sm:inline">NATS Studio</span>
      </div>

      {conn && (
        <nav
          aria-label="Breadcrumb"
          className="flex min-w-0 items-center gap-1.5"
          data-testid="active-connection"
        >
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: conn.color }}
            aria-hidden
          />
          <span className="truncate font-medium">{conn.name}</span>
          {conn.envLabel && (
            <Badge tone={conn.envLabel.toLowerCase().startsWith('prod') ? 'danger' : 'neutral'}>
              {conn.envLabel}
            </Badge>
          )}
          {stream && (
            <>
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden />
              <span className="truncate font-medium" aria-current="page">
                {stream}
              </span>
            </>
          )}
          {conn.readOnly && (
            <Badge
              status="warn"
              title="Create, edit, delete, purge and publish are blocked on this connection"
            >
              <Lock className="h-3 w-3" aria-hidden />
              Read-only
            </Badge>
          )}
          <span className="hidden truncate text-faint lg:inline">
            {connected && conn.state.serverName
              ? `${conn.state.serverName} · NATS ${conn.state.version}`
              : conn.state.status === 'error'
                ? conn.state.error
                : ''}
          </span>
        </nav>
      )}

      <button
        className="ml-auto flex h-7 w-64 max-w-full items-center gap-2 rounded-md border border-line bg-raised px-2 text-muted hover:bg-hover"
        onClick={() => setOverlay({ palette: true })}
        aria-label="Search streams, consumers and buckets"
      >
        <Search className="h-3.5 w-3.5" aria-hidden />
        <span className="mr-auto">Search...</span>
        <Kbd>{mac ? '⌘K' : 'Ctrl K'}</Kbd>
      </button>

      {view && (
        <span
          role="status"
          data-testid="connection-state"
          className={`flex shrink-0 items-center gap-1.5 text-xs ${view.tone}`}
        >
          {view.icon}
          {view.text}
        </span>
      )}

      {appInfo?.mode === 'web' && appInfo.user && (
        <div className="flex items-center gap-1 text-muted">
          <span className="max-w-40 truncate" title={appInfo.user.email ?? appInfo.user.name}>
            {appInfo.user.name}
          </span>
          {appInfo.canSignOut && (
            <Button
              size="sm"
              variant="ghost"
              title="Sign out"
              aria-label="Sign out"
              icon={<LogOut className="h-4 w-4" aria-hidden />}
              onClick={() => (location.href = '/auth/logout')}
            />
          )}
        </div>
      )}
    </header>
  )
}
