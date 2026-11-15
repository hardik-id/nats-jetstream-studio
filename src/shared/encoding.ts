/** Base64 and text helpers that work in Node and in the browser. */

type BufferLike = {
  from(
    data: Uint8Array | string,
    encoding?: string
  ): { toString(encoding: string): string } & Uint8Array
}

const NodeBuffer: BufferLike | undefined = (globalThis as { Buffer?: BufferLike }).Buffer

export function toBase64(bytes: Uint8Array): string {
  if (NodeBuffer) return NodeBuffer.from(bytes).toString('base64')
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export function fromBase64(b64: string): Uint8Array {
  if (NodeBuffer) {
    const buf = NodeBuffer.from(b64, 'base64')
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  }
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

const encoder = new TextEncoder()
const strictDecoder = new TextDecoder('utf-8', { fatal: true })
const lenientDecoder = new TextDecoder('utf-8')

export function textToBase64(text: string): string {
  return toBase64(encoder.encode(text))
}

export function utf8Encode(text: string): Uint8Array {
  return encoder.encode(text)
}

/** Decodes UTF-8, replacing invalid bytes. */
export function utf8Decode(bytes: Uint8Array): string {
  return lenientDecoder.decode(bytes)
}

/** Returns the text when the bytes are valid UTF-8 without control characters, otherwise null. */
export function tryDecodeText(bytes: Uint8Array): string | null {
  let text: string
  try {
    text = strictDecoder.decode(bytes)
  } catch {
    return null
  }
  // Binary formats often decode as "valid" UTF-8 but are full of control characters.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) return null
  return text
}

export function toHexDump(bytes: Uint8Array, bytesPerLine = 16): string {
  const lines: string[] = []
  for (let offset = 0; offset < bytes.length; offset += bytesPerLine) {
    const slice = bytes.subarray(offset, offset + bytesPerLine)
    const hex = Array.from(slice, (b) => b.toString(16).padStart(2, '0'))
    const left = hex.slice(0, 8).join(' ')
    const right = hex.slice(8).join(' ')
    const ascii = Array.from(slice, (b) =>
      b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.'
    ).join('')
    lines.push(
      `${offset.toString(16).padStart(8, '0')}  ${left.padEnd(23)}  ${right.padEnd(23)}  |${ascii}|`
    )
  }
  return lines.join('\n')
}
