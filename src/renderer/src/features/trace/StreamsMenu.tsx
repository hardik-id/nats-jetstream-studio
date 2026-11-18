import { type ReactNode } from 'react'
import { formatCount } from '@shared/format'
import { Checkbox } from '../../components/ui'
import type { StreamOption } from '../messages/StreamPicker'
import { Popover } from './Popover'

/** "All (6)", the stream's name, or "2 of 6". */
export function streamsSummary(chosen: string[] | undefined, total: number): string {
  if (chosen === undefined) return `All (${total})`
  if (chosen.length === 1) return chosen[0]
  return `${chosen.length} of ${total}`
}

/**
 * Which streams a trace searches: all of them, or a chosen few. Streams the user cannot pick
 * (system streams, unless included) are not listed.
 */
export function StreamsMenu({
  options,
  value,
  onChange
}: {
  options: StreamOption[]
  /** The chosen streams; undefined means all of `options`. */
  value: string[] | undefined
  onChange: (streams: string[] | undefined) => void
}): ReactNode {
  const toggle = (name: string, on: boolean): void => {
    const current = value ?? options.map((o) => o.name)
    const next = on ? [...current, name] : current.filter((n) => n !== name)
    // Everything chosen is the same as "all": new streams are then searched too.
    onChange(next.length === options.length ? undefined : next)
  }
  return (
    <Popover label="Streams" summary={streamsSummary(value, options.length)}>
      <Checkbox
        label="All streams"
        checked={value === undefined}
        onChange={(e) => onChange(e.target.checked ? undefined : [])}
        className="border-b border-line pb-2"
      />
      <ul className="mt-1 max-h-60 overflow-y-auto">
        {options.map((o) => (
          <li key={o.name}>
            <Checkbox
              className="items-center rounded px-1 py-1 hover:bg-hover"
              label={
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="truncate font-mono text-xs">{o.name}</span>
                  <span className="text-[11px] text-faint">{formatCount(o.messages)}</span>
                </span>
              }
              checked={value === undefined || value.includes(o.name)}
              onChange={(e) => toggle(o.name, e.target.checked)}
            />
          </li>
        ))}
        {options.length === 0 && <li className="px-1 py-1 text-faint">No streams</li>}
      </ul>
    </Popover>
  )
}
