import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import { useVirtualizer, defaultRangeExtractor, type Range } from '@tanstack/react-virtual'
import { ChevronDown, ChevronRight, MoreHorizontal } from 'lucide-react'
import { formatCount } from '@shared/format'
import { Badge, cx, type MenuItem } from '../../components/ui'
import type { SubjectRow, SubjectTreeNode } from './subjectTree'

export const ROW_HEIGHT = 30
const INDENT = 16
/** Below this width the Streams column is dropped to leave room for the subject. */
const COMPACT_WIDTH = 560

export interface SubjectTreeProps {
  rows: readonly SubjectRow[]
  selectedPath: string | null
  /** Click, Space or Enter on a row. `open` is true for Enter and double-click. */
  onSelect: (row: SubjectRow, open: boolean) => void
  /** Opens or closes the given rows (the chevron, Left and Right, `*`). */
  onSetOpen: (rows: SubjectRow[], open: boolean) => void
  menuItems: (node: SubjectTreeNode) => MenuItem[]
}

/** The token with the part that matched the search marked. */
function Token({ row }: { row: SubjectRow }): ReactNode {
  const { token } = row.node
  const h = row.highlight
  if (!h || h[1] <= h[0]) return token
  return (
    <>
      {token.slice(0, h[0])}
      <mark className="rounded-sm bg-accent-soft px-px text-accent underline decoration-accent/60">
        {token.slice(h[0], h[1])}
      </mark>
      {token.slice(h[1])}
    </>
  )
}

/**
 * The subjects as a virtualised `treegrid` (WAI-ARIA): one tab stop (the active row, plus its menu
 * button), arrow keys, Home and End, Page Up and Down, `*`, type-ahead, Enter and Space. Only
 * the rows on screen (and the active row) exist in the DOM.
 */
