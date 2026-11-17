import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronUp, FoldVertical, Search, UnfoldVertical, X } from 'lucide-react'
import type { FilterCondition } from '@shared/api'
import { fromBase64, toHexDump, tryDecodeText, utf8Decode } from '@shared/encoding'
import { formatBytes } from '@shared/format'
import { fitDepth, maxDepth, searchJson, SEARCH_MAX_MATCHES } from '@shared/jsonTree'
import { useSetting } from '../lib/hooks'
import type { PayloadDecoder } from '../lib/decoders'
import { JSON_CHUNK, JsonView } from './JsonView'
import { Button, CopyButton, cx, Notice, SubTabs } from './ui'

type View = 'decoded' | 'json' | 'text' | 'hex' | 'base64'
const HEX_LIMIT = 64 * 1024
/** Text sizes in px, smallest first; the first is the default. */
export const PAYLOAD_FONT_SIZES = [13, 15, 17]
const SEARCH_DEBOUNCE_MS = 200
type Levels = number | 'all'

export interface PayloadViewerProps {
  /** Base64. */
  payload: string
  /** Full size in bytes; larger than the payload when it is truncated. */
  size: number
  truncated?: boolean
  subject?: string
  decoders?: PayloadDecoder[]
  onLoadFull?: () => void
  loadingFull?: boolean
  className?: string
  /** Show the size at the right of the toolbar (default). A caller that shows it elsewhere hides it. */
  showSize?: boolean
  /** Adds "Filter" and "Exclude" buttons to the JSON tree's primitive rows (message browser). */
  onFilter?: (condition: FilterCondition) => void
}

/**
 * Shows a payload as JSON, text, hex or base64 (PBI-043). The format is detected, and the user
 * can switch. A registered decoder (Protobuf) adds a decoded view and becomes the default.
 */
