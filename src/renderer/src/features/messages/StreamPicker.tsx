import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { formatCount } from '@shared/format'
import { cx, Input } from '../../components/ui'
import { fuzzyFilter } from '../../lib/fuzzy'

export interface StreamOption {
  name: string
  messages: number
}

/** How many streams the list shows at once; typing narrows it down. */
const SHOWN = 100

/**
 * The stream chooser of the Messages tab (PBI-128): a combobox that filters as you type, used with
 * the arrow keys, Enter and Escape. It shows at most a hundred streams at once, so a connection with
 * hundreds of streams stays quick.
 */
export function StreamPicker({
  streams,
  value,
  onChange,
  loading,
  autoFocus,
  onOpen
}: {
  streams: StreamOption[]
  value?: string
  onChange: (stream: string) => void
  loading?: boolean
  autoFocus?: boolean
  /** Called when the list opens, so the caller can refresh it. */
  onOpen?: () => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const listRef = useRef<HTMLUListElement>(null)
  const listId = useId()

  const matched = useMemo(
    () => fuzzyFilter(streams, query, (s) => s.name, Number.MAX_SAFE_INTEGER),
    [streams, query]
  )
  const shown = matched.slice(0, SHOWN)
  const active = Math.min(cursor, shown.length - 1)

  useEffect(() => {
    if (!open) return
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [open, active])

  const show = (): void => {
    setOpen(true)
    setQuery('')
    setCursor(
      Math.max(
        0,
        streams.slice(0, SHOWN).findIndex((s) => s.name === value)
      )
    )
    onOpen?.()
  }
  const hide = (): void => {
    setOpen(false)
    setQuery('')
  }
  const choose = (option: StreamOption | undefined): void => {
    if (!option) return
    hide()
    if (option.name !== value) onChange(option.name)
  }

  return (
    <div className="relative w-64 max-w-full">
      <Input
        autoFocus={autoFocus}
        mono
        role="combobox"
        aria-label="Stream"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && shown[active] ? `${listId}-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        placeholder={open ? 'Type to filter streams' : 'Choose a stream'}
        className="pr-7"
        value={open ? query : (value ?? '')}
        onClick={() => {
          if (!open) show()
        }}
        onBlur={hide}
        onChange={(e) => {
          if (!open) onOpen?.()
          setOpen(true)
          setQuery(e.target.value)
          setCursor(0)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            if (!open) show()
            else setCursor(Math.min(shown.length - 1, active + 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            if (open) setCursor(Math.max(0, active - 1))
          } else if (e.key === 'Enter') {
            if (!open) return
            e.preventDefault()
            choose(shown[active])
          } else if (e.key === 'Escape') {
            if (!open) return
            e.preventDefault()
            e.stopPropagation()
            hide()
          }
        }}
      />
      <ChevronDown
        className="pointer-events-none absolute top-1/2 right-2 h-3.5 w-3.5 -translate-y-1/2 text-faint"
        aria-hidden
      />
      {open && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Streams"
          className="absolute top-full right-0 z-30 mt-1 max-h-80 w-[min(24rem,90vw)] overflow-y-auto rounded-md border border-line bg-panel py-1 shadow-lg"
        >
          {shown.map((option, i) => (
            <li
              key={option.name}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              // Keep the focus in the field, so the list does not close before the click lands.
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => setCursor(i)}
              onClick={() => choose(option)}
              className={cx(
                'mx-1 flex h-7 cursor-default items-center gap-2 rounded-md px-2',
                i === active && 'bg-accent-soft'
              )}
            >
              <Check
                className={cx(
                  'h-3.5 w-3.5 shrink-0',
                  option.name === value ? 'text-accent' : 'invisible'
                )}
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{option.name}</span>
              <span className="tabular shrink-0 text-xs text-muted">
                {formatCount(option.messages)}
              </span>
            </li>
          ))}
          {shown.length === 0 && (
            <li role="presentation" className="px-3 py-2 text-muted">
              {loading
                ? 'Loading streams'
                : query
                  ? `No stream matches “${query}”`
                  : 'This connection has no streams'}
            </li>
          )}
          {matched.length > shown.length && (
            <li role="presentation" className="px-3 pt-1 pb-0.5 text-xs text-faint">
              Showing {SHOWN} of {formatCount(matched.length)} streams. Type to narrow the list.
            </li>
          )}
        </ul>
      )}
    </div>
  )
}
