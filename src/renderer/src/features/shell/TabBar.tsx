import { useEffect, useRef, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { Menu, cx } from '../../components/ui'
import { useConnections } from '../../lib/hooks'
import { tabTitle, useTabs } from '../../state/tabs'
import { TabIcon } from './nav'

/** Width of one tab (160px) plus the gap (2px), and the room kept for the "+N" button. */
const SLOT = 162
const OVERFLOW_WIDTH = 64

/** The row of open tabs. Tabs can be closed (button, middle click) and reordered by dragging. */
export function TabBar(): ReactNode {
  const { tabs, activeId, activate, close, move } = useTabs()
  const { data: connections = [] } = useConnections()
  const dragFrom = useRef<number | null>(null)
  const empty = tabs.length === 0
  const barRef = useRef<HTMLDivElement>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  // Width of the row; null until measured (then every tab is rendered, nothing is hidden).
  const [width, setWidth] = useState<number | null>(null)
  useEffect(() => {
    const el = rowRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [empty])
  // With many tabs open the bar scrolls; keep the active tab in view.
  useEffect(() => {
    barRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeId, tabs.length])
  if (tabs.length === 0) return null

  // Which tabs fit. The active tab is always shown: when it would be hidden it takes the place of
  // the last visible tab.
  let fit = tabs.length
  if (width && width > 0 && tabs.length * SLOT > width) {
    fit = Math.max(1, Math.floor((width - OVERFLOW_WIDTH) / SLOT))
  }
  const activeIndex = tabs.findIndex((t) => t.id === activeId)
  const shown = new Set(tabs.slice(0, fit).map((t) => t.id))
  if (fit < tabs.length && activeIndex >= fit) {
    shown.delete(tabs[fit - 1].id)
    shown.add(tabs[activeIndex].id)
  }
  const hidden = tabs.filter((t) => !shown.has(t.id))

  return (
    <div ref={rowRef} className="flex h-9 shrink-0 items-stretch border-b border-line bg-bg px-1">
      <div
        ref={barRef}
        role="tablist"
        aria-label="Open tabs"
        className="flex min-w-0 flex-1 items-stretch gap-0.5 overflow-hidden"
      >
        {tabs.map((tab, index) => {
          if (!shown.has(tab.id)) return null
          const conn = connections.find((c) => c.id === tab.spec.connId)
          const selected = tab.id === activeId
          const title = tabTitle(tab.spec)
          return (
            <div
              key={tab.id}
              draggable
              onDragStart={(e) => {
                dragFrom.current = index
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                if (dragFrom.current !== null && dragFrom.current !== index)
                  move(dragFrom.current, index)
                dragFrom.current = null
              }}
              onAuxClick={(e) => {
                if (e.button === 1) close(tab.id)
              }}
              className={cx(
                'group flex w-40 shrink-0 items-center border-b-2 pr-1',
                selected
                  ? 'border-accent bg-panel text-fg'
                  : 'border-transparent text-muted hover:bg-hover'
              )}
            >
              <button
                role="tab"
                aria-selected={selected}
                id={`tab-${tab.id}`}
                title={`${conn?.name ?? 'Unknown connection'} · ${title}`}
                onClick={() => activate(tab.id)}
                className="flex h-full min-w-0 flex-1 items-center gap-1.5 pr-1 pl-2.5 text-left"
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: conn?.color ?? 'var(--faint)' }}
                  aria-hidden
                />
                <TabIcon kind={tab.spec.kind} />
                <span className="truncate">{title}</span>
              </button>
              <button
                aria-label={`Close ${title}`}
                title="Close tab"
                onClick={() => close(tab.id)}
                className={cx(
                  'flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-hover hover:text-fg',
                  !selected && 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
                )}
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>
          )
        })}
      </div>
      {hidden.length > 0 && (
        <div className="flex shrink-0 items-center pl-1">
          <Menu
            align="right"
            items={hidden.map((tab) => ({
              label: tabTitle(tab.spec),
              icon: <TabIcon kind={tab.spec.kind} />,
              title: `${connections.find((c) => c.id === tab.spec.connId)?.name ?? 'Unknown connection'} · ${tabTitle(tab.spec)}`,
              onSelect: () => activate(tab.id)
            }))}
            trigger={(props) => (
              <button
                {...props}
                aria-label={`${hidden.length} more tabs`}
                title="More tabs"
                className="h-7 rounded-md border border-line px-2 text-xs text-muted hover:bg-hover hover:text-fg"
              >
                +{hidden.length}
              </button>
            )}
          />
        </div>
      )}
    </div>
  )
}
