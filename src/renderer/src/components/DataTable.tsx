import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode
} from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { useSetting } from '../lib/hooks'
import { cx } from './ui'

export interface Column<T> {
  id: string
  header: ReactNode
  /** A CSS grid track, for example "120px" or "minmax(160px, 2fr)". */
  width?: string
  align?: 'left' | 'right'
  /** Makes the column sortable. */
  sort?: (row: T) => string | number | null | undefined
  cell: (row: T) => ReactNode
  /** Tooltip for the cell; defaults to none. */
  title?: (row: T) => string | undefined
  mono?: boolean
  /** Names the column for its resize handle. A column without a text header and without this gets no handle. */
  resizeLabel?: string
}

export interface DataTableProps<T> {
  rows: T[]
  columns: Column<T>[]
  rowKey: (row: T) => string | number
  ariaLabel: string
  /** Enter or double-click. */
  onOpen?: (row: T) => void
  /** Click or arrow keys. */
  onSelect?: (row: T) => void
  selectedKey?: string | number | null
  /** 32 px rows instead of 36 px. */
  compact?: boolean
  empty?: ReactNode
  defaultSort?: { id: string; dir: 'asc' | 'desc' }
  rowClassName?: (row: T) => string | undefined
  /** Scrolls to the end whenever rows are added, for live lists. */
  stickToBottom?: boolean
  /** Where the column widths are remembered; defaults to `ariaLabel`. */
  storageKey?: string
}

/** Widest a column can be made, in px. */
export const MAX_COLUMN_WIDTH = 1200
const NO_WIDTHS: Record<string, number> = {}

