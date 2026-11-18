import { type ReactNode } from 'react'
import { Play, Plus, Square } from 'lucide-react'
import {
  DAY,
  DEFAULT_SCAN_LIMIT,
  HOUR,
  MAX_SCAN_LIMIT,
  MIN_SCAN_LIMIT,
  MINUTE,
  type TraceQuery,
  type TraceRule,
  type TraceWindow
} from '@shared/trace'
import { Button, Checkbox, Input, Select } from '../../components/ui'
import type { StreamOption } from '../messages/StreamPicker'
import { isSystemStream } from '../subjects/subjectTree'
import { Popover } from './Popover'
import { RuleRow } from './RuleRow'
import { StreamsMenu } from './StreamsMenu'
import { TRACE_VIEWS } from './views/registry'

/** The most match rules a trace can have. */
const MAX_RULES = 8

interface WindowOption {
  key: string
  label: string
  kind: 'around' | 'last'
  /** Half the width for `around`, the length for `last`. */
  ms: number
}

const AROUND: WindowOption[] = [
  { key: 'around:5m', label: '±5 min around the message', kind: 'around', ms: 5 * MINUTE },
  { key: 'around:15m', label: '±15 min around the message', kind: 'around', ms: 15 * MINUTE },
  { key: 'around:1h', label: '±1 h around the message', kind: 'around', ms: HOUR }
]

const LAST: WindowOption[] = [
  { key: 'last:1h', label: 'Last 1 h', kind: 'last', ms: HOUR },
  { key: 'last:24h', label: 'Last 24 h', kind: 'last', ms: DAY },
  { key: 'last:7d', label: 'Last 7 days', kind: 'last', ms: 7 * DAY }
]

/** The window "Run" starts from when nothing was chosen. */
export const DEFAULT_WINDOW: TraceWindow = { kind: 'last', ms: DAY }

function toWindow(o: WindowOption, anchor: string | undefined): TraceWindow {
  return o.kind === 'around'
    ? { kind: 'around', anchor: anchor ?? new Date().toISOString(), ms: o.ms }
    : { kind: 'last', ms: o.ms }
}

function windowKey(w: TraceWindow): string {
  if (w.kind === 'range') return 'range'
  return [...AROUND, ...LAST].find((o) => o.kind === w.kind && o.ms === w.ms)?.key ?? ''
}