export function PayloadViewer({
  payload,
  size,
  truncated,
  subject,
  decoders,
  onLoadFull,
  loadingFull,
  className,
  showSize = true,
  onFilter
}: PayloadViewerProps): ReactNode {
  const parsed = useMemo(() => {
    const bytes = fromBase64(payload)
    const text = tryDecodeText(bytes)
    let json: unknown
    let isJson = false
    if (text !== null && /^\s*[[{"\-0-9tfn]/.test(text)) {
      try {
        json = JSON.parse(text)
        isJson = typeof json === 'object' && json !== null
      } catch {
        // Not JSON.
      }
    }
    let decoded: { label: string; value?: unknown; error?: string } | undefined
    const decoder = subject ? decoders?.find((d) => d.matches(subject)) : undefined
    if (decoder) {
      try {
        decoded = { label: decoder.label, value: decoder.decode(bytes) }
      } catch (err) {
        decoded = { label: decoder.label, error: (err as Error).message }
      }
    }
    return { bytes, text, json, isJson, decoded }
  }, [payload, subject, decoders])

  const detected: View =
    parsed.decoded && !parsed.decoded.error
      ? 'decoded'
      : parsed.isJson
        ? 'json'
        : parsed.text !== null
          ? 'text'
          : 'hex'
  const [chosen, setChosen] = useState<View | null>(null)
  const [wrap, setWrap] = useState(true)
  const available: View[] = [
    ...(parsed.decoded ? (['decoded'] as View[]) : []),
    ...(parsed.isJson ? (['json'] as View[]) : []),
    'text',
    'hex',
    'base64'
  ]
  const view = chosen && available.includes(chosen) ? chosen : detected

  const [storedStep, setStoredStep, stepLoaded, stepError] = useSetting<number>(
    'payload.fontStep',
    0
  )
  const step = Number.isInteger(storedStep)
    ? Math.min(PAYLOAD_FONT_SIZES.length - 1, Math.max(0, storedStep))
    : 0
  const fontSize = PAYLOAD_FONT_SIZES[step]
  // Quick clicks both count (start from the last value written); nothing is written before the
  // stored value has been read.
  const stepRef = useRef(step)
  useEffect(() => {
    stepRef.current = step
  }, [step])
  const changeStep = (by: number): void => {
    if (!stepLoaded && stepError === null) return
    const next = Math.min(PAYLOAD_FONT_SIZES.length - 1, Math.max(0, stepRef.current + by))
    stepRef.current = next
    void setStoredStep(next)
  }

  // The tree views: levels, a reset counter for Expand all and Collapse all, and the search.
  const treeValue = view === 'decoded' ? parsed.decoded?.value : parsed.json
  const isTree = (view === 'decoded' && !parsed.decoded?.error) || view === 'json'
  const [levels, setLevels] = useState<Levels>(3)
  const [resetKey, setResetKey] = useState(0)
  const [searchText, setSearchText] = useState('')
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  // Counts Next and Previous presses, so a node the user closed by hand opens again.
  const [navCount, setNavCount] = useState(0)
  const searchInput = useRef<HTMLInputElement>(null)
  const bodyBox = useRef<HTMLDivElement>(null)
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(debounce.current), [])
  const changeSearch = (text: string): void => {
    setSearchText(text)
    clearTimeout(debounce.current)
    // Walking a large payload on every key press would stall typing, so wait for a pause.
    debounce.current = setTimeout(() => {
      setQuery(text)
      setActiveIndex(0)
    }, SEARCH_DEBOUNCE_MS)
  }
  const clearSearch = (): void => {
    clearTimeout(debounce.current)
    setSearchText('')
    setQuery('')
    setActiveIndex(0)
  }
  const search = useMemo(
    () => (isTree ? searchJson(treeValue, query) : null),
    [isTree, treeValue, query]
  )
  const matchCount = search?.matches.length ?? 0
  const active = matchCount ? Math.min(activeIndex, matchCount - 1) : 0
  const depth = useMemo(() => {
    if (!isTree) return 0
    const wanted = levels === 'all' ? maxDepth(treeValue) : levels
    return fitDepth(treeValue, wanted, JSON_CHUNK)
  }, [isTree, treeValue, levels])
  const clamped = levels === 'all' && depth < maxDepth(treeValue)
  const moveMatch = (by: number): void => {
    if (!matchCount) return
    setActiveIndex((active + by + matchCount) % matchCount)
    setNavCount((n) => n + 1)
  }
  const setLevel = (l: Levels): void => {
    setLevels(l)
    setResetKey((k) => k + 1)
  }

  const copyText = (): string => {
    switch (view) {
      case 'decoded':
        return JSON.stringify(parsed.decoded?.value, null, 2)
      case 'json':
        return JSON.stringify(parsed.json, null, 2)
      case 'text':
        return parsed.text ?? utf8Decode(parsed.bytes)
      case 'hex':
        return toHexDump(parsed.bytes)
      case 'base64':
        return payload
    }
  }

  const labels: Record<View, string> = {
    decoded: parsed.decoded?.label ?? 'Decoded',
    json: 'JSON',
    text: 'Text',
    hex: 'Hex',
    base64: 'Base64'
  }

  const textStyle = { fontSize }
  const toolButton = (pressed?: boolean): string =>
    cx(
      'inline-flex h-6 items-center gap-1 rounded border px-2 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50',
      pressed ? 'border-accent text-accent' : 'border-line text-muted hover:text-fg'
    )

  return (
    <div
      className={cx('flex min-h-0 flex-col', className)}
      onKeyDown={(e) => {
        // Ctrl or Cmd+F inside the payload searches the JSON instead of the page.
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && isTree) {
          e.preventDefault()
          searchInput.current?.focus()
          searchInput.current?.select()
        }
      }}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-1 pb-0.5">
        <SubTabs
          bare
          ariaLabel="Payload format"
          tabs={available.map((v) => ({ id: v, label: labels[v] }))}
          active={view}
          onChange={setChosen}
        />
        <span className="ml-auto text-xs text-faint">{showSize && formatBytes(size)}</span>
        <span className="inline-flex gap-0.5" role="group" aria-label="Text size">
          <button
            type="button"
            className={toolButton()}
            disabled={step === 0}
            title="Smaller text"
            aria-label="Smaller text"
            onClick={() => changeStep(-1)}
          >
            A-
          </button>
          <button
            type="button"
            className={toolButton()}
            disabled={step === PAYLOAD_FONT_SIZES.length - 1}
            title="Larger text"
            aria-label="Larger text"
            onClick={() => changeStep(1)}
          >
            A+
          </button>
        </span>
        {view !== 'hex' && (
          <button
            type="button"
            aria-pressed={wrap}
            onClick={() => setWrap((w) => !w)}
            className={toolButton(wrap)}
          >
            Wrap
          </button>
        )}
        <CopyButton text={copyText} label="Copy payload" />
      </div>

      {isTree && size > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-1 pb-0.5">
          <span className="inline-flex items-center gap-0.5" role="group" aria-label="Levels">
            <span className="pr-1 text-xs text-faint">Levels</span>
            {([1, 2, 3, 'all'] as Levels[]).map((l) => (
              <button
                key={l}
                type="button"
                aria-pressed={levels === l}
                className={toolButton(levels === l)}
                onClick={() => setLevel(l)}
              >
                {l === 'all' ? 'All' : l}
              </button>
            ))}
          </span>
          <button
            type="button"
            className={cx(toolButton(), 'w-7 justify-center px-0')}
            title="Expand all levels"
            aria-label="Expand all"
            onClick={() => setLevel('all')}
          >
            <UnfoldVertical className="h-4 w-4 text-fg" aria-hidden />
          </button>
          <button
            type="button"
            className={cx(toolButton(), 'w-7 justify-center px-0')}
            title="Collapse all levels"
            aria-label="Collapse all"
            onClick={() => setLevel(0)}
          >
            <FoldVertical className="h-4 w-4 text-fg" aria-hidden />
          </button>
          <span className="relative ml-auto inline-flex min-w-0 items-center gap-0.5">
            <Search
              className="pointer-events-none absolute left-1.5 h-3.5 w-3.5 text-faint"
              aria-hidden
            />
            <input
              ref={searchInput}
              type="text"
              aria-label="Search in JSON"
              placeholder="Search"
              value={searchText}
              onChange={(e) => changeSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  moveMatch(e.shiftKey ? -1 : 1)
                } else if (e.key === 'Escape') {
                  // Clear first; the panel's own Escape (close or restore) is not for this.
                  e.preventDefault()
                  e.stopPropagation()
                  if (searchText) clearSearch()
                  else bodyBox.current?.focus()
                }
              }}
              className="h-6 w-28 rounded border border-line bg-panel pr-1.5 pl-6 text-xs text-fg placeholder:text-faint"
            />
            {searchText && (
              <button
                type="button"
                className={cx(toolButton(), 'w-6 justify-center px-0')}
                title="Clear search"
                aria-label="Clear search"
                onClick={() => {
                  clearSearch()
                  searchInput.current?.focus()
                }}
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            )}
            <button
              type="button"
              className={cx(toolButton(), 'w-6 justify-center px-0')}
              title="Previous match (Shift+Enter)"
              aria-label="Previous match"
              disabled={matchCount === 0}
              onClick={() => moveMatch(-1)}
            >
              <ChevronUp className="h-3.5 w-3.5" aria-hidden />
            </button>
            <button
              type="button"
              className={cx(toolButton(), 'w-6 justify-center px-0')}
              title="Next match (Enter)"
              aria-label="Next match"
              disabled={matchCount === 0}
              onClick={() => moveMatch(1)}
            >
              <ChevronDown className="h-3.5 w-3.5" aria-hidden />
            </button>
            <span
              className="min-w-14 text-xs whitespace-nowrap text-muted tabular"
              role="status"
              data-testid="json-match-count"
            >
              {!query
                ? ''
                : matchCount === 0
                  ? 'No matches'
                  : `${active + 1} of ${matchCount}${search?.truncated ? '+' : ''}`}
            </span>
          </span>
        </div>
      )}
      {isTree && query && search?.truncated && (
        <p className="shrink-0 pb-1 text-xs text-faint">
          {matchCount >= SEARCH_MAX_MATCHES
            ? `Showing the first ${SEARCH_MAX_MATCHES} matches.`
            : 'The payload is large, so only the first part was searched.'}
        </p>
      )}
      {isTree && clamped && (
        <p className="shrink-0 pb-1 text-xs text-faint">
          The payload is large, so the tree opens to level {depth}. Open the rest one node at a
          time.
        </p>
      )}

      {truncated && (
        <Notice
          tone="warn"
          className="mb-1.5 flex shrink-0 items-center justify-between gap-2 text-xs"
        >
          <span>
            Showing the first {formatBytes(parsed.bytes.length)} of {formatBytes(size)}.
          </span>
          {onLoadFull && (
            <Button size="sm" busy={loadingFull} onClick={onLoadFull}>
              Load full payload
            </Button>
          )}
        </Notice>
      )}
      {parsed.decoded?.error && view === 'decoded' && (
        <Notice tone="danger" className="mb-1.5 shrink-0 text-xs">
          {parsed.decoded.label} could not decode this payload: {parsed.decoded.error}. Showing hex
          instead.
        </Notice>
      )}

      <div
        ref={bodyBox}
        tabIndex={-1}
        className="min-h-0 flex-1 overflow-auto rounded-md border border-line bg-code p-2"
        data-testid="payload-body"
      >
        {size === 0 ? (
          <span className="text-faint">Empty payload</span>
        ) : isTree ? (
          <JsonView
            value={treeValue}
            expandDepth={depth}
            resetKey={resetKey}
            onFilter={onFilter}
            wrap={wrap}
            fontSize={fontSize}
            search={
              search && query
                ? { ...search, query, activeId: search.matches[active]?.id ?? null, nav: navCount }
                : undefined
            }
          />
        ) : view === 'text' ? (
          <pre
            style={textStyle}
            className={cx(
              'font-mono leading-[1.65]',
              wrap ? 'break-all whitespace-pre-wrap' : 'whitespace-pre'
            )}
          >
            {parsed.text ?? utf8Decode(parsed.bytes)}
          </pre>
        ) : view === 'base64' ? (
          <pre
            style={textStyle}
            className={cx(
              'font-mono leading-[1.65]',
              wrap ? 'break-all whitespace-pre-wrap' : 'whitespace-pre'
            )}
          >
            {payload}
          </pre>
        ) : (
          <>
            <pre style={textStyle} className="font-mono leading-[1.65]">
              {toHexDump(parsed.bytes.subarray(0, HEX_LIMIT))}
            </pre>
            {parsed.bytes.length > HEX_LIMIT && (
              <p className="pt-1 text-xs text-faint">
                Hex view stops at {formatBytes(HEX_LIMIT)}. Copy or export the message for the rest.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
