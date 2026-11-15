import { headers as natsHeaders, type MsgHdrs } from '@nats-io/nats-core'
import type { StoredMsg } from '@nats-io/jetstream'
import type { Header, MessageDto } from '@shared/api'
import { fromBase64, toBase64 } from '@shared/encoding'

export const PREVIEW_BYTES = 2048

export function headersToList(hdrs: MsgHdrs | undefined): Header[] {
  const out: Header[] = []
  if (!hdrs) return out
  for (const [key, values] of hdrs) {
    for (const value of values) out.push([key, value])
  }
  return out
}

export function listToHeaders(list: Header[] | undefined): MsgHdrs | undefined {
  const usable = (list ?? []).filter(([key]) => key.trim() !== '')
  if (usable.length === 0) return undefined
  const hdrs = natsHeaders()
  for (const [key, value] of usable) hdrs.append(key.trim(), value)
  return hdrs
}

export function truncatedBase64(
  data: Uint8Array,
  maxBytes: number
): { payload: string; truncated: boolean } {
  if (data.length <= maxBytes) return { payload: toBase64(data), truncated: false }
  return { payload: toBase64(data.subarray(0, maxBytes)), truncated: true }
}

/**
 * Headers the server adds to a direct-get reply to describe the message. They are not part of the
 * stored message, so they must not be shown, filtered on or republished.
 */
const DIRECT_GET_HEADERS = new Set([
  'nats-stream',
  'nats-subject',
  'nats-sequence',
  'nats-time-stamp',
  'nats-last-sequence',
  'nats-num-pending',
  'nats-upto-sequence'
])

/**
 * The headers of a stored message. For a message read with direct get, the reply's own headers
 * are removed. The server appends them after the stored ones, so when a stored message happens
 * to carry a header of the same name (a republished message does), only the last value goes.
 */
export function storedHeaders(msg: StoredMsg, direct: boolean): Header[] {
  const out: Header[] = []
  if (!msg.header) return out
  for (const [key, values] of msg.header) {
    const kept = direct && DIRECT_GET_HEADERS.has(key.toLowerCase()) ? values.slice(0, -1) : values
    for (const value of kept) out.push([key, value])
  }
  return out
}

export function storedToDto(
  msg: StoredMsg,
  payloadBytes = PREVIEW_BYTES,
  direct = false
): MessageDto {
  return {
    seq: msg.seq,
    subject: msg.subject,
    time: msg.time.toISOString(),
    size: msg.data.length,
    headers: storedHeaders(msg, direct),
    ...truncatedBase64(msg.data, payloadBytes)
  }
}

export function decodePayload(b64: string): Uint8Array {
  return b64 ? fromBase64(b64) : new Uint8Array(0)
}
