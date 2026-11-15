import type { ReactNode } from 'react'
import { Lock, LogOut, Search } from 'lucide-react'
import { Badge, Button, Kbd } from '../../components/ui'
import { useAppInfo, useConnection } from '../../lib/hooks'
import { useTabs } from '../../state/tabs'
import { useOverlays } from '../../state/ui'
import { StatusDot } from './Sidebar'

/** Shows which connection the visible tab belongs to, so it is always clear where an action goes. */
export function TopBar(): ReactNode {
  const active = useTabs((s) => s.tabs.find((t) => t.id === s.activeId)?.spec)
  const conn = useConnection(active?.connId)
  const appInfo = useAppInfo()
  const setOverlay = useOverlays((s) => s.set)
  const mac = navigator.platform.toLowerCase().includes('mac')

  return (
    <header
      className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-panel px-3"
      style={conn ? { boxShadow: `inset 0 -2px 0 ${conn.color}` } : undefined}
    >
      {conn ? (
        <div className="flex min-w-0 items-center gap-2" data-testid="active-connection">
          <StatusDot status={conn.state.status} />
          <span className="truncate font-semibold">{conn.name}</span>
          {conn.envLabel && (
            <Badge tone={conn.envLabel.toLowerCase().startsWith('prod') ? 'danger' : 'neutral'}>
              {conn.envLabel}
            </Badge>
          )}
          {conn.readOnly && (
            <Badge
              tone="warn"
              title="Create, edit, delete, purge and publish are blocked on this connection"
            >
              <Lock className="mr-1 h-3 w-3" aria-hidden />
              Read-only
            </Badge>
          )}
          <span className="truncate text-muted">
            {conn.state.status === 'connected' && conn.state.serverName
              ? `${conn.state.serverName} · NATS ${conn.state.version}`
              : conn.state.status === 'reconnecting'
                ? 'Connection lost, reconnecting...'
                : conn.state.status === 'error'
                  ? conn.state.error
                  : conn.state.status === 'connecting'
                    ? 'Connecting...'
                    : 'Not connected'}
          </span>
        </div>
      ) : (
        <span className="font-semibold">NATS JetStream Studio</span>
      )}

      <button
        className="ml-auto flex h-7 w-64 items-center gap-2 rounded-md border border-line bg-raised px-2 text-muted hover:bg-hover"
        onClick={() => setOverlay({ palette: true })}
        aria-label="Search streams, consumers and buckets"
      >
        <Search className="h-3.5 w-3.5" aria-hidden />
        <span className="mr-auto">Search...</span>
        <Kbd>{mac ? '⌘K' : 'Ctrl K'}</Kbd>
      </button>

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