/** `datetime-local` text for a time, in the user's time zone. */
function toLocalInput(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** The ISO time of `datetime-local` text; an end covers the whole minute it names (to :59.999). */
function fromLocalInput(text: string, end = false): string {
  const d = new Date(text)
  if (Number.isNaN(d.getTime())) return ''
  if (end) d.setSeconds(59, 999)
  return d.toISOString()
}

/** An explicit stream choice without the system streams; nothing left means "all". */
function withoutSystem(streams: string[] | undefined): string[] | undefined {
  const kept = streams?.filter((n) => !isSystemStream(n))
  return kept && kept.length > 0 ? kept : undefined
}

/** A new, empty rule of the kind people reach for first. */
export const blankRule = (): TraceRule => ({ kind: 'header', key: '', value: '' })

/**
 * The parameters of a trace: what to match, which streams, which window. It edits a draft; Run
 * applies the draft to the tab (see `TraceTab`). With one view in the registry there is no View
 * dropdown.
 */
export function TraceToolbar({
  draft,
  onChange,
  anchor,
  streams,
  streamsLoading,
  running,
  problem,
  viewId,
  onViewChange,
  onRun,
  onCancel
}: {
  draft: TraceQuery
  onChange: (draft: TraceQuery) => void
  /** The time of the message the trace was started from, which enables the "around" windows. */
  anchor?: string
  /** The streams that can be chosen (system streams only when they are included). */
  streams: StreamOption[]
  streamsLoading?: boolean
  running: boolean
  /** Why Run did not start, shown under the controls. */
  problem?: string
  viewId: string
  onViewChange: (id: string) => void
  onRun: () => void
  onCancel: () => void
}): ReactNode {
  const set = (patch: Partial<TraceQuery>): void => onChange({ ...draft, ...patch })
  const setRule = (i: number, rule: TraceRule): void =>
    set({ rules: draft.rules.map((r, j) => (j === i ? rule : r)) })
  const windowOptions = anchor ? [...AROUND, ...LAST] : LAST
  const w = draft.window
  const chooseWindow = (key: string): void => {
    if (key === 'range') {
      const now = Date.now()
      set({
        window: {
          kind: 'range',
          from: new Date(now - HOUR).toISOString(),
          to: new Date(now).toISOString()
        }
      })
      return
    }
    const option = windowOptions.find((o) => o.key === key)
    if (option) set({ window: toWindow(option, anchor) })
  }

  return (
    <form
      aria-label="Trace parameters"
      className="flex flex-col gap-2 border-b border-line bg-panel px-4 py-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (!running) onRun()
      }}
    >
      <div className="flex flex-col gap-1.5">
        {draft.rules.map((rule, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <span className="w-10 text-xs text-faint">{i === 0 ? 'Match' : 'or'}</span>
            <RuleRow
              rule={rule}
              index={i}
              onChange={(r) => setRule(i, r)}
              onRemove={
                draft.rules.length > 1
                  ? () => set({ rules: draft.rules.filter((_, j) => j !== i) })
                  : undefined
              }
            />
            {i === draft.rules.length - 1 && draft.rules.length < MAX_RULES && (
              <Button
                size="sm"
                variant="ghost"
                icon={<Plus className="h-3.5 w-3.5" aria-hidden />}
                title="Also match another header, field or text (a message that matches any rule is part of the trace)"
                onClick={() => set({ rules: [...draft.rules, blankRule()] })}
              >
                or
              </Button>
            )}
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {TRACE_VIEWS.length > 1 && (
          <label className="flex items-center gap-1.5 text-xs text-faint">
            View
            <Select
              compact
              className="w-32"
              value={viewId}
              onChange={(e) => onViewChange(e.target.value)}
            >
              {TRACE_VIEWS.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </Select>
          </label>
        )}
        <StreamsMenu
          options={streams}
          value={draft.streams}
          onChange={(chosen) => set({ streams: chosen })}
        />
        {streamsLoading && <span className="sr-only">Loading streams</span>}
        <label className="flex items-center gap-1.5 text-xs text-faint">
          Window
          <Select
            compact
            className="w-60"
            value={windowKey(w)}
            onChange={(e) => chooseWindow(e.target.value)}
          >
            {windowKey(w) === '' && <option value="">Custom length</option>}
            {anchor && (
              <optgroup label="Around the message">
                {AROUND.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label={anchor ? 'Absolute' : 'Recent'}>
              {LAST.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
              <option value="range">Custom range</option>
            </optgroup>
          </Select>
        </label>
        {w.kind === 'range' && (
          <>
            <Input
              compact
              type="datetime-local"
              className="w-48"
              aria-label="Window start"
              value={toLocalInput(w.from)}
              onChange={(e) => set({ window: { ...w, from: fromLocalInput(e.target.value) } })}
            />
            <span className="text-muted" aria-hidden>
              to
            </span>
            <Input
              compact
              type="datetime-local"
              className="w-48"
              aria-label="Window end"
              value={toLocalInput(w.to)}
              onChange={(e) => set({ window: { ...w, to: fromLocalInput(e.target.value, true) } })}
            />
          </>
        )}
        <Popover label="More">
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-[13px]">
              Scan limit per stream
              <Input
                compact
                type="number"
                min={MIN_SCAN_LIMIT}
                max={MAX_SCAN_LIMIT}
                step={MIN_SCAN_LIMIT}
                value={draft.scanLimit ?? DEFAULT_SCAN_LIMIT}
                onChange={(e) => {
                  const n = Number(e.target.value)
                  set({ scanLimit: Number.isFinite(n) && n > 0 ? n : undefined })
                }}
              />
              <span className="text-xs text-muted">
                Most messages read in one stream. A stream that reaches it is reported as partial.
              </span>
            </label>
            <Checkbox
              label="Include system streams"
              hint="The buckets of KV and Object Store."
              checked={draft.includeSystem === true}
              onChange={(e) =>
                set({
                  includeSystem: e.target.checked,
                  // Switching system streams off drops only them from an explicit choice.
                  streams: e.target.checked ? draft.streams : withoutSystem(draft.streams)
                })
              }
            />
          </div>
        </Popover>
        <span className="ml-auto flex items-center gap-2">
          {running ? (
            <Button icon={<Square className="h-3.5 w-3.5" aria-hidden />} onClick={onCancel}>
              Cancel
            </Button>
          ) : (
            <Button
              type="submit"
              variant="primary"
              icon={<Play className="h-3.5 w-3.5" aria-hidden />}
            >
              Run trace
            </Button>
          )}
        </span>
      </div>
      {problem && (
        <p role="alert" className="text-xs text-danger">
          {problem}
        </p>
      )}
    </form>
  )
}
