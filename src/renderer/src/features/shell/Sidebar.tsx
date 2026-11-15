import { type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Copy,
  Info,
  Lock,
  LockOpen,
  Monitor,
  Moon,
  MoreVertical,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Star,
  Sun,
  Trash2,
  Unplug
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ConnectionStatus, ConnectionSummary } from '@shared/api'
import { Badge, Button, ConfirmDialog, cx, Menu, type MenuItem } from '../../components/ui'
import { useGateway } from '../../gateway'
import { useConnectActions } from '../../lib/connect'
import { favoriteKey, favoriteLabel, favoriteTab, useFavorites } from '../../lib/favorites'
import { useAppInfo, useConnections, useSetting } from '../../lib/hooks'
import { useAlertFeed } from '../../state/alerts'
import { useTabs } from '../../state/tabs'
import { toast } from '../../state/toasts'
import {
  SIDEBAR_RAIL_SETTING,
  useOverlays,
  useRailRequested,
  useUi,
  type ThemeChoice
} from '../../state/ui'
import { isNavActive, NAV, openNav, TabIcon } from './nav'

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connected: 'Connected',
  connecting: 'Connecting',
  reconnecting: 'Reconnecting',
  disconnected: 'Not connected',
  error: 'Error'
}

export function StatusDot({ status }: { status: ConnectionStatus }): ReactNode {
  const tone =
    status === 'connected'
      ? 'bg-ok'
      : status === 'error'
        ? 'bg-danger'
        : status === 'disconnected'
          ? 'bg-faint'
          : 'bg-warn animate-pulse'
  return (
    <span
      role="img"
      aria-label={STATUS_LABEL[status]}
      title={STATUS_LABEL[status]}
      className={cx('inline-block h-2 w-2 shrink-0 rounded-full', tone)}
    />
  )
}