/**
 * A virtualized table: only the rows on screen exist in the DOM, so 100,000 rows scroll as
 * smoothly as 100. Sortable by clicking headers and fully usable from the keyboard.
 */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  ariaLabel,
  onOpen,
  onSelect,
  selectedKey,
  compact,
  empty,
  defaultSort,
  rowClassName,
  stickToBottom,
  storageKey
}: DataTableProps<T>): ReactNode {
  const rowHeight = compact ? 32 : 36
  const scrollRef = useRef<HTMLDivElement>(null)
  const [sort, setSort] = useState(defaultSort ?? null)
  const [cursor, setCursor] = useState<string | number | null>(null)

  const sorted = useMemo(() => {
    const column = sort && columns.find((c) => c.id === sort.id)
    if (!column?.sort) return rows
    const get = column.sort
    const dir = sort!.dir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const x = get(a)
      const y = get(b)
      if (x === y) return 0
      if (x === null || x === undefined) return 1
      if (y === null || y === undefined) return -1
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir
      return String(x).localeCompare(String(y), undefined, { numeric: true }) * dir
    })
  }, [rows, columns, sort])

  const virtualizer = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12
  })

  // A column never gets less room than its header label needs (uppercase 11 px, plus the sort
  // arrow), so no header is cut off; when the columns do not fit, the table scrolls sideways.
  const floors = columns.map((c) => Math.max(minPx(c.width), headerFloor(c)))

  // Widths the user set by dragging. Stored per table; a value that was not read yet is never
  // written back, and what is stored is checked before use, so a bad value cannot break a table.
  const [stored, setStored, storedLoaded] = useSetting<unknown>(
    `table.widths:${storageKey ?? ariaLabel}`,
    NO_WIDTHS
  )
  // Changes made before the stored value was read: a width set before the setting has loaded is
  // kept for this session only, never stored (storing it could overwrite what is saved). Also the
  // width of the column being dragged right now.
  const [session, setSession] = useState<Record<string, number | null>>({})
  const [drag, setDrag] = useState<{ id: string; width: number } | null>(null)
  const dragStart = useRef<{ x: number; width: number; pointer: number } | null>(null)
  // How narrow a column can be made: its header must stay readable.
  const resizeFloors = columns.map(resizeFloor)
  const userWidths = useMemo(() => {
    const out: Record<string, number> = {}
    const clean = storedLoaded ? sanitizeWidths(stored, columns, resizeFloors) : NO_WIDTHS
    for (const [id, w] of Object.entries(clean)) out[id] = w
    for (const [id, w] of Object.entries(session)) {
      if (w === null) delete out[id]
      else out[id] = w
    }
    if (drag) out[drag.id] = drag.width
    return out
    // The floors are derived from `columns`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored, storedLoaded, session, drag, columns])

  const defaultWidth = (i: number): number => Math.max(minPx(columns[i].width), floors[i])
  const clampWidth = (i: number, w: number): number =>
    Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(resizeFloors[i], w)))
  /** Keeps a finished change: stored once the stored value has been read, else for the session. */
  const commitWidth = (id: string, width: number | null): void => {
    if (!storedLoaded) {
      setSession((prev) => ({ ...prev, [id]: width }))
      return
    }
    // Merge into what is stored, so widths of columns that are not shown now are kept.
    const next: Record<string, number> = {}
    if (typeof stored === 'object' && stored !== null && !Array.isArray(stored))
      for (const [k, v] of Object.entries(stored))
        if (typeof v === 'number' && Number.isFinite(v)) next[k] = v
    if (width === null) delete next[id]
    else next[id] = width
    setSession({})
    void setStored(next)
  }
  const startDrag = (e: PointerEvent<HTMLDivElement>, i: number): void => {
    if (e.button !== 0 || dragStart.current) return
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    const measured = e.currentTarget.parentElement?.getBoundingClientRect().width ?? 0
    const width = userWidths[columns[i].id] ?? (measured > 0 ? measured : defaultWidth(i))
    dragStart.current = { x: e.clientX, width, pointer: e.pointerId }
    setDrag({ id: columns[i].id, width: clampWidth(i, width) })
  }
  const moveDrag = (e: PointerEvent<HTMLDivElement>, i: number): void => {
    const start = dragStart.current
    if (!start || start.pointer !== e.pointerId) return
    setDrag({ id: columns[i].id, width: clampWidth(i, start.width + e.clientX - start.x) })
  }
  const endDrag = (e: PointerEvent<HTMLDivElement>, i: number, keep: boolean): void => {
    const start = dragStart.current
    if (!start || start.pointer !== e.pointerId) return
    dragStart.current = null
    if (e.currentTarget.hasPointerCapture?.(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId)
    const width = clampWidth(i, start.width + e.clientX - start.x)
    // A click, or a drag that ends where it began, changes nothing (and must not pin a flexible
    // column to its current width).
    if (keep && e.clientX !== start.x && width !== clampWidth(i, start.width))
      commitWidth(columns[i].id, width)
    setDrag(null)
  }
  const resizeByKey = (e: KeyboardEvent<HTMLDivElement>, i: number): void => {
    if (e.altKey || e.ctrlKey || e.metaKey) return
    const id = columns[i].id
    const step = e.shiftKey ? 50 : 10
    const measured = e.currentTarget.parentElement?.getBoundingClientRect().width ?? 0
    const current = userWidths[id] ?? (measured > 0 ? measured : defaultWidth(i))
    if (e.key === 'ArrowLeft') commitWidth(id, clampWidth(i, current - step))
    else if (e.key === 'ArrowRight') commitWidth(id, clampWidth(i, current + step))
    else if (e.key === 'Home') commitWidth(id, null)
    if (e.key.startsWith('Arrow') || ['Home', 'End', 'Enter', 'PageUp', 'PageDown'].includes(e.key))
      e.stopPropagation()
    if (e.key.startsWith('Arrow') || e.key === 'Home') e.preventDefault()
  }

  const template = columns
    .map((c, i) => {
      if (userWidths[c.id] !== undefined) return `${userWidths[c.id]}px`
      const w = c.width ?? 'minmax(80px, 1fr)'
      if (floors[i] === minPx(c.width)) return w
      return /^\s*minmax\(/.test(w)
        ? w.replace(/minmax\(\s*[\d.]+px/, `minmax(${floors[i]}px`)
        : `${floors[i]}px`
    })
    .join(' ')
  // The header and every row must resolve the same grid, so both get the same explicit width:
  // the scroll area, or the sum of the columns' minimum widths when that is wider.
  const minWidth = floors.reduce((sum, n, i) => sum + (userWidths[columns[i].id] ?? n), 0)
  const activeKey = selectedKey !== undefined ? selectedKey : cursor
  const activeIndex = activeKey === null ? -1 : sorted.findIndex((r) => rowKey(r) === activeKey)

  // Follow new rows only while the user is already at the bottom.
  const atBottom = useRef(true)
  useEffect(() => {
    if (stickToBottom && atBottom.current && sorted.length > 0)
      virtualizer.scrollToIndex(sorted.length - 1)
  }, [stickToBottom, sorted.length, virtualizer])

  const select = (index: number): void => {
    const row = sorted[index]
    if (!row) return
    setCursor(rowKey(row))
    onSelect?.(row)
    virtualizer.scrollToIndex(index)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (sorted.length === 0) return
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 300) / rowHeight) - 1)
    const moves: Record<string, number> = {
      ArrowDown: activeIndex + 1,
      ArrowUp: activeIndex - 1,
      PageDown: activeIndex + page,
      PageUp: activeIndex - page,
      Home: 0,
      End: sorted.length - 1
    }
    if (e.key in moves) {
      e.preventDefault()
      select(Math.min(sorted.length - 1, Math.max(0, moves[e.key])))
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault()
      onOpen?.(sorted[activeIndex])
    }
  }

  return (
    <div
      ref={scrollRef}
      role="table"
      aria-label={ariaLabel}
      aria-rowcount={sorted.length}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onScroll={(e) => {
        const el = e.currentTarget
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < rowHeight * 2
      }}
      className={cx(
        'h-full min-h-0 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset',
        drag && 'select-none'
      )}
    >
      <div style={{ minWidth }}>
        <div role="rowgroup" className="sticky top-0 z-10 border-b border-line bg-panel">
          <div
            role="row"
            className="group/head grid items-center"
            style={{ gridTemplateColumns: template, height: HEADER_HEIGHT }}
          >
            {columns.map((column, index) => {
              const active = sort?.id === column.id
              const content = (
                <>
                  <span className="whitespace-nowrap">{column.header}</span>
                  {active &&
                    (sort!.dir === 'asc' ? (
                      <ArrowUp className="h-3 w-3 shrink-0" aria-hidden />
                    ) : (
                      <ArrowDown className="h-3 w-3 shrink-0" aria-hidden />
                    ))}
                </>
              )
              return (
                <div
                  key={column.id}
                  role="columnheader"
                  // The resize handle inside must not become part of the header's name.
                  aria-label={typeof column.header === 'string' ? column.header : undefined}
                  aria-sort={
                    active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined
                  }
                  className={cx(
                    'relative min-w-0 px-2 text-[11px] font-semibold tracking-wide whitespace-nowrap text-faint uppercase',
                    column.align === 'right' && 'text-right'
                  )}
                >
                  {column.sort ? (
                    <button
                      className={cx(
                        'inline-flex max-w-full items-center gap-1 uppercase hover:text-fg focus-visible:text-fg',
                        column.align === 'right' && 'flex-row-reverse'
                      )}
                      onClick={() =>
                        setSort(
                          active && sort!.dir === 'asc'
                            ? { id: column.id, dir: 'desc' }
                            : active
                              ? null
                              : { id: column.id, dir: 'asc' }
                        )
                      }
                    >
                      {content}
                    </button>
                  ) : (
                    <span className="inline-flex max-w-full items-center gap-1">{content}</span>
                  )}
                  {resizeName(column) && (
                    <div
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={`Resize ${resizeName(column)}`}
                      aria-valuenow={userWidths[column.id] ?? defaultWidth(index)}
                      aria-valuemin={resizeFloors[index]}
                      aria-valuemax={MAX_COLUMN_WIDTH}
                      tabIndex={0}
                      onPointerDown={(e) => startDrag(e, index)}
                      onPointerMove={(e) => moveDrag(e, index)}
                      onPointerUp={(e) => endDrag(e, index, true)}
                      onPointerCancel={(e) => endDrag(e, index, false)}
                      onLostPointerCapture={(e) => endDrag(e, index, false)}
                      onDoubleClick={() => commitWidth(column.id, null)}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => resizeByKey(e, index)}
                      style={{ touchAction: 'none' }}
                      className={cx(
                        'absolute top-0 right-0 flex h-full w-2 cursor-col-resize justify-end outline-none group-hover/head:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset',
                        drag?.id === column.id ? 'opacity-100' : 'opacity-0'
                      )}
                    >
                      <span className="h-full w-px bg-faint" aria-hidden />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {sorted.length === 0 ? (
          <div className="p-6 text-center text-muted">{empty ?? 'Nothing to show'}</div>
        ) : (
          <div role="rowgroup" className="relative" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = sorted[item.index]
              const key = rowKey(row)
              const selected = key === activeKey
              return (
                <div
                  key={key}
                  role="row"
                  aria-rowindex={item.index + 1}
                  aria-selected={selected}
                  onClick={() => select(item.index)}
                  onDoubleClick={() => onOpen?.(row)}
                  className={cx(
                    'absolute top-0 left-0 grid w-full cursor-default items-center border-b border-line/60',
                    selected
                      ? 'bg-accent-soft shadow-[inset_2px_0_0_var(--accent)]'
                      : 'hover:bg-hover',
                    rowClassName?.(row)
                  )}
                  style={{
                    gridTemplateColumns: template,
                    height: item.size,
                    transform: `translateY(${item.start}px)`
                  }}
                >
                  {columns.map((column) => (
                    <div
                      key={column.id}
                      role="cell"
                      title={column.title?.(row)}
                      className={cx(
                        'min-w-0 truncate px-2',
                        column.align === 'right' && 'tabular text-right',
                        column.mono && 'font-mono text-xs'
                      )}
                    >
                      {column.cell(row)}
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

const HEADER_HEIGHT = 32

/** Room a header label needs: ~7.4 px per uppercase 11 px character, padding and a sort arrow. */
function headerFloor<T>(column: Column<T>): number {
  if (typeof column.header !== 'string') return 0
  return Math.ceil(column.header.length * 7.4 + 16 + (column.sort ? 18 : 0))
}

/** The smallest width a column track can take: "120px" is 120, "minmax(160px, 2fr)" is 160. */
function minPx(width: string | undefined): number {
  const match = /(\d+(?:\.\d+)?)px/.exec(width ?? 'minmax(80px, 1fr)')
  return match ? Number(match[1]) : 80
}

/** Keeps the stored widths that are finite numbers for a column that exists, within its limits. */
function sanitizeWidths<T>(
  value: unknown,
  columns: Column<T>[],
  floors: number[]
): Record<string, number> {
  const out: Record<string, number> = {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return out
  const record = value as Record<string, unknown>
  columns.forEach((c, i) => {
    const w = Object.prototype.hasOwnProperty.call(record, c.id) ? record[c.id] : undefined
    if (typeof w === 'number' && Number.isFinite(w))
      out[c.id] = Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(floors[i], w)))
  })
  return out
}

/** The text a resize handle is named after, or undefined when the column has none. */
function resizeName<T>(column: Column<T>): string | undefined {
  return column.resizeLabel ?? (typeof column.header === 'string' ? column.header : undefined)
}

/** The narrowest a column can be dragged to: its header text, and never below 24 px. */
function resizeFloor<T>(column: Column<T>): number {
  return Math.max(headerFloor(column), typeof column.header === 'string' ? 24 : 32)
}
