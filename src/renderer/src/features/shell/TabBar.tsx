import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { cx } from '../../components/ui'
import { useConnections } from '../../lib/hooks'
import { tabTitle, useTabs } from '../../state/tabs'
import { TabIcon } from './nav'

/** The row of open tabs. Tabs can be closed (button, middle click) and reordered by dragging. */
export function TabBar(): ReactNode {
  const { tabs, activeId, activate, close, move } = useTabs()
  const { data: connections = [] } = useConnections()
  const dragFrom = useRef<number | null>(null)
  const barRef = useRef<HTMLDivElement>(null)
  // With many tabs open the bar scrolls; keep the active tab in view.
  useEffect(() => {
    barRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeId, tabs.length])
  if (tabs.length === 0) return null

  return (
    <div
      ref={barRef}
      role="tablist"
      aria-label="Open tabs"
      className="flex h-9 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-line bg-bg px-1 pt-1"
    >
      {tabs.map((tab, index) => {
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
              'group flex h-8 max-w-56 min-w-28 shrink-0 items-center rounded-t-md border border-b-0 pr-1',
              selected ? 'border-line bg-panel' : 'border-transparent text-muted hover:bg-hover'
            )}
            style={{
              boxShadow: conn ? `inset 0 2px 0 ${selected ? conn.color : 'transparent'}` : undefined
            }}
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
  )
}
