import type { ReactNode } from 'react'
import { Checkbox, Select } from '../../components/ui'
import type { ViewControl as Control } from './views/types'

/**
 * One control a view declares, drawn generically: a select or a toggle. The toolbar renders the
 * controls of the active view and knows nothing about what they mean.
 */
export function ViewControl({
  control,
  value,
  disabled,
  onChange
}: {
  control: Control
  value: string | boolean | undefined
  disabled?: boolean
  onChange: (value: string | boolean) => void
}): ReactNode {
  if (control.kind === 'toggle')
    return (
      <Checkbox
        label={control.label}
        hint={control.hint}
        checked={value === true}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    )
  return (
    <label className="flex items-center gap-1.5 text-xs text-faint">
      {control.label}
      <Select
        compact
        className="w-32"
        value={typeof value === 'string' ? value : control.default}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {control.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    </label>
  )
}
