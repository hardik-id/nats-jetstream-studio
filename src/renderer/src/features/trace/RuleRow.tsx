import { type ReactNode } from 'react'
import { X } from 'lucide-react'
import type { TraceRule } from '@shared/trace'
import { Button, Input, Select } from '../../components/ui'

type RuleKind = TraceRule['kind']

const KINDS: { kind: RuleKind; label: string }[] = [
  { kind: 'header', label: 'Header' },
  { kind: 'json', label: 'JSON field' },
  { kind: 'text', label: 'Text anywhere' }
]

/** A rule of another kind that keeps what has been typed: the value carries over. */
export function changeKind(rule: TraceRule, kind: RuleKind): TraceRule {
  if (rule.kind === kind) return rule
  const value = rule.kind === 'header' && !rule.value ? '' : rule.value
  if (kind === 'header') return { kind, key: '', value }
  if (kind === 'json') return { kind, path: '', value }
  return { kind, value }
}

/** One match rule: its type, what to look at (header name or JSON path) and the value. */
export function RuleRow({
  rule,
  index,
  onChange,
  onRemove
}: {
  rule: TraceRule
  index: number
  onChange: (rule: TraceRule) => void
  /** Absent when this is the only rule. */
  onRemove?: () => void
}): ReactNode {
  const n = index + 1
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        compact
        className="w-36"
        aria-label={`Match type ${n}`}
        value={rule.kind}
        onChange={(e) => onChange(changeKind(rule, e.target.value as RuleKind))}
      >
        {KINDS.map((k) => (
          <option key={k.kind} value={k.kind}>
            {k.label}
          </option>
        ))}
      </Select>
      {rule.kind === 'header' && (
        <Input
          compact
          mono
          className="w-40"
          aria-label={`Header name ${n}`}
          placeholder="trace-id"
          value={rule.key}
          onChange={(e) => onChange({ ...rule, key: e.target.value })}
        />
      )}
      {rule.kind === 'json' && (
        <Input
          compact
          mono
          className="w-52"
          aria-label={`JSON path ${n}`}
          placeholder="$.order.id"
          value={rule.path}
          onChange={(e) => onChange({ ...rule, path: e.target.value })}
        />
      )}
      {rule.kind !== 'text' && (
        <span className="text-muted" aria-hidden>
          {rule.kind === 'json' && rule.inArray ? 'contains' : '='}
        </span>
      )}
      <Input
        compact
        mono
        className="w-56"
        aria-label={rule.kind === 'text' ? `Text ${n}` : `Value ${n}`}
        placeholder={rule.kind === 'text' ? 'text to find in the payload' : 'value to follow'}
        value={rule.value}
        onChange={(e) => {
          // Typing a value turns a number or true/false that was picked from a message into text.
          const next = { ...rule, value: e.target.value }
          if (next.kind === 'json') delete next.literal
          onChange(next)
        }}
      />
      {onRemove && (
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Remove match ${n}`}
          title="Remove this match"
          icon={<X className="h-3.5 w-3.5" aria-hidden />}
          onClick={onRemove}
        />
      )}
    </div>
  )
}
