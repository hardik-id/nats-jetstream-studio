import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Check, ChevronDown, ChevronRight, Copy } from 'lucide-react'
import { appendSegment, valueText, type JsonSearch } from '@shared/jsonTree'
import { cx } from './ui'

/** Containers list this many children at first; "Show more" adds five times as many. */
export const JSON_CHUNK = 200

export interface JsonViewSearch extends JsonSearch {
  query: string
  /** The id (path) of the match that is current, or null. */
  activeId: string | null
  /** Changes every time the user steps to another match, so hand-closed nodes open again. */
  nav: number
}

interface Ctx {
  expandDepth: number
  search?: JsonViewSearch
  matchIds: ReadonlySet<string>
  /** The row that is in the tab order (roving tabindex). */
  roving: string
  setRoving: (id: string) => void
}

/**
 * A collapsible tree for JSON values. Large arrays and objects are shown in chunks. `expandDepth`
 * is how many levels start open; change `resetKey` to apply it again (Expand all, Collapse all).
 *
 * Keyboard: one row is in the tab order; Up and Down move between visible rows, Right opens or
 * steps into a node, Left closes it or steps to its parent, Home and End go to the first and last
 * row. A focused row offers "Copy path" and "Copy value" (also shown on hover).
 */
export function JsonView({
  value,
  expandDepth = 2,
  wrap = true,
  fontSize = 13,
  search,
  resetKey = 0
}: {
  value: unknown
  expandDepth?: number
  /** Wrap long lines (default). When off, lines stay on one row and the box scrolls sideways. */
  wrap?: boolean
  fontSize?: number
  search?: JsonViewSearch
  resetKey?: number
}): ReactNode {
  const root = useRef<HTMLDivElement>(null)
  const [roving, setRoving] = useState('$')
  const activeId = search?.activeId ?? null
  const query = search?.query ?? ''
  const nav = search?.nav ?? 0
  useEffect(() => {
    if (!activeId) return
    root.current?.querySelector('[data-active-match]')?.scrollIntoView({ block: 'nearest' })
  }, [activeId, query, resetKey, expandDepth, nav])
  // The row that was in the tab order may be gone (collapsed, or the tree was rebuilt): make the
  // first row the tab stop, so the tree can always be entered with Tab.
  useEffect(() => {
    const el = root.current
    if (!el || el.querySelector('[data-json-row][tabindex="0"]')) return
    el.querySelector('[data-json-row]')?.setAttribute('tabindex', '0')
  })
  const matchIds = new Set(search?.matches.map((m) => m.id))
  return (
    <div
      ref={root}
      role="tree"
      aria-label="JSON"
      style={{ fontSize }}
      className={cx(
        'font-mono leading-[1.65]',
        wrap ? 'break-all whitespace-pre-wrap' : 'w-max min-w-full whitespace-pre'
      )}
    >
      <Node
        key={`${expandDepth}:${resetKey}:${query}`}
        id="$"
        value={value}
        depth={0}
        ctx={{ expandDepth, search, matchIds, roving, setRoving }}
      />
    </div>
  )
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Marks every occurrence of `query` in `text`, using the same text that is on screen. */
function Highlight({ text, query }: { text: string; query: string }): ReactNode {
  if (!query) return text
  const parts: ReactNode[] = []
  let from = 0
  for (const m of text.matchAll(new RegExp(escapeRegExp(query), 'gi'))) {
    const at = m.index
    if (at > from) parts.push(text.slice(from, at))
    parts.push(
      <mark key={at} className="json-hit">
        {m[0]}
      </mark>
    )
    from = at + m[0].length
  }
  if (from === 0) return text
  if (from < text.length) parts.push(text.slice(from))
  return <>{parts}</>
}

/** A JSON string as written in the document. The quote characters are never highlighted. */
function Quoted({ text, query }: { text: string; query: string }): ReactNode {
  const inner = JSON.stringify(text).slice(1, -1)
  return (
    <>
      {'"'}
      <Highlight text={inner} query={query} />
      {'"'}
    </>
  )
}

/**
 * One row of the tree. It is a focusable tree item: `onToggle` is set for nodes that open. The
 * copy buttons are in the tab order while focus is in the row.
 */
function Row({
  id,
  value,
  level,
  label,
  active,
  open,
  onToggle,
  ctx,
  className,
  children
}: {
  id: string
  value: unknown
  level: number
  label: string
  active: boolean
  /** Undefined for a value that cannot be opened. */
  open?: boolean
  onToggle?: () => void
  ctx: Ctx
  className?: string
  children: ReactNode
}): ReactNode {
  const [inside, setInside] = useState(false)
  const down = useRef<{ x: number; y: number } | null>(null)
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    // Keys pressed on the copy buttons are theirs.
    if (e.target !== e.currentTarget || e.altKey || e.ctrlKey || e.metaKey) return
    const rows = Array.from(
      e.currentTarget.closest('[role=tree]')?.querySelectorAll<HTMLElement>('[data-json-row]') ?? []
    )
    const at = rows.indexOf(e.currentTarget)
    const go = (row: HTMLElement | undefined): void => {
      if (row) row.focus()
    }
    switch (e.key) {
      case 'ArrowDown':
        go(rows[at + 1])
        break
      case 'ArrowUp':
        go(rows[at - 1])
        break
      case 'Home':
        go(rows[0])
        break
      case 'End':
        go(rows[rows.length - 1])
        break
      case 'ArrowRight':
        if (open === false) onToggle?.()
        else if (open) go(rows[at + 1])
        break
      case 'ArrowLeft':
        if (open) onToggle?.()
        else
          go(
            rows
              .slice(0, at)
              .reverse()
              .find((r) => Number(r.dataset.level) < level)
          )
        break
      case 'Enter':
      case ' ':
        if (onToggle) onToggle()
        break
      default:
        return
    }
    e.preventDefault()
  }
  return (
    <div
      role="treeitem"
      aria-level={level}
      aria-expanded={open}
      aria-label={label}
      tabIndex={ctx.roving === id ? 0 : -1}
      data-json-row=""
      data-level={level}
      data-active-match={active ? '' : undefined}
      className={cx(
        'group flex items-start hover:bg-hover focus-visible:outline-offset-[-2px]',
        onToggle && 'cursor-pointer',
        active && 'json-active',
        className
      )}
      onMouseDown={(e) => {
        down.current = { x: e.clientX, y: e.clientY }
      }}
      onClick={(e) => {
        if (!onToggle || (e.target as HTMLElement).closest('button')) return
        // Selecting text to copy it must not fold the node: skip when something is selected or
        // the pointer moved between press and release.
        const d = down.current
        if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 3) return
        if (window.getSelection()?.toString()) return
        onToggle()
      }}
      onKeyDown={onKeyDown}
      onFocus={(e) => {
        setInside(true)
        if (e.target === e.currentTarget) ctx.setRoving(id)
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setInside(false)
      }}
    >
      {children}
      <span className="ml-auto flex shrink-0 gap-1 pl-2 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
        <CopyChip
          label="path"
          title={`Copy path ${id}`}
          tabIndex={inside ? 0 : -1}
          text={() => id}
        />
        <CopyChip
          label="value"
          title={`Copy value of ${id}`}
          tabIndex={inside ? 0 : -1}
          text={() => valueText(value)}
        />
      </span>
    </div>
  )
}

