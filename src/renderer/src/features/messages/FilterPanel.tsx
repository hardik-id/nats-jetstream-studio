import { useState, type ReactNode } from 'react'
import { ChevronUp, Plus, X } from 'lucide-react'
import type { ContentFilters, HeaderFilter } from '@shared/api'
import { validateFilters } from '@shared/filters'
import { Button, cx, Field, Input } from '../../components/ui'

export interface FilterDraft {
  headers: HeaderFilter[]
  payloadContains: string
  payloadRegex: string
  jsonPath: string
  scanLimit: string
}

export function draftFrom(filters: ContentFilters, scanLimit: number): FilterDraft {
  return {
    headers: filters.headers?.length ? filters.headers.map((h) => ({ ...h })) : [],
    payloadContains: filters.payloadContains ?? '',
    payloadRegex: filters.payloadRegex ?? '',
    jsonPath: filters.jsonPath ?? '',
    scanLimit: String(scanLimit)
  }
}

export function draftToFilters(draft: FilterDraft): ContentFilters {
  const filters: ContentFilters = {}
  const headers = draft.headers
    .filter((h) => h.key.trim())
    .map((h) => ({ key: h.key.trim(), value: h.value?.trim() ? h.value : undefined }))
  if (headers.length) filters.headers = headers
  if (draft.payloadContains) filters.payloadContains = draft.payloadContains
  if (draft.payloadRegex) filters.payloadRegex = draft.payloadRegex
  if (draft.jsonPath.trim()) filters.jsonPath = draft.jsonPath.trim()
  return filters
}

/**
 * Filters on headers and payload (PBI-042, PBI-048). Unlike the subject filter these are checked
 * by scanning messages, so expressions are validated here before any scan starts.
 */
export function FilterPanel({
  id,
  compact,
  initial,
  onApply,
  onClose
}: {
  /** The id the Filters button points at with `aria-controls`. */
  id?: string
  /** A message is open beside the table: leave more height for it. */
  compact?: boolean
  initial: FilterDraft
  onApply: (filters: ContentFilters, scanLimit: number) => void
  onClose: () => void
}): ReactNode {
  const [draft, setDraft] = useState<FilterDraft>(initial)
  const filters = draftToFilters(draft)
  const errors = validateFilters(filters)
  const scanLimit = Number(draft.scanLimit)
  const scanError =
    !/^\d+$/.test(draft.scanLimit.trim()) || scanLimit < 1 ? 'Enter a number of messages' : null
  const valid = Object.keys(errors).length === 0 && !scanError
  const set = <K extends keyof FilterDraft>(key: K, value: FilterDraft[K]): void =>
    setDraft((d) => ({ ...d, [key]: value }))

  return (
    <form
      id={id}
      aria-label="Message filters"
      className={cx(
        'flex min-h-20 shrink flex-col border-b border-line bg-raised',
        // Never more than about a third of the window, so the table and the JSON keep room.
        compact ? 'max-h-[min(24vh,10rem)]' : 'max-h-[35vh]'
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
      <div className="grid min-h-0 flex-1 grid-cols-1 content-start gap-x-6 gap-y-2 overflow-y-auto px-4 py-2.5 md:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted">Headers</span>
          {draft.headers.map((h, i) => (
            <div key={i} className="flex gap-1.5">
              <Input
                mono
                className="w-2/5"
                aria-label={`Header filter ${i + 1} name`}
                placeholder="Header name"
                value={h.key}
                onChange={(e) =>
                  set(
                    'headers',
                    draft.headers.map((x, j) => (j === i ? { ...x, key: e.target.value } : x))
                  )
                }
              />
              <Input
                mono
                aria-label={`Header filter ${i + 1} value`}
                placeholder="Value (empty: header exists)"
                value={h.value ?? ''}
                onChange={(e) =>
                  set(
                    'headers',
                    draft.headers.map((x, j) => (j === i ? { ...x, value: e.target.value } : x))
                  )
                }
              />
              <Button
                variant="ghost"
                aria-label={`Remove header filter ${i + 1}`}
                icon={<X className="h-4 w-4" aria-hidden />}
                onClick={() =>
                  set(
                    'headers',
                    draft.headers.filter((_, j) => j !== i)
                  )
                }
              />
            </div>
          ))}
          <div>
            <Button
              size="sm"
              icon={<Plus className="h-3.5 w-3.5" aria-hidden />}
              onClick={() => set('headers', [...draft.headers, { key: '', value: '' }])}
            >
              Add header filter
            </Button>
          </div>
          <Field
            label="Scan limit"
            hint="Stop after examining this many messages. You can continue from there."
            error={scanError}
            className="w-56"
          >
            {(id) => (
              <Input
                id={id}
                inputMode="numeric"
                invalid={!!scanError}
                value={draft.scanLimit}
                onChange={(e) => set('scanLimit', e.target.value)}
              />
            )}
          </Field>
        </div>

        <div className="flex flex-col gap-2">
          <Field
            label="Payload contains"
            hint="Plain text, upper and lower case are treated the same."
          >
            {(id) => (
              <Input
                id={id}
                value={draft.payloadContains}
                onChange={(e) => set('payloadContains', e.target.value)}
              />
            )}
          </Field>
          <Field label="Payload matches regular expression" error={errors.payloadRegex}>
            {(id) => (
              <Input
                id={id}
                mono
                placeholder={'"id":"A-\\d+"'}
                invalid={!!errors.payloadRegex}
                value={draft.payloadRegex}
                onChange={(e) => set('payloadRegex', e.target.value)}
              />
            )}
          </Field>
          <Field
            label="JSONPath"
            hint='For example $.order.total > 100, $.tags contains "urgent" or $..status == "failed"'
            error={errors.jsonPath}
          >
            {(id) => (
              <Input
                id={id}
                mono
                placeholder="$.order.total > 100"
                invalid={!!errors.jsonPath}
                value={draft.jsonPath}
                onChange={(e) => set('jsonPath', e.target.value)}
              />
            )}
          </Field>
        </div>
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
        <span className="hidden min-w-0 text-xs text-muted lg:inline">
          All filters must match. The subject filter is applied by the server; these are applied
          while scanning.
        </span>
      </div>
    </form>
  )
}
