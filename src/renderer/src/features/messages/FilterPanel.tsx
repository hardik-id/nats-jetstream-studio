import { useId, useState, type ReactNode } from 'react'
import { ChevronUp, Plus, X } from 'lucide-react'
import type { ContentFilters, FilterCondition } from '@shared/api'
import {
  canonicalFilters,
  MAX_CONDITIONS,
  normalizeFilters,
  validateCondition
} from '@shared/filters'
import { Button, cx, Input, Select } from '../../components/ui'

type Kind = FilterCondition['kind']

/** One row of the panel. The fields of every kind are kept, so changing the type loses nothing. */
export interface DraftCondition {
  kind: Kind
  expr: string
  key: string
  value: string
  exclude: boolean
}

export interface FilterDraft {
  conditions: DraftCondition[]
  scanLimit: string
}

const blankRow = (): DraftCondition => ({
  kind: 'jsonPath',
  expr: '',
  key: '',
  value: '',
  exclude: false
})

export function draftFrom(filters: ContentFilters, scanLimit: number): FilterDraft {
  const conditions = normalizeFilters(filters).map((c): DraftCondition =>
    c.kind === 'header'
      ? { kind: 'header', expr: '', key: c.key, value: c.value ?? '', exclude: !!c.exclude }
      : { kind: c.kind, expr: c.expr, key: '', value: '', exclude: !!c.exclude }
  )
  // An empty panel starts with one row to type in.
  return { conditions: conditions.length ? conditions : [blankRow()], scanLimit: String(scanLimit) }
}

function rowToCondition(row: DraftCondition): FilterCondition {
  const exclude = row.exclude ? { exclude: true } : {}
  if (row.kind === 'header')
    return { kind: 'header', key: row.key, ...(row.value ? { value: row.value } : {}), ...exclude }
  return { kind: row.kind, expr: row.expr, ...exclude }
}

export function draftToFilters(draft: FilterDraft): ContentFilters {
  return canonicalFilters({ conditions: draft.conditions.map(rowToCondition) })
}

const KINDS: { kind: Kind; label: string }[] = [
  { kind: 'jsonPath', label: 'JSONPath' },
  { kind: 'contains', label: 'Contains' },
  { kind: 'regex', label: 'Regex' },
  { kind: 'header', label: 'Header' }
]

const PLACEHOLDER: Record<Exclude<Kind, 'header'>, string> = {
  jsonPath: '$.order.total > 100   or   $.tags contains "urgent"   or   $..status == "failed"',
  contains: 'Plain text, upper and lower case are treated the same',
  regex: '"id":"A-\\d+"'
}

/**
 * Filters on headers and payload (PBI-042, PBI-048, PBI-126): a list of conditions that must all
 * hold, each of which can be turned around to exclude what it matches. Unlike the subject filter
 * these are checked by scanning messages, so expressions are validated here before any scan starts.
 */