function CopyChip({
  label,
  title,
  text,
  tabIndex
}: {
  label: string
  title: string
  text: () => string
  tabIndex: number
}): ReactNode {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      tabIndex={tabIndex}
      title={title}
      aria-label={title}
      className="inline-flex h-5 items-center gap-1 rounded border border-line bg-raised px-1.5 font-sans text-[11px] text-muted hover:text-fg"
      onClick={() => {
        void navigator.clipboard.writeText(text()).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        })
      }}
    >
      {copied ? (
        <Check className="h-3 w-3 text-ok" aria-hidden />
      ) : (
        <Copy className="h-3 w-3" aria-hidden />
      )}
      {copied ? 'Copied' : label}
    </button>
  )
}

function Node({
  id,
  name,
  value,
  depth,
  ctx,
  last = true
}: {
  id: string
  name?: string
  value: unknown
  depth: number
  ctx: Ctx
  last?: boolean
}): ReactNode {
  const { search } = ctx
  const query = search?.query ?? ''
  const isContainer = value !== null && typeof value === 'object'
  const [open, setOpen] = useState(depth < ctx.expandDepth || (search?.reveal.has(id) ?? false))
  const [shown, setShown] = useState(JSON_CHUNK)
  // Stepping to another match opens the nodes on the way to it, also ones closed by hand.
  const [seenNav, setSeenNav] = useState(search?.nav ?? 0)
  if (search && seenNav !== search.nav) {
    setSeenNav(search.nav)
    if (search.reveal.has(id)) setOpen(true)
  }
  const needed = search?.need.get(id)
  const isMatch = ctx.matchIds.has(id)
  const active = search?.activeId === id
  const label = name !== undefined && (
    <>
      <span className="json-key">
        <Quoted text={name} query={isMatch ? query : ''} />
      </span>
      <span className="text-faint">: </span>
    </>
  )
  const comma = !last && <span className="text-faint">,</span>
  const level = depth + 1

  if (!isContainer) {
    const text = typeof value === 'string' ? value : String(value)
    return (
      <Row
        id={id}
        value={value}
        level={level}
        label={`${id}: ${text.length > 200 ? text.slice(0, 200) + '...' : text}`}
        active={active}
        ctx={ctx}
        className="pl-4"
      >
        <span className="min-w-0">
          {label}
          <Primitive value={value} query={isMatch ? query : ''} />
          {comma}
        </span>
      </Row>
    )
  }

  const isArray = Array.isArray(value)
  const entries: [string | undefined, unknown][] = isArray
    ? (value as unknown[]).map((v) => [undefined, v])
    : Object.entries(value as object)
  const [openBracket, closeBracket] = isArray ? ['[', ']'] : ['{', '}']
  const noun = isArray
    ? entries.length === 1
      ? 'item'
      : 'items'
    : entries.length === 1
      ? 'key'
      : 'keys'

  // The first `shown` children, plus the ones a search match is inside (so a match far down a
  // long array is shown without rendering everything before it).
  const visible: number[] = []
  for (let i = 0; i < Math.min(shown, entries.length); i++) visible.push(i)
  if (needed) {
    for (const i of [...needed].sort((x, y) => x - y)) if (i >= shown) visible.push(i)
  }

  if (entries.length === 0) {
    return (
      <Row
        id={id}
        value={value}
        level={level}
        label={`${id}: empty ${isArray ? 'array' : 'object'}`}
        active={active}
        ctx={ctx}
        className="pl-4"
      >
        <span className="min-w-0">
          {label}
          <span className="text-faint">
            {openBracket}
            {closeBracket}
          </span>
          {comma}
        </span>
      </Row>
    )
  }

  return (
    <div role="none">
      <Row
        id={id}
        value={value}
        level={level}
        label={`${id} ${isArray ? 'array' : 'object'}, ${entries.length} ${noun}`}
        active={active}
        open={open}
        onToggle={() => setOpen((v) => !v)}
        ctx={ctx}
      >
        <span className="flex min-w-0 items-start text-left">
          {open ? (
            <ChevronDown className="mt-[0.3em] h-3.5 w-4 shrink-0 text-faint" aria-hidden />
          ) : (
            <ChevronRight className="mt-[0.3em] h-3.5 w-4 shrink-0 text-faint" aria-hidden />
          )}
          <span>
            {label}
            <span className="text-faint">{openBracket}</span>
            {!open && (
              <span className="text-faint">
                {' '}
                {entries.length} {noun} {closeBracket}
                {!last && ','}
              </span>
            )}
          </span>
        </span>
      </Row>
      {open && (
        <>
          <div role="group" className="ml-[7px] border-l border-line pl-2">
            {visible.map((i, at) => {
              const [key, child] = entries[i]
              return (
                <Fragment key={key ?? i}>
                  {at > 0 && i - visible[at - 1] > 1 && (
                    <p className="pl-4 text-faint">... {i - visible[at - 1] - 1} hidden</p>
                  )}
                  <Node
                    id={id + appendSegment(isArray ? i : (key as string))}
                    name={key}
                    value={child}
                    depth={depth + 1}
                    ctx={ctx}
                    last={i === entries.length - 1}
                  />
                </Fragment>
              )
            })}
            {entries.length > shown && (
              <button
                className="ml-4 text-accent hover:underline"
                onClick={() => setShown((n) => n + JSON_CHUNK * 5)}
              >
                Show more ({entries.length - visible.length} hidden)
              </button>
            )}
          </div>
          <div className="pl-4 text-faint">
            {closeBracket}
            {!last && ','}
          </div>
        </>
      )}
    </div>
  )
}

function Primitive({ value, query }: { value: unknown; query: string }): ReactNode {
  if (typeof value === 'string')
    return (
      <span className="json-string">
        <Quoted text={value} query={query} />
      </span>
    )
  const text = String(value)
  const body = query ? <Highlight text={text} query={query} /> : text
  return <span className={typeof value === 'number' ? 'json-number' : 'json-literal'}>{body}</span>
}
