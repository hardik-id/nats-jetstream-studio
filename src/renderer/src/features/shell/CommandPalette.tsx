import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQueries } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import type { SearchIndex } from '@shared/api'
import { cx } from '../../components/ui'
import { useGateway } from '../../gateway'
import { useConnectActions } from '../../lib/connect'
import { fuzzyScore } from '../../lib/fuzzy'
import { useConnections } from '../../lib/hooks'
import { useTabs, type TabSpec } from '../../state/tabs'
import { useOverlays, useUi } from '../../state/ui'
import { NAV, openNav, TabIcon } from './nav'

interface PaletteItem {
  id: string
  group: string
  label: string
  /** Shown dimmed after the label: the connection, or the stream a consumer belongs to. */
  detail?: string
  icon?: TabSpec['kind']
  color?: string
  run: () => void
}

const GROUP_ORDER = [
  'Streams',
  'Consumers',
  'KV buckets',
  'Object stores',
  'Go to',
  'Connections',
  'Actions'
]
const MAX_RESULTS = 60

/**
 * Jump to anything by typing (PBI-090). Names come from a cached index per connection, so results
 * appear as fast as you type; the index is refreshed in the background.
 */
export function CommandPalette({ onClose }: { onClose: () => void }): ReactNode {
  const gateway = useGateway()
  const { data: connections = [] } = useConnections()
  const { connect, disconnect } = useConnectActions()
  const open = useTabs((s) => s.open)
  const setOverlay = useOverlays((s) => s.set)
  const { theme, setTheme } = useUi()
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const online = useMemo(
    () => connections.filter((c) => c.state.status === 'connected'),
    [connections]
  )
  const indexes = useQueries({
    queries: online.map((c) => ({
      queryKey: ['searchIndex', c.id],
      queryFn: (): Promise<SearchIndex> => gateway.searchIndex(c.id),
      staleTime: 30_000
    }))
  })

  const items = useMemo(() => {
    const out: PaletteItem[] = []
    online.forEach((conn, i) => {
      const index = indexes[i]?.data
      const go = (spec: TabSpec) => () => open(spec)
      for (const stream of index?.streams ?? []) {
        out.push({
          id: `s:${conn.id}:${stream}`,
          group: 'Streams',
          label: stream,
          detail: conn.name,
          icon: 'stream',
          color: conn.color,
          run: go({ kind: 'stream', connId: conn.id, stream })
        })
      }
      for (const c of index?.consumers ?? []) {
        out.push({
          id: `c:${conn.id}:${c.stream}:${c.name}`,
          group: 'Consumers',
          label: c.name,
          detail: `${c.stream} · ${conn.name}`,
          icon: 'consumer',
          color: conn.color,
          run: go({ kind: 'consumer', connId: conn.id, stream: c.stream, consumer: c.name })
        })
      }
      for (const bucket of index?.kv ?? []) {
        out.push({
          id: `k:${conn.id}:${bucket}`,
          group: 'KV buckets',
          label: bucket,
          detail: conn.name,
          icon: 'kvBucket',
          color: conn.color,
          run: go({ kind: 'kvBucket', connId: conn.id, bucket })
        })
      }
      for (const bucket of index?.obj ?? []) {
        out.push({
          id: `o:${conn.id}:${bucket}`,
          group: 'Object stores',
          label: bucket,
          detail: conn.name,
          icon: 'objBucket',
          color: conn.color,
          run: go({ kind: 'objBucket', connId: conn.id, bucket })
        })
      }
      for (const nav of NAV) {
        out.push({
          id: `n:${conn.id}:${nav.kind}`,
          group: 'Go to',
          label: nav.label,
          detail: conn.name,
          icon: nav.kind,
          color: conn.color,
          run: () => openNav(conn.id, nav.kind)
        })
      }
    })
    for (const conn of connections) {
      const up = conn.state.status === 'connected' || conn.state.status === 'reconnecting'
      out.push({
        id: `conn:${conn.id}`,
        group: 'Connections',
        label: up ? `Disconnect ${conn.name}` : `Connect ${conn.name}`,
        detail: conn.servers[0],
        color: conn.color,
        run: () =>
          up
            ? void disconnect(conn.id)
            : void connect(conn.id).then((ok) => ok && openNav(conn.id, 'overview'))
      })
    }
    out.push({
      id: 'a:new',
      group: 'Actions',
      label: 'Add connection',
      run: () => setOverlay({ connectionForm: 'new' })
    })
    out.push({
      id: 'a:theme',
      group: 'Actions',
      label: `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`,
      run: () => setTheme(theme === 'dark' ? 'light' : 'dark')
    })
    out.push({
      id: 'a:help',
      group: 'Actions',
      label: 'Keyboard shortcuts',
      run: () => setOverlay({ help: true })
    })
    out.push({
      id: 'a:about',
      group: 'Actions',
      label: 'About and updates',
      run: () => setOverlay({ about: true })
    })
    return out
  }, [online, indexes, connections, open, connect, disconnect, setOverlay, theme, setTheme])

  const results = useMemo(() => {
    const q = query.trim()
    let matched: PaletteItem[]
    if (!q) {
      // Nothing typed yet: lead with navigation rather than thousands of names.
      matched = items.filter(
        (i) => i.group === 'Go to' || i.group === 'Connections' || i.group === 'Actions'
      )
    } else {
      const scored: { item: PaletteItem; score: number }[] = []
      for (const item of items) {
        const onLabel = fuzzyScore(q, item.label)
        const onBoth = onLabel ?? fuzzyScore(q, `${item.label} ${item.detail ?? ''}`)
        if (onBoth !== null) scored.push({ item, score: onLabel !== null ? onBoth + 50 : onBoth })
      }
      scored.sort((a, b) => b.score - a.score)
      matched = scored.slice(0, MAX_RESULTS).map((s) => s.item)
    }
    // Group, keeping the best match first inside each group.
    const groups = new Map<string, PaletteItem[]>()
    for (const item of matched) {
      if (!groups.has(item.group)) groups.set(item.group, [])
      groups.get(item.group)!.push(item)
    }
    return GROUP_ORDER.filter((g) => groups.has(g)).flatMap((g) => groups.get(g)!)
  }, [items, query])

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const run = (item: PaletteItem | undefined): void => {
    if (!item) return
    onClose()
    item.run()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        className="flex max-h-[70vh] w-[640px] max-w-[92vw] flex-col overflow-hidden rounded-lg border border-line bg-panel shadow-2xl"
      >
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
          <Search className="h-4 w-4 text-faint" aria-hidden />
          <input
            autoFocus
            role="combobox"
            aria-expanded
            aria-controls="palette-results"
            aria-activedescendant={results[cursor] ? `palette-${cursor}` : undefined}
            aria-label="Search streams, consumers, buckets and actions"
            placeholder="Search streams, consumers, buckets and actions"
            className="h-full flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setCursor(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setCursor((c) => Math.min(results.length - 1, c + 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setCursor((c) => Math.max(0, c - 1))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                run(results[cursor])
              } else if (e.key === 'Escape') {
                e.preventDefault()
                onClose()
              }
            }}
          />
        </div>
        <div
          ref={listRef}
          id="palette-results"
          role="listbox"
          aria-label="Results"
          className="min-h-0 flex-1 overflow-y-auto py-1"
        >
          {results.length === 0 && (
            <p className="px-4 py-6 text-center text-muted">No matches for “{query}”</p>
          )}
          {results.map((item, i) => {
            const header = i === 0 || results[i - 1].group !== item.group
            return (
              <div key={item.id}>
                {header && (
                  <p className="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-faint uppercase">
                    {item.group}
                  </p>
                )}
                <div
                  id={`palette-${i}`}
                  role="option"
                  aria-selected={i === cursor}
                  onMouseMove={() => setCursor(i)}
                  onClick={() => run(item)}
                  className={cx(
                    'mx-1 flex h-8 cursor-default items-center gap-2 rounded-md px-2',
                    i === cursor && 'bg-accent-soft'
                  )}
                >
                  {item.color && (
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ background: item.color }}
                      aria-hidden
                    />
                  )}
                  {item.icon && <TabIcon kind={item.icon} />}
                  <span className="truncate">{item.label}</span>
                  {item.detail && (
                    <span className="ml-auto truncate pl-4 text-xs text-muted">{item.detail}</span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
