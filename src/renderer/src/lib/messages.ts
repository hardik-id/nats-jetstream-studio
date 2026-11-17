import type { ContentFilters, Header, MessageDto } from '@shared/api'
import {
  canonicalFilters,
  describeCondition,
  normalizeFilters,
  removeCondition
} from '@shared/filters'
import { fromBase64, tryDecodeText } from '@shared/encoding'

/** One line of text for the list: the start of a text payload, or a note for binary data. */
export function payloadPreview(payload: string, size: number, max = 240): string {
  if (size === 0) return ''
  const bytes = fromBase64(payload)
  const text = tryDecodeText(bytes.subarray(0, Math.min(bytes.length, max * 4)))
  // A multi-byte character cut in half at the end is still text.
  const usable =
    text ?? tryDecodeText(bytes.subarray(0, Math.max(0, Math.min(bytes.length, max * 4) - 3)))
  if (usable === null) return `(binary, ${size} bytes)`
  return usable.replace(/\s+/g, ' ').slice(0, max)
}

export interface ExportedMessage {
  seq?: number
  subject: string
  time: string
  headers: Header[]
  /** The payload as text, or base64 when it is not valid UTF-8. */
  payload: string
  encoding: 'utf8' | 'base64'
}

export function toExported(
  m: Pick<MessageDto, 'subject' | 'time' | 'headers' | 'payload'> & { seq?: number }
): ExportedMessage {
  const text = tryDecodeText(fromBase64(m.payload))
  return {
    seq: m.seq,
    subject: m.subject,
    time: m.time,
    headers: m.headers,
    payload: text ?? m.payload,
    encoding: text === null ? 'base64' : 'utf8'
  }
}

export function serializeExport(messages: ExportedMessage[], format: 'json' | 'ndjson'): string {
  if (format === 'ndjson')
    return messages.map((m) => JSON.stringify(m)).join('\n') + (messages.length ? '\n' : '')
  return JSON.stringify(messages, null, 2) + '\n'
}

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/** A `nats pub` command that republishes this message, or null when the payload is binary. */
export function natsPubCommand(
  m: Pick<MessageDto, 'subject' | 'headers' | 'payload'>
): string | null {
  const text = tryDecodeText(fromBase64(m.payload))
  if (text === null) return null
  const headers = m.headers.map(([k, v]) => ` -H ${shellQuote(`${k}:${v}`)}`).join('')
  return `nats pub${headers} ${shellQuote(m.subject)} ${shellQuote(text)}`
}

export interface SavedFilter {
  name: string
  subject: string
  filters: ContentFilters
}

/** The longest name a saved filter can have, when it is saved and when it is imported. */
export const MAX_SAVED_FILTER_NAME = 120
/** How many saved filters one connection can have. An import that would go beyond it is refused. */
export const MAX_SAVED_FILTERS = 500

export interface FilterChip {
  /** `subject`, or `c:<n>` for the condition at position n. */
  id: string
  label: string
  /** An exclude condition: shown with "not", and it can be turned around. */
  exclude?: boolean
  /** The position of a condition in `normalizeFilters`; absent for the subject chip. */
  index?: number
}

/** Short labels for the active filters, shown as removable chips: one per condition. */
export function filterChips(subject: string, filters: ContentFilters): FilterChip[] {
  const chips: FilterChip[] = []
  if (subject) chips.push({ id: 'subject', label: `Subject ${subject}` })
  normalizeFilters(filters).forEach((c, index) => {
    chips.push({
      id: `c:${index}`,
      label: describeCondition(c),
      exclude: c.exclude === true,
      index
    })
  })
  return chips
}

export function removeChip(
  id: string,
  subject: string,
  filters: ContentFilters
): { subject: string; filters: ContentFilters } {
  if (id === 'subject') return { subject: '', filters: canonicalFilters(filters) }
  return { subject, filters: removeCondition(filters, Number(id.slice(2))) }
}
