import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown, ChevronRight, Copy } from 'lucide-react'
import { appendSegment, valueText, type JsonSearch } from '@shared/jsonTree'
import { cx } from './ui'

/** Containers list this many children at first; "Show more" adds five times as many. */
export const JSON_CHUNK = 200

export interface JsonViewSearch extends JsonSearch {
  query: string
  /** The id (path) of the match that is current, or null. */
  activeId: string | null
}

interface Ctx {
  expandDepth: number
  search?: JsonViewSearch
  matchIds: ReadonlySet<string>
}

/**
 * A collapsible tree for JSON values. Large arrays and objects are shown in chunks. `expandDepth`
 * is how many levels start open; change `resetKey` to apply it again (Expand all, Collapse all).
 * Every key row has "Copy path" and "Copy value", shown on hover and while the row has focus.
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
  const activeId = search?.activeId ?? null
  const query = search?.query ?? ''
  useEffect(() => {
    if (!activeId) return
    root.current?.querySelector('[data-active-match]')?.scrollIntoView({ block: 'nearest' })
  }, [activeId, query, resetKey, expandDepth])
  const matchIds = new Set(search?.matches.map((m) => m.id))
  return (
    <div
      ref={root}
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
        ctx={{ expandDepth, search, matchIds }}
      />
    </div>
  )
}

function Highlight({ text, query }: { text: string; query: string }): ReactNode {
  if (!query) return text
  const lower = text.toLowerCase()
  const q = query.toLowerCase()
  const parts: ReactNode[] = []
  let from = 0
  for (let at = lower.indexOf(q); at !== -1; at = lower.indexOf(q, from)) {
    if (at > from) parts.push(text.slice(from, at))
    parts.push(
      <mark key={at} className="json-hit">
        {text.slice(at, at + q.length)}
      </mark>
    )
    from = at + q.length
  }
  if (from === 0) return text
  if (from < text.length) parts.push(text.slice(from))
  return <>{parts}</>
}

/** One row: the content, plus "Copy path" and "Copy value" that appear on hover or focus. */
function Row({
  id,
  value,
  active,
  className,
  children
}: {
  id: string
  value: unknown
  active: boolean
  className?: string
  children: ReactNode
}): ReactNode {
  // The copy buttons are only in the tab order while focus is in the row, so a long tree does
  // not need three Tab presses per line.
  const [inside, setInside] = useState(false)
  return (
    <div
      className={cx('group flex items-start hover:bg-hover', active && 'json-active', className)}
      data-active-match={active ? '' : undefined}
      onFocus={() => setInside(true)}
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
  const needed = search?.need.get(id)
  const isMatch = ctx.matchIds.has(id)
  const active = search?.activeId === id
  const label = name !== undefined && (
    <>
      <span className="json-key">
        {isMatch && query ? (
          <Highlight text={JSON.stringify(name)} query={query} />
        ) : (
          JSON.stringify(name)
        )}
      </span>
      <span className="text-faint">: </span>
    </>
  )
  const comma = !last && <span className="text-faint">,</span>

  if (!isContainer) {
    return (
      <Row id={id} value={value} active={active} className="pl-4">
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

  // The first `shown` children, plus the ones a search match is inside (so a match far down a
  // long array is shown without rendering everything before it).
  const visible: number[] = []
  for (let i = 0; i < Math.min(shown, entries.length); i++) visible.push(i)
  if (needed) {
    for (const i of [...needed].sort((x, y) => x - y)) if (i >= shown) visible.push(i)
  }

  if (entries.length === 0) {
    return (
      <Row id={id} value={value} active={active} className="pl-4">
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
    <div>
      <Row id={id} value={value} active={active}>
        <button
          className="flex min-w-0 items-start text-left"
          aria-expanded={open}
          aria-label={`${name !== undefined ? name : 'root'} ${isArray ? 'array' : 'object'}, ${entries.length} ${entries.length === 1 ? (isArray ? 'item' : 'key') : isArray ? 'items' : 'keys'}`}
          onClick={() => setOpen((v) => !v)}
        >
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
                {entries.length}{' '}
                {isArray
                  ? entries.length === 1
                    ? 'item'
                    : 'items'
                  : entries.length === 1
                    ? 'key'
                    : 'keys'}{' '}
                {closeBracket}
                {!last && ','}
              </span>
            )}
          </span>
        </button>
      </Row>
      {open && (
        <>
          <div className="ml-[7px] border-l border-line pl-2">
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
  const text = typeof value === 'string' ? JSON.stringify(value) : String(value)
  const body = query ? <Highlight text={text} query={query} /> : text
  if (typeof value === 'string') return <span className="json-string">{body}</span>
  if (typeof value === 'number') return <span className="json-number">{body}</span>
  return <span className="json-literal">{body}</span>
}
