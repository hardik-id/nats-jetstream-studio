import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown, ArrowUp } from 'lucide-react'
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
  rowHeight?: number
  empty?: ReactNode
  defaultSort?: { id: string; dir: 'asc' | 'desc' }
  rowClassName?: (row: T) => string | undefined
  /** Scrolls to the end whenever rows are added, for live lists. */
  stickToBottom?: boolean
}

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
  rowHeight = 30,
  empty,
  defaultSort,
  rowClassName,
  stickToBottom
}: DataTableProps<T>): ReactNode {
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

  const template = columns.map((c) => c.width ?? 'minmax(80px, 1fr)').join(' ')
  // The header and every row must resolve the same grid, so both get the same explicit width:
  // the scroll area, or the sum of the columns' minimum widths when that is wider.
  const minWidth = columns.reduce((sum, c) => sum + minPx(c.width), 0)
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
      className="h-full min-h-0 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
    >
      <div style={{ minWidth }}>
        <div role="rowgroup" className="sticky top-0 z-10 border-b border-line bg-raised">
          <div
            role="row"
            className="grid items-center"
            style={{ gridTemplateColumns: template, height: rowHeight }}
          >
            {columns.map((column) => {
              const active = sort?.id === column.id
              const content = (
                <>
                  <span className="truncate">{column.header}</span>
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
                  aria-sort={
                    active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined
                  }
                  className={cx(
                    'min-w-0 px-2 text-xs font-semibold text-muted',
                    column.align === 'right' && 'text-right'
                  )}
                >
                  {column.sort ? (
                    <button
                      className={cx(
                        'inline-flex max-w-full items-center gap-1 hover:text-fg',
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
                    selected ? 'bg-accent-soft' : 'hover:bg-hover',
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

/** The smallest width a column track can take: "120px" is 120, "minmax(160px, 2fr)" is 160. */
function minPx(width: string | undefined): number {
  const match = /(\d+(?:\.\d+)?)px/.exec(width ?? 'minmax(80px, 1fr)')
  return match ? Number(match[1]) : 80
}
