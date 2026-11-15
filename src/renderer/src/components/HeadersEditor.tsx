import type { ReactNode } from 'react'
import { Plus, X } from 'lucide-react'
import type { Header } from '@shared/api'
import { Button, Input } from './ui'

/** Edits message headers as rows of key and value. The same key may appear more than once. */
export function HeadersEditor({
  value,
  onChange,
  disabled
}: {
  value: Header[]
  onChange: (headers: Header[]) => void
  disabled?: boolean
}): ReactNode {
  const update = (index: number, part: 0 | 1, text: string): void =>
    onChange(
      value.map((h, i) =>
        i === index ? ((part === 0 ? [text, h[1]] : [h[0], text]) as Header) : h
      )
    )
  return (
    <div className="flex flex-col gap-1.5">
      {value.map(([key, val], i) => (
        <div key={i} className="flex gap-1.5">
          <Input
            mono
            className="w-2/5"
            aria-label={`Header ${i + 1} name`}
            placeholder="Header name"
            disabled={disabled}
            value={key}
            onChange={(e) => update(i, 0, e.target.value)}
          />
          <Input
            mono
            aria-label={`Header ${i + 1} value`}
            placeholder="Value"
            disabled={disabled}
            value={val}
            onChange={(e) => update(i, 1, e.target.value)}
          />
          <Button
            variant="ghost"
            aria-label={`Remove header ${i + 1}`}
            disabled={disabled}
            icon={<X className="h-4 w-4" aria-hidden />}
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          />
        </div>
      ))}
      <div>
        <Button
          size="sm"
          disabled={disabled}
          icon={<Plus className="h-3.5 w-3.5" aria-hidden />}
          onClick={() => onChange([...value, ['', '']])}
        >
          Add header
        </Button>
      </div>
    </div>
  )
}
