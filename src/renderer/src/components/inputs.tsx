import { useState, type ReactNode } from 'react'
import { formatDuration, parseDuration } from '@shared/duration'
import { bytesToInput, parseBytes } from '@shared/format'
import { Button, cx, Field, Input, TextArea } from './ui'

interface LimitProps {
  label: string
  /** NATS uses -1 (or 0) for "no limit". */
  value: number | undefined
  onChange: (value: number) => void
  disabled?: boolean
  hint?: string
  /** What an empty field means; defaults to "unlimited". */
  emptyLabel?: string
  emptyValue?: number
}

/** A text field for a parsed value. Keeps what the user typed while it is invalid. */
function ParsedField({
  label,
  value,
  onChange,
  disabled,
  hint,
  emptyLabel = 'unlimited',
  emptyValue = -1,
  parse,
  format,
  invalidMessage
}: LimitProps & {
  parse: (text: string) => number | null
  format: (value: number) => string
  invalidMessage: string
}): ReactNode {
  const isEmpty = value === undefined || value <= 0
  const [text, setText] = useState(isEmpty ? '' : format(value))
  const [error, setError] = useState<string | null>(null)

  // Follow outside changes (switching from the JSON view), but not the echo of our own edit.
  // Done while rendering, which React handles without an extra paint, rather than in an effect.
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    setSeen(value)
    const current = text.trim() === '' ? emptyValue : parse(text)
    const incoming = isEmpty ? emptyValue : value
    if (current !== incoming) {
      setText(isEmpty ? '' : format(value))
      setError(null)
    }
  }

  return (
    <Field label={label} hint={hint} error={error}>
      {(id) => (
        <Input
          id={id}
          placeholder={emptyLabel}
          disabled={disabled}
          invalid={!!error}
          value={text}
          onChange={(e) => {
            const next = e.target.value
            setText(next)
            if (next.trim() === '') {
              setError(null)
              onChange(emptyValue)
              return
            }
            const parsed = parse(next)
            if (parsed === null) setError(invalidMessage)
            else {
              setError(null)
              onChange(parsed)
            }
          }}
        />
      )}
    </Field>
  )
}

export function CountField(props: LimitProps): ReactNode {
  return (
    <ParsedField
      {...props}
      parse={(t) => (/^\d+$/.test(t.trim()) ? Number(t.trim()) : null)}
      format={String}
      invalidMessage="Enter a whole number, or leave empty"
    />
  )
}

export function BytesField(props: LimitProps): ReactNode {
  return (
    <ParsedField
      {...props}
      parse={parseBytes}
      format={bytesToInput}
      invalidMessage="Enter a size such as 512, 10MB or 1GiB"
      hint={props.hint ?? 'For example 10MB or 1GiB'}
    />
  )
}

export function DurationField(props: LimitProps): ReactNode {
  return (
    <ParsedField
      {...props}
      emptyValue={props.emptyValue ?? 0}
      parse={(t) => parseDuration(t)}
      format={formatDuration}
      invalidMessage="Enter a duration such as 30s, 5m, 1h30m or 7d"
      hint={props.hint ?? 'For example 30s, 5m, 1h30m or 7d'}
    />
  )
}

/** A list of strings edited one per line. */
export function LinesField({
  label,
  value,
  onChange,
  hint,
  error,
  disabled,
  rows = 3,
  placeholder
}: {
  label: string
  value: string[]
  onChange: (v: string[]) => void
  hint?: string
  error?: string | null
  disabled?: boolean
  rows?: number
  placeholder?: string
}): ReactNode {
  const [text, setText] = useState(value.join('\n'))
  const joined = value.join('\n')
  const [seen, setSeen] = useState(joined)
  if (seen !== joined) {
    setSeen(joined)
    const current = text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join('\n')
    if (current !== joined) setText(joined)
  }
  return (
    <Field label={label} hint={hint} error={error}>
      {(id) => (
        <TextArea
          id={id}
          rows={rows}
          disabled={disabled}
          invalid={!!error}
          placeholder={placeholder}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            onChange(
              e.target.value
                .split('\n')
                .map((s) => s.trim())
                .filter(Boolean)
            )
          }}
        />
      )}
    </Field>
  )
}

/**
 * Edits a configuration object either through a form or as raw JSON. Both views edit the same
 * object, so switching between them never loses a change.
 */
export function ConfigEditor<T extends object>({
  value,
  onChange,
  onValidity,
  children
}: {
  value: T
  onChange: (value: T) => void
  /** Reports whether the JSON view currently holds valid JSON. */
  onValidity?: (valid: boolean) => void
  children: ReactNode
}): ReactNode {
  const [mode, setMode] = useState<'form' | 'json'>('form')
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)

  const toJson = (): void => {
    setText(JSON.stringify(value, null, 2))
    setError(null)
    setMode('json')
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <div
          role="tablist"
          aria-label="Editor view"
          className="flex gap-0.5 rounded-md bg-raised p-0.5"
        >
          {(['form', 'json'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              disabled={m === 'form' && !!error}
              title={m === 'form' && error ? 'Fix the JSON first' : undefined}
              onClick={() => (m === 'json' ? toJson() : setMode('form'))}
              className={cx(
                'rounded px-2.5 py-0.5 text-xs font-medium disabled:opacity-50',
                mode === m ? 'bg-panel text-fg shadow-sm' : 'text-muted hover:text-fg'
              )}
            >
              {m === 'form' ? 'Form' : 'JSON'}
            </button>
          ))}
        </div>
        {mode === 'json' && (
          <Button size="sm" variant="ghost" onClick={() => setText(JSON.stringify(value, null, 2))}>
            Format
          </Button>
        )}
      </div>
      {mode === 'form' ? (
        children
      ) : (
        <Field label="Configuration as JSON" error={error}>
          {(id) => (
            <TextArea
              id={id}
              rows={22}
              invalid={!!error}
              value={text}
              onChange={(e) => {
                setText(e.target.value)
                try {
                  const parsed = JSON.parse(e.target.value)
                  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
                    throw new Error('Expected a JSON object')
                  setError(null)
                  onValidity?.(true)
                  onChange(parsed as T)
                } catch (err) {
                  setError((err as Error).message)
                  onValidity?.(false)
                }
              }}
            />
          )}
        </Field>
      )}
    </div>
  )
}