export function SubjectTree({
  rows,
  selectedPath,
  onSelect,
  onSetOpen,
  menuItems
}: SubjectTreeProps): ReactNode {
  const scroller = useRef<HTMLDivElement>(null)
  const [focusPath, setFocusPath] = useState<string | null>(null)
  const [menu, setMenu] = useState<{
    path: string
    right: number
    top: number
    bottom: number
    viaKeyboard: boolean
  } | null>(null)
  const [compact, setCompact] = useState(false)
  const pendingFocus = useRef<string | null>(null)
  const typed = useRef({ text: '', at: 0 })

  // The Streams column goes away when the tree is narrow (a callback, not an effect body).
  useEffect(() => {
    const el = scroller.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? el.clientWidth
      setCompact(w > 0 && w < COMPACT_WIDTH)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const indexOf = new Map<string, number>()
  rows.forEach((r, i) => indexOf.set(r.path, i))
  // The tab stop: the row last focused, else the selected one, else the first.
  const activeIndex =
    (focusPath !== null ? indexOf.get(focusPath) : undefined) ??
    (selectedPath !== null ? indexOf.get(selectedPath) : undefined) ??
    0

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    // The active row always exists, so Tab can enter the grid wherever it is scrolled.
    rangeExtractor: (range: Range) => {
      const base = defaultRangeExtractor(range)
      if (rows.length === 0 || base.includes(activeIndex)) return base
      return [...base, activeIndex].sort((a, b) => a - b)
    }
  })

  // After a key moved the focus the target row may not exist yet; focus it once it does.
  useEffect(() => {
    const want = pendingFocus.current
    if (want === null) return
    const el = [...(scroller.current?.querySelectorAll<HTMLElement>('[data-path]') ?? [])].find(
      (n) => n.dataset.path === want
    )
    if (el) {
      pendingFocus.current = null
      el.focus({ preventScroll: true })
    }
  })

  const focusRow = (index: number): void => {
    const row = rows[Math.max(0, Math.min(rows.length - 1, index))]
    if (!row) return
    pendingFocus.current = row.path
    setFocusPath(row.path)
    virtualizer.scrollToIndex(indexOf.get(row.path) ?? 0, { align: 'auto' })
  }

  const openMenu = (path: string, button: HTMLElement, viaKeyboard: boolean): void => {
    const r = button.getBoundingClientRect()
    setMenu({ path, right: r.right, top: r.top, bottom: r.bottom, viaKeyboard })
  }

  const typeAhead = (key: string, from: number): void => {
    const now = Date.now()
    const t = typed.current
    t.text = now - t.at > 700 ? key : t.text + key
    t.at = now
    const needle = t.text.toLowerCase()
    // A repeated single letter cycles through the rows that start with it.
    const cycle = needle.length > 1 && needle.split('').every((c) => c === needle[0])
    const want = cycle ? needle[0] : needle
    for (let k = cycle || needle.length === 1 ? 1 : 0; k <= rows.length; k++) {
      const i = (from + k) % rows.length
      if (rows[i].node.token.toLowerCase().startsWith(want)) {
        focusRow(i)
        return
      }
    }
  }

  const onRowKeyDown = (e: KeyboardEvent<HTMLDivElement>, row: SubjectRow, index: number): void => {
    // Keys in the row's menu button belong to the button.
    if (e.target !== e.currentTarget) return
    if (e.altKey || e.ctrlKey || e.metaKey) return
    const page = Math.max(1, Math.floor((scroller.current?.clientHeight ?? 300) / ROW_HEIGHT) - 1)
    let handled = true
    switch (e.key) {
      case 'ArrowDown':
        focusRow(index + 1)
        break
      case 'ArrowUp':
        focusRow(index - 1)
        break
      case 'Home':
        focusRow(0)
        break
      case 'End':
        focusRow(rows.length - 1)
        break
      case 'PageDown':
        focusRow(index + page)
        break
      case 'PageUp':
        focusRow(index - page)
        break
      case 'ArrowRight':
        if (row.hasChildren && !row.isOpen) onSetOpen([row], true)
        else if (row.hasChildren && row.isOpen) focusRow(index + 1)
        break
      case 'ArrowLeft':
        if (row.hasChildren && row.isOpen) onSetOpen([row], false)
        else if (row.node.parentPath !== null) {
          const parent = indexOf.get(row.node.parentPath)
          if (parent !== undefined) focusRow(parent)
        }
        break
      case '*': {
        const closed = rows.filter(
          (r) => r.node.parentPath === row.node.parentPath && r.hasChildren && !r.isOpen
        )
        if (closed.length) onSetOpen(closed, true)
        break
      }
      case 'Enter':
        onSelect(row, true)
        break
      case ' ':
        onSelect(row, false)
        break
      case 'ContextMenu':
        openMenu(row.path, e.currentTarget.querySelector<HTMLElement>('[data-menu-button]')!, true)
        break
      case 'F10':
        if (!e.shiftKey) handled = false
        else
          openMenu(
            row.path,
            e.currentTarget.querySelector<HTMLElement>('[data-menu-button]')!,
            true
          )
        break
      default:
        if (e.key.length === 1) typeAhead(e.key, index)
        else handled = false
    }
    if (handled) e.preventDefault()
  }

  const gridCols = compact ? 'minmax(0,1fr) 112px 44px 32px' : 'minmax(0,1fr) 128px 52px 124px 32px'

  const menuRow = menu ? rows[indexOf.get(menu.path) ?? -1] : undefined

  return (
    <div
      role="treegrid"
      aria-label="Subjects"
      aria-rowcount={rows.length + 1}
      className="flex h-full min-h-0 flex-col bg-panel"
    >
      <div
        role="row"
        aria-rowindex={1}
        className="grid h-8 shrink-0 items-center gap-2 border-b border-line bg-raised px-3 text-[11px] font-semibold tracking-wide text-muted uppercase"
        style={{ gridTemplateColumns: gridCols }}
      >
        <div role="columnheader">Subject</div>
        <div
          role="columnheader"
          className="text-right"
          title="Messages stored on this subject and everything below it"
        >
          Messages
        </div>
        <div
          role="columnheader"
          className="text-right"
          title="Messages seen in a live tail this session"
        >
          Live
        </div>
        {!compact && (
          <div role="columnheader" title="Streams that store this subject">
            Streams
          </div>
        )}
        <div role="columnheader">
          <span className="sr-only">Actions</span>
        </div>
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-auto" onScroll={() => setMenu(null)}>
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((v) => {
            const row = rows[v.index]
            if (!row) return null
            const { node } = row
            const selected = row.path === selectedPath
            const pct =
              row.siblingMaxTotal > 0 && node.total > 0
                ? Math.max(2, (node.total / row.siblingMaxTotal) * 100)
                : 0
            return (
              <div
                key={row.path}
                role="row"
                data-path={row.path}
                aria-label={row.path}
                aria-level={row.level}
                aria-posinset={row.posInSet}
                aria-setsize={row.setSize}
                aria-rowindex={v.index + 2}
                aria-expanded={row.hasChildren ? row.isOpen : undefined}
                aria-selected={selected}
                tabIndex={v.index === activeIndex ? 0 : -1}
                className={cx(
                  'group absolute right-0 left-0 grid cursor-default items-center gap-2 px-3 outline-offset-[-2px]',
                  selected
                    ? 'bg-accent-soft shadow-[inset_3px_0_0_var(--accent)]'
                    : 'hover:bg-hover'
                )}
                style={{
                  top: 0,
                  height: ROW_HEIGHT,
                  transform: `translateY(${v.start}px)`,
                  gridTemplateColumns: gridCols
                }}
                onFocus={(e) => {
                  if (e.target === e.currentTarget) setFocusPath(row.path)
                }}
                onClick={() => onSelect(row, false)}
                onDoubleClick={() => onSelect(row, true)}
                onKeyDown={(e) => onRowKeyDown(e, row, v.index)}
              >
                <div
                  role="gridcell"
                  className="flex min-w-0 items-center"
                  style={{ paddingLeft: (row.level - 1) * INDENT }}
                >
                  {row.hasChildren ? (
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label={`${row.isOpen ? 'Collapse' : 'Expand'} ${row.path}`}
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-faint hover:bg-hover hover:text-fg"
                      onClick={(e: MouseEvent) => {
                        e.stopPropagation()
                        onSetOpen([row], !row.isOpen)
                      }}
                      onDoubleClick={(e) => e.stopPropagation()}
                    >
                      {row.isOpen ? (
                        <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                      )}
                    </button>
                  ) : (
                    <span className="w-5 shrink-0" />
                  )}
                  <span
                    className={cx(
                      'truncate font-mono text-xs',
                      row.hasChildren ? 'font-semibold' : '',
                      node.total === 0 && node.liveTotal === 0 && 'text-faint'
                    )}
                    title={node.path}
                  >
                    <Token row={row} />
                  </span>
                  {node.liveOnly && (
                    <Badge
                      tone="accent"
                      className="ml-2 shrink-0"
                      title="Seen in a live tail this session; not stored in a stream"
                    >
                      live
                    </Badge>
                  )}
                </div>
                <div
                  role="gridcell"
                  className="tabular relative flex h-5 items-center justify-end text-xs"
                  title={
                    node.hasChildren && node.own > 0
                      ? `${formatCount(node.own)} on this subject, ${formatCount(node.total - node.own)} below it`
                      : undefined
                  }
                >
                  {pct > 0 && (
                    <span
                      aria-hidden
                      className="absolute inset-y-0.5 right-0 rounded-sm bg-accent/20"
                      style={{ width: `${pct}%` }}
                    />
                  )}
                  <span className="relative px-1">
                    {node.total > 0 ? (
                      formatCount(node.total)
                    ) : (
                      <span className="text-faint">-</span>
                    )}
                  </span>
                </div>
                <div role="gridcell" className="tabular text-right text-xs text-muted">
                  {node.liveTotal > 0 ? (
                    formatCount(node.liveTotal)
                  ) : (
                    <span className="text-faint">-</span>
                  )}
                </div>
                {!compact && (
                  <div role="gridcell" className="flex min-w-0 items-center gap-1">
                    {row.showStreams && (
                      <>
                        <Badge
                          className="max-w-24 min-w-0 truncate"
                          title={`Stored in ${node.streams.join(', ')}`}
                        >
                          {node.streams[0]}
                        </Badge>
                        {node.streams.length > 1 && (
                          <span className="text-[11px] text-muted" title={node.streams.join(', ')}>
                            +{node.streams.length - 1}
                          </span>
                        )}
                      </>
                    )}
                  </div>
                )}
                <div role="gridcell" className="flex justify-end">
                  <button
                    type="button"
                    data-menu-button
                    tabIndex={v.index === activeIndex ? 0 : -1}
                    aria-label={`Actions for ${row.path}`}
                    aria-haspopup="menu"
                    aria-expanded={menu?.path === row.path}
                    title="Actions"
                    className={cx(
                      'flex h-6 w-6 items-center justify-center rounded text-faint hover:bg-raised hover:text-fg',
                      (selected || menu?.path === row.path) && 'text-muted'
                    )}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (menu?.path === row.path) setMenu(null)
                      else openMenu(row.path, e.currentTarget, false)
                    }}
                    onDoubleClick={(e) => e.stopPropagation()}
                  >
                    <MoreHorizontal className="h-4 w-4" aria-hidden />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>
      {menu && menuRow && (
        <RowMenu
          anchor={menu}
          label={`Actions for ${menuRow.path}`}
          items={menuItems(menuRow.node)}
          onClose={(returnFocus) => {
            setMenu(null)
            if (returnFocus) {
              pendingFocus.current = menuRow.path
              setFocusPath(menuRow.path)
            }
          }}
        />
      )}
    </div>
  )
}

const MENU_ROW = 34

/**
 * The row menu. It is drawn in a portal at fixed coordinates, so the scrolling tree cannot clip
 * it; it flips upwards near the bottom of the window. Up, Down, Home, End, Enter, Esc and Tab work.
 */
function RowMenu({
  anchor,
  label,
  items,
  onClose
}: {
  anchor: { right: number; top: number; bottom: number; viaKeyboard: boolean }
  label: string
  items: MenuItem[]
  onClose: (returnFocus: boolean) => void
}): ReactNode {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('[role=menuitem]:not(:disabled)')?.focus()
  }, [])
  useEffect(() => {
    const down = (e: globalThis.MouseEvent): void => {
      const t = e.target as Element
      // The button that opened the menu toggles it itself.
      if (!box.current?.contains(t) && !t.closest?.('[data-menu-button]')) onClose(false)
    }
    document.addEventListener('mousedown', down)
    return () => document.removeEventListener('mousedown', down)
  }, [onClose])
  const height = items.length * MENU_ROW + 8
  const flip = anchor.bottom + height + 8 > window.innerHeight && anchor.top - height > 0
  const style = {
    position: 'fixed' as const,
    right: Math.max(8, window.innerWidth - anchor.right),
    top: flip ? anchor.top - height - 4 : anchor.bottom + 4
  }
  return createPortal(
    <div
      ref={box}
      role="menu"
      aria-label={label}
      style={style}
      className="z-50 w-max max-w-80 min-w-52 rounded-md border border-line bg-panel py-1 shadow-lg"
      onKeyDown={(e) => {
        const els = [
          ...(box.current?.querySelectorAll<HTMLElement>('[role=menuitem]:not(:disabled)') ?? [])
        ]
        const at = els.indexOf(document.activeElement as HTMLElement)
        if (e.key === 'Escape') onClose(true)
        else if (e.key === 'Tab') onClose(true)
        else if (e.key === 'ArrowDown') els[(at + 1) % els.length]?.focus()
        else if (e.key === 'ArrowUp') els[(at - 1 + els.length) % els.length]?.focus()
        else if (e.key === 'Home') els[0]?.focus()
        else if (e.key === 'End') els[els.length - 1]?.focus()
        else return
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      {items.map((item, index) => (
        <button
          key={index}
          role="menuitem"
          type="button"
          tabIndex={-1}
          disabled={item.disabled}
          title={item.title ?? item.label}
          onClick={() => {
            onClose(true)
            item.onSelect()
          }}
          className={cx(
            'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-hover focus:bg-hover disabled:cursor-not-allowed disabled:opacity-50',
            item.danger && 'text-danger'
          )}
        >
          {item.icon}
          <span className="min-w-0 truncate">{item.label}</span>
        </button>
      ))}
    </div>,
    document.body
  )
}
