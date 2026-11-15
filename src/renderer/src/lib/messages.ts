import type { ContentFilters, Header, MessageDto } from '@shared/api'
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

/** Short labels for the active filters, shown as removable chips. */
export function filterChips(
  subject: string,
  filters: ContentFilters
): { id: string; label: string }[] {
  const chips: { id: string; label: string }[] = []
  if (subject) chips.push({ id: 'subject', label: `Subject ${subject}` })
  ;(filters.headers ?? []).forEach((h, i) => {
    if (h.key.trim())
      chips.push({
        id: `header:${i}`,
        label: h.value ? `Header ${h.key} = ${h.value}` : `Has header ${h.key}`
      })
  })
  if (filters.payloadContains)
    chips.push({ id: 'contains', label: `Payload contains "${filters.payloadContains}"` })
  if (filters.payloadRegex)
    chips.push({ id: 'regex', label: `Payload matches /${filters.payloadRegex}/` })
  if (filters.jsonPath) chips.push({ id: 'jsonPath', label: `JSONPath ${filters.jsonPath}` })
  return chips
}

export function removeChip(
  id: string,
  subject: string,
  filters: ContentFilters
): { subject: string; filters: ContentFilters } {
  if (id === 'subject') return { subject: '', filters }
  if (id.startsWith('header:')) {
    const index = Number(id.slice(7))
    return {
      subject,
      filters: { ...filters, headers: (filters.headers ?? []).filter((_, i) => i !== index) }
    }
  }
  const next = { ...filters }
  if (id === 'contains') delete next.payloadContains
  if (id === 'regex') delete next.payloadRegex
  if (id === 'jsonPath') delete next.jsonPath
  return { subject, filters: next }
}
