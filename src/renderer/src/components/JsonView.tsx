import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

const CHUNK = 200

/** A collapsible tree for JSON values. Large arrays and objects are shown in chunks. */
export function JsonView({
  value,
  expandDepth = 2
}: {
  value: unknown
  expandDepth?: number
}): ReactNode {
  return (
    <div className="font-mono text-xs leading-5">
      <Node value={value} depth={0} expandDepth={expandDepth} />
    </div>
  )
}

function Node({
  name,
  value,
  depth,
  expandDepth,
  last = true
}: {
  name?: string
  value: unknown
  depth: number
  expandDepth: number
  last?: boolean
}): ReactNode {
  const [open, setOpen] = useState(depth < expandDepth)
  const [shown, setShown] = useState(CHUNK)
  const label = name !== undefined && (
    <>
      <span className="json-key">{JSON.stringify(name)}</span>
      <span className="text-faint">: </span>
    </>
  )
  const comma = !last && <span className="text-faint">,</span>

  if (value === null || typeof value !== 'object') {
    return (
      <div className="pl-4">
        {label}
        <Primitive value={value} />
        {comma}
      </div>
    )
  }

  const isArray = Array.isArray(value)
  const entries: [string | undefined, unknown][] = isArray
    ? (value as unknown[]).map((v) => [undefined, v])
    : Object.entries(value as object)
  const [openBracket, closeBracket] = isArray ? ['[', ']'] : ['{', '}']

  if (entries.length === 0) {
    return (
      <div className="pl-4">
        {label}
        <span className="text-faint">
          {openBracket}
          {closeBracket}
        </span>
        {comma}
      </div>
    )
  }

  return (
    <div>
      <button
        className="flex w-full items-center text-left hover:bg-hover"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? (
          <ChevronDown className="h-3.5 w-4 shrink-0 text-faint" aria-hidden />
        ) : (
          <ChevronRight className="h-3.5 w-4 shrink-0 text-faint" aria-hidden />
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
      {open && (
        <>
          <div className="ml-[7px] border-l border-line pl-2">
            {entries.slice(0, shown).map(([key, child], i) => (
              <Node
                key={key ?? i}
                name={key}
                value={child}
                depth={depth + 1}
                expandDepth={expandDepth}
                last={i === entries.length - 1}
              />
            ))}
            {entries.length > shown && (
              <button
                className="ml-4 text-accent hover:underline"
                onClick={() => setShown((n) => n + CHUNK * 5)}
              >
                Show more ({entries.length - shown} hidden)
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

function Primitive({ value }: { value: unknown }): ReactNode {
  if (typeof value === 'string')
    return (
      <span className="json-string break-all whitespace-pre-wrap">{JSON.stringify(value)}</span>
    )
  if (typeof value === 'number') return <span className="json-number">{String(value)}</span>
  return <span className="json-literal">{String(value)}</span>
}