export function FilterPanel({
  id,
  compact,
  inert,
  initial,
  onApply,
  onClose
}: {
  /** The id the Filters button points at with `aria-controls`. */
  id?: string
  /** A message is open beside the table: leave more height for it. */
  compact?: boolean
  /** Covered by the expanded detail panel: no tab stops. */
  inert?: boolean
  initial: FilterDraft
  onApply: (filters: ContentFilters, scanLimit: number) => void
  onClose: () => void
}): ReactNode {
  const [draft, setDraft] = useState<FilterDraft>(initial)
  const errPrefix = useId()
  const [focusRow, setFocusRow] = useState<number | null>(null)
  const filters = draftToFilters(draft)
  const errors = draft.conditions.map((row) => validateCondition(rowToCondition(row)))
  const scanLimit = Number(draft.scanLimit)
  const scanError =
    !/^\d+$/.test(draft.scanLimit.trim()) || scanLimit < 1 ? 'Enter a number of messages' : null
  const valid = errors.every((e) => !e) && !scanError
  const setRow = (i: number, patch: Partial<DraftCondition>): void =>
    setDraft((d) => ({
      ...d,
      conditions: d.conditions.map((row, j) => (j === i ? { ...row, ...patch } : row))
    }))

  return (
    <form
      id={id}
      inert={inert}
      aria-label="Message filters"
      className={cx(
        'flex min-h-20 shrink flex-col border-b border-line bg-raised',
        // Never more than about a third of the window, so the table and the JSON keep room.
        compact
          ? 'max-h-[min(24vh,10rem)] [@media(max-height:800px)]:max-h-[max(5rem,11vh)]'
          : 'max-h-[35vh]'
      )}
      onSubmit={(e) => {
        e.preventDefault()
        if (valid) onApply(filters, scanLimit)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-4 py-2.5">
        <ul className="flex flex-col gap-1.5" aria-label="Conditions (all must match)">
          {draft.conditions.map((row, i) => {
            const n = i + 1
            const error = errors[i]
            return (
              <li key={i} className="flex flex-col gap-0.5">
                <div className="flex flex-wrap items-center gap-1.5 sm:flex-nowrap">
                  <Select
                    compact
                    className="w-32 shrink-0"
                    aria-label={`Condition ${n} type`}
                    value={row.kind}
                    onChange={(e) => setRow(i, { kind: e.target.value as Kind })}
                  >
                    {KINDS.map((k) => (
                      <option key={k.kind} value={k.kind}>
                        {k.label}
                      </option>
                    ))}
                  </Select>
                  {row.kind === 'header' ? (
                    <>
                      <Input
                        mono
                        compact
                        className="w-1/3 min-w-0"
                        aria-label={`Condition ${n} header name`}
                        placeholder="Header name"
                        value={row.key}
                        autoFocus={focusRow === i}
                        onChange={(e) => setRow(i, { key: e.target.value })}
                      />
                      <Input
                        mono
                        compact
                        className="min-w-0 flex-1"
                        aria-label={`Condition ${n} header value`}
                        placeholder="Value (empty: header exists)"
                        value={row.value}
                        onChange={(e) => setRow(i, { value: e.target.value })}
                      />
                    </>
                  ) : (
                    <Input
                      mono={row.kind !== 'contains'}
                      compact
                      className="min-w-0 flex-1"
                      aria-label={`Condition ${n} expression`}
                      aria-describedby={error ? `${errPrefix}-err-${i}` : undefined}
                      placeholder={PLACEHOLDER[row.kind]}
                      invalid={!!error}
                      value={row.expr}
                      autoFocus={focusRow === i}
                      onChange={(e) => setRow(i, { expr: e.target.value })}
                    />
                  )}
                  <Select
                    compact
                    className={cx('w-28 shrink-0', row.exclude && 'border-danger text-danger')}
                    aria-label={`Condition ${n} mode`}
                    value={row.exclude ? 'exclude' : 'include'}
                    onChange={(e) => setRow(i, { exclude: e.target.value === 'exclude' })}
                  >
                    <option value="include">Include</option>
                    <option value="exclude">Exclude</option>
                  </Select>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove condition ${n}`}
                    title={`Remove condition ${n}`}
                    icon={<X className="h-4 w-4" aria-hidden />}
                    onClick={() =>
                      setDraft((d) => ({
                        ...d,
                        conditions: d.conditions.filter((_, j) => j !== i)
                      }))
                    }
                  />
                </div>
                {error && (
                  <p
                    id={`${errPrefix}-err-${i}`}
                    role="alert"
                    className="pl-30 text-xs text-danger"
                  >
                    {error}
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line bg-raised px-4 py-2">
        <Button type="submit" variant="primary" disabled={!valid}>
          Apply filters
        </Button>
        <Button
          onClick={() => {
            const empty = draftFrom({}, Number(draft.scanLimit) || 10_000)
            setDraft(empty)
            onApply({}, Number(empty.scanLimit))
          }}
        >
          Clear
        </Button>
        <Button
          variant="ghost"
          onClick={onClose}
          title="Hide filters (Esc)"
          icon={<ChevronUp className="h-3.5 w-3.5" aria-hidden />}
        >
          Hide
        </Button>
        <Button
          size="sm"
          icon={<Plus className="h-3.5 w-3.5" aria-hidden />}
          disabled={draft.conditions.length >= MAX_CONDITIONS}
          title="All conditions must match. A condition set to Exclude rejects the messages it matches."
          onClick={() => {
            setFocusRow(draft.conditions.length)
            setDraft((d) => ({ ...d, conditions: [...d.conditions, blankRow()] }))
          }}
        >
          Add condition
        </Button>
        <span className="ml-auto flex min-w-0 items-center gap-1.5">
          <label
            htmlFor={`${errPrefix}-limit`}
            className="text-xs font-medium text-muted"
            title="Stop after examining this many messages. You can continue from there."
          >
            Scan limit
          </label>
          <Input
            id={`${errPrefix}-limit`}
            compact
            className="w-24"
            inputMode="numeric"
            invalid={!!scanError}
            aria-describedby={scanError ? `${errPrefix}-limit-err` : undefined}
            value={draft.scanLimit}
            onChange={(e) => setDraft((d) => ({ ...d, scanLimit: e.target.value }))}
          />
          {scanError && (
            <span id={`${errPrefix}-limit-err`} role="alert" className="text-xs text-danger">
              {scanError}
            </span>
          )}
        </span>
      </div>
    </form>
  )
}