/** The left panel: every connection with its sections, plus app-level actions (PBI-003). */
export function Sidebar(): ReactNode {
  const gateway = useGateway()
  const client = useQueryClient()
  const appInfo = useAppInfo()
  const { data: connections = [], isLoading } = useConnections()
  const { theme, setTheme } = useUi()
  const [railChoice, setRailChoice] = useSetting<boolean>(SIDEBAR_RAIL_SETTING, false)
  const railRequested = useRailRequested()
  // A page (the message browser) may ask for the rail; the user's own choice comes back after.
  const rail = railChoice || railRequested
  const toggleRail = (): void => {
    if (!railRequested) void setRailChoice(!railChoice)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        toggleRail()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  const overlays = useOverlays()
  const locked = appInfo?.connectionsLocked ?? false

  const refreshCli = async (): Promise<void> => {
    try {
      const result = await gateway.refreshCliContexts()
      await client.invalidateQueries({ queryKey: ['connections'] })
      for (const warning of result.warnings) toast.error(warning)
      toast.ok(
        `Found ${result.imported} NATS CLI ${result.imported === 1 ? 'context' : 'contexts'} in ${result.directory}`
      )
    } catch (err) {
      toast.error(err)
    }
  }

  const nextTheme: Record<ThemeChoice, ThemeChoice> = {
    system: 'light',
    light: 'dark',
    dark: 'system'
  }
  const themeIcon =
    theme === 'system' ? (
      <Monitor className="h-4 w-4" aria-hidden />
    ) : theme === 'light' ? (
      <Sun className="h-4 w-4" aria-hidden />
    ) : (
      <Moon className="h-4 w-4" aria-hidden />
    )

  const toggle = (
    <Button
      size="sm"
      variant="ghost"
      title={
        railRequested
          ? 'Collapsed while a detail panel is open'
          : rail
            ? 'Expand sidebar (Ctrl/⌘ B)'
            : 'Collapse sidebar (Ctrl/⌘ B)'
      }
      aria-label={rail ? 'Expand sidebar' : 'Collapse sidebar'}
      aria-pressed={rail}
      disabled={railRequested}
      icon={
        rail ? (
          <PanelLeftOpen className="h-4 w-4" aria-hidden />
        ) : (
          <PanelLeftClose className="h-4 w-4" aria-hidden />
        )
      }
      onClick={toggleRail}
    />
  )

  if (rail) {
    return (
      <Rail
        toggle={toggle}
        connections={connections}
        locked={locked}
        themeButton={
          <Button
            size="sm"
            variant="ghost"
            title={`Theme: ${theme}. Click to change.`}
            aria-label={`Theme: ${theme}`}
            icon={themeIcon}
            onClick={() => setTheme(nextTheme[theme])}
          />
        }
      />
    )
  }

  return (
    <nav
      aria-label="Connections"
      className="flex h-full w-60 shrink-0 flex-col border-r border-line bg-panel"
    >
      <header className="flex h-11 shrink-0 items-center gap-1 border-b border-line px-3">
        <span className="mr-auto text-xs font-semibold tracking-wide text-muted uppercase">
          Connections
        </span>
        {!locked && (
          <Button
            size="sm"
            variant="ghost"
            title="Re-read NATS CLI contexts"
            aria-label="Re-read NATS CLI contexts"
            icon={<RefreshCw className="h-3.5 w-3.5" aria-hidden />}
            onClick={() => void refreshCli()}
          />
        )}
        {toggle}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {connections.map((conn) => (
          <ConnectionNode key={conn.id} conn={conn} locked={locked} />
        ))}
        {!isLoading && connections.length === 0 && (
          <p className="px-3 py-4 text-muted">No connections yet.</p>
        )}
      </div>

      {!locked && (
        <div className="shrink-0 border-t border-line p-2">
          <Button
            size="sm"
            variant="ghost"
            className="w-full justify-start"
            icon={<Plus className="h-4 w-4" aria-hidden />}
            onClick={() => overlays.set({ connectionForm: 'new' })}
          >
            Add connection
          </Button>
        </div>
      )}

      <footer className="flex h-10 shrink-0 items-center gap-1 border-t border-line px-2">
        <Button
          size="sm"
          variant="ghost"
          title={`Theme: ${theme}. Click to change.`}
          aria-label={`Theme: ${theme}`}
          icon={themeIcon}
          onClick={() => setTheme(nextTheme[theme])}
        />
        <Button
          size="sm"
          variant="ghost"
          title="Keyboard shortcuts (?)"
          aria-label="Keyboard shortcuts"
          icon={<CircleHelp className="h-4 w-4" aria-hidden />}
          onClick={() => overlays.set({ help: true })}
        />
        <Button
          size="sm"
          variant="ghost"
          title="About"
          aria-label="About"
          icon={<Info className="h-4 w-4" aria-hidden />}
          onClick={() => overlays.set({ about: true })}
        />
        {appInfo && <span className="ml-auto text-[11px] text-faint">v{appInfo.version}</span>}
      </footer>
    </nav>
  )
}

/** The 48 px icon rail: one button per connection, the sections of the current one, app actions. */
function Rail({
  toggle,
  connections,
  locked,
  themeButton
}: {
  toggle: ReactNode
  connections: ConnectionSummary[]
  locked: boolean
  themeButton: ReactNode
}): ReactNode {
  const { connect } = useConnectActions()
  const overlays = useOverlays()
  const tabs = useTabs()
  const unseenAlerts = useAlertFeed((a) => Object.values(a.unseen).reduce((n, c) => n + c, 0))
  const active = tabs.tabs.find((t) => t.id === tabs.activeId)?.spec
  const isOnline = (c: ConnectionSummary): boolean =>
    c.state.status === 'connected' || c.state.status === 'reconnecting'
  const current =
    connections.find((c) => c.id === active?.connId && isOnline(c)) ?? connections.find(isOnline)

  return (
    <nav
      aria-label="Connections"
      className="flex h-full w-12 shrink-0 flex-col items-center border-r border-line bg-panel"
    >
      <div className="flex h-11 w-full shrink-0 items-center justify-center border-b border-line">
        {toggle}
      </div>
      <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto py-2">
        {connections.map((conn) => {
          const online = isOnline(conn)
          return (
            <button
              key={conn.id}
              aria-label={`${conn.name}, ${STATUS_LABEL[conn.state.status]}`}
              title={`${conn.name} (${STATUS_LABEL[conn.state.status]})`}
              aria-current={current?.id === conn.id ? 'true' : undefined}
              className={cx(
                'relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-xs font-semibold hover:bg-hover',
                current?.id === conn.id ? 'bg-hover text-fg' : 'text-muted'
              )}
              style={{ boxShadow: `inset 3px 0 0 ${conn.color}` }}
              onClick={() => {
                if (online) openNav(conn.id, 'overview')
                else if (conn.state.status !== 'connecting')
                  void connect(conn.id).then((ok) => ok && openNav(conn.id, 'overview'))
              }}
            >
              {conn.name.slice(0, 1).toUpperCase()}
              <span className="absolute right-0.5 bottom-0.5">
                <StatusDot status={conn.state.status} />
              </span>
            </button>
          )
        })}
        {current && (
          <ul className="mt-1 flex w-full flex-col items-center gap-1 border-t border-line pt-2">
            {NAV.map((item) => {
              const isCurrent = isNavActive(current.id, item.kind, active)
              return (
                <li key={item.kind} className="relative">
                  <button
                    aria-label={item.label}
                    title={`${item.label} (${current.name})`}
                    aria-current={isCurrent ? 'page' : undefined}
                    className={cx(
                      'flex h-8 w-8 items-center justify-center rounded-md',
                      isCurrent
                        ? 'bg-accent-soft text-accent'
                        : 'text-muted hover:bg-hover hover:text-fg'
                    )}
                    onClick={() => openNav(current.id, item.kind)}
                  >
                    <TabIcon kind={item.kind} className="h-4 w-4" />
                  </button>
                  {item.kind === 'alerts' && unseenAlerts > 0 && (
                    <span
                      role="img"
                      aria-label={`${unseenAlerts} new alerts`}
                      className="absolute top-0.5 right-0.5 h-2 w-2 rounded-full bg-warn"
                    />
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
      <div className="flex w-full shrink-0 flex-col items-center gap-1 border-t border-line py-2">
        {!locked && (
          <Button
            size="sm"
            variant="ghost"
            title="Add connection"
            aria-label="Add connection"
            icon={<Plus className="h-4 w-4" aria-hidden />}
            onClick={() => overlays.set({ connectionForm: 'new' })}
          />
        )}
        {themeButton}
        <Button
          size="sm"
          variant="ghost"
          title="Keyboard shortcuts (?)"
          aria-label="Keyboard shortcuts"
          icon={<CircleHelp className="h-4 w-4" aria-hidden />}
          onClick={() => overlays.set({ help: true })}
        />
      </div>
    </nav>
  )
}

function ConnectionNode({ conn, locked }: { conn: ConnectionSummary; locked: boolean }): ReactNode {
  const gateway = useGateway()
  const client = useQueryClient()
  const { connect, disconnect } = useConnectActions()
  const { collapsed, toggleCollapsed } = useUi()
  const overlays = useOverlays()
  const tabs = useTabs()
  const active = tabs.tabs.find((t) => t.id === tabs.activeId)?.spec
  const [confirmDelete, setConfirmDelete] = useState(false)
  const unseenAlerts = useAlertFeed((a) => a.unseen[conn.id] ?? 0)
  const status = conn.state.status
  const online = status === 'connected' || status === 'reconnecting'
  const open = online && !collapsed[conn.id]

  const act = async (fn: () => Promise<unknown>, done?: string): Promise<void> => {
    try {
      await fn()
      await client.invalidateQueries({ queryKey: ['connections'] })
      if (done) toast.ok(done)
    } catch (err) {
      toast.error(err)
    }
  }

  const items: MenuItem[] = [
    online || status === 'connecting'
      ? {
          label: 'Disconnect',
          icon: <Unplug className="h-4 w-4" aria-hidden />,
          onSelect: () => void disconnect(conn.id)
        }
      : {
          label: 'Connect',
          icon: <Plug className="h-4 w-4" aria-hidden />,
          onSelect: () => void connect(conn.id)
        },
    ...(locked
      ? []
      : [
          {
            label: conn.readOnly ? 'Turn off read-only' : 'Make read-only',
            icon: conn.readOnly ? (
              <LockOpen className="h-4 w-4" aria-hidden />
            ) : (
              <Lock className="h-4 w-4" aria-hidden />
            ),
            onSelect: () =>
              void act(
                () =>
                  gateway.saveConnection({
                    id: conn.id,
                    name: conn.name,
                    servers: conn.servers,
                    auth: conn.auth,
                    user: conn.user,
                    credsFile: conn.credsFile,
                    nkeyFile: conn.nkeyFile,
                    tls: conn.tls,
                    jsDomain: conn.jsDomain,
                    apiPrefix: conn.apiPrefix,
                    inboxPrefix: conn.inboxPrefix,
                    description: conn.description,
                    color: conn.color,
                    envLabel: conn.envLabel,
                    saveSecrets: conn.saveSecrets,
                    readOnly: !conn.readOnly
                  }),
                conn.readOnly
                  ? `"${conn.name}" can now be changed`
                  : `"${conn.name}" is now read-only`
              )
          },
          {
            label: 'Edit',
            icon: <Pencil className="h-4 w-4" aria-hidden />,
            onSelect: () => overlays.set({ connectionForm: conn.id })
          },
          {
            label: 'Duplicate',
            icon: <Copy className="h-4 w-4" aria-hidden />,
            onSelect: () => void act(() => gateway.duplicateConnection(conn.id))
          },
          {
            label: 'Delete',
            icon: <Trash2 className="h-4 w-4" aria-hidden />,
            danger: true,
            disabled: conn.source === 'cli',
            title:
              conn.source === 'cli'
                ? 'Imported from the NATS CLI. Remove it with "nats context rm".'
                : undefined,
            onSelect: () => setConfirmDelete(true)
          }
        ])
  ]

  return (
    <div className="px-1" role="group" aria-label={conn.name}>
      <div
        className={cx('group flex h-8 items-center gap-1.5 rounded-md pr-1 pl-1 hover:bg-hover')}
        style={{ boxShadow: `inset 3px 0 0 ${conn.color}` }}
      >
        <button
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-1.5 text-left"
          aria-expanded={open}
          title={
            status === 'error' && conn.state.error ? conn.state.error : conn.servers.join(', ')
          }
          onClick={() => {
            if (online) toggleCollapsed(conn.id)
            else if (status !== 'connecting')
              void connect(conn.id).then((ok) => ok && openNav(conn.id, 'overview'))
          }}
        >
          {online ? (
            open ? (
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden />
            )
          ) : (
            <span className="w-3.5 shrink-0" />
          )}
          <StatusDot status={status} />
          <span className="truncate font-medium">{conn.name}</span>
          {conn.envLabel && (
            <Badge tone={conn.envLabel.toLowerCase().startsWith('prod') ? 'danger' : 'neutral'}>
              {conn.envLabel}
            </Badge>
          )}
          {conn.readOnly && <Lock className="h-3 w-3 shrink-0 text-warn" aria-label="Read-only" />}
        </button>
        <Menu
          align="right"
          items={items}
          trigger={(props) => (
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Actions for ${conn.name}`}
              icon={<MoreVertical className="h-4 w-4" aria-hidden />}
              {...props}
            />
          )}
        />
      </div>

      {status === 'error' && conn.state.error && (
        <p className="px-3 pb-1 text-xs text-danger">{conn.state.error}</p>
      )}

      {open && (
        <ul className="mb-1 ml-3 border-l border-line pl-1">
          {NAV.map((item) => {
            const current = isNavActive(conn.id, item.kind, active)
            return (
              <li key={item.kind}>
                <button
                  aria-current={current ? 'page' : undefined}
                  className={cx(
                    'flex h-7 w-full items-center gap-2 rounded-md px-2 text-left',
                    current
                      ? 'bg-accent-soft font-medium text-accent'
                      : 'text-muted hover:bg-hover hover:text-fg'
                  )}
                  onClick={() => openNav(conn.id, item.kind)}
                >
                  <TabIcon kind={item.kind} />
                  {item.label}
                  {item.kind === 'alerts' && unseenAlerts > 0 && (
                    <Badge
                      tone="warn"
                      className="ml-auto"
                      title={`${unseenAlerts} new ${unseenAlerts === 1 ? 'alert' : 'alerts'}`}
                    >
                      {unseenAlerts}
                    </Badge>
                  )}
                </button>
              </li>
            )
          })}
          <Favorites connId={conn.id} />
        </ul>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title={`Delete connection "${conn.name}"?`}
          confirmLabel="Delete connection"
          onClose={() => setConfirmDelete(false)}
          onConfirm={async () => {
            await gateway.deleteConnection(conn.id)
            tabs.closeConnection(conn.id)
            await client.invalidateQueries({ queryKey: ['connections'] })
          }}
        >
          This removes the saved connection and its saved filters, favourites and templates from the
          studio. Nothing on the NATS server changes.
        </ConfirmDialog>
      )}
    </div>
  )
}

function Favorites({ connId }: { connId: string }): ReactNode {
  const { favorites } = useFavorites(connId)
  const open = useTabs((s) => s.open)
  if (favorites.length === 0) return null
  return (
    <li className="mt-1">
      <p className="flex items-center gap-1.5 px-2 pt-1 text-[11px] font-semibold tracking-wide text-faint uppercase">
        <Star className="h-3 w-3" aria-hidden /> Favourites
      </p>
      <ul>
        {favorites.map((f) => (
          <li key={favoriteKey(f)}>
            <button
              className="flex h-6 w-full items-center gap-2 rounded-md px-2 text-left text-muted hover:bg-hover hover:text-fg"
              title={favoriteLabel(f)}
              onClick={() => open(favoriteTab(connId, f))}
            >
              <TabIcon
                kind={
                  f.kind === 'consumer' ? 'consumer' : f.kind === 'subject' ? 'subjects' : 'stream'
                }
                className="h-3 w-3 shrink-0"
              />
              <span className="truncate font-mono text-xs">{favoriteLabel(f)}</span>
            </button>
          </li>
        ))}
      </ul>
    </li>
  )
}
