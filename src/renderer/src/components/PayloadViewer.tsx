import { useMemo, useState, type ReactNode } from 'react'
import { fromBase64, toHexDump, tryDecodeText, utf8Decode } from '@shared/encoding'
import { formatBytes } from '@shared/format'
import type { PayloadDecoder } from '../lib/decoders'
import { JsonView } from './JsonView'
import { Button, CopyButton, cx, Notice } from './ui'

type View = 'decoded' | 'json' | 'text' | 'hex' | 'base64'
const HEX_LIMIT = 64 * 1024

export interface PayloadViewerProps {
  /** Base64. */
  payload: string
  /** Full size in bytes; larger than the payload when it is truncated. */
  size: number
  truncated?: boolean
  subject?: string
  decoders?: PayloadDecoder[]
  onLoadFull?: () => void
  loadingFull?: boolean
  className?: string
}

/**
 * Shows a payload as JSON, text, hex or base64 (PBI-043). The format is detected, and the user
 * can switch. A registered decoder (Protobuf) adds a decoded view and becomes the default.
 */
export function PayloadViewer({
  payload,
  size,
  truncated,
  subject,
  decoders,
  onLoadFull,
  loadingFull,
  className
}: PayloadViewerProps): ReactNode {
  const parsed = useMemo(() => {
    const bytes = fromBase64(payload)
    const text = tryDecodeText(bytes)
    let json: unknown
    let isJson = false
    if (text !== null && /^\s*[[{"\-0-9tfn]/.test(text)) {
      try {
        json = JSON.parse(text)
        isJson = typeof json === 'object' && json !== null
      } catch {
        // Not JSON.
      }
    }
    let decoded: { label: string; value?: unknown; error?: string } | undefined
    const decoder = subject ? decoders?.find((d) => d.matches(subject)) : undefined
    if (decoder) {
      try {
        decoded = { label: decoder.label, value: decoder.decode(bytes) }
      } catch (err) {
        decoded = { label: decoder.label, error: (err as Error).message }
      }
    }
    return { bytes, text, json, isJson, decoded }
  }, [payload, subject, decoders])

  const detected: View =
    parsed.decoded && !parsed.decoded.error
      ? 'decoded'
      : parsed.isJson
        ? 'json'
        : parsed.text !== null
          ? 'text'
          : 'hex'
  const [chosen, setChosen] = useState<View | null>(null)
  const available: View[] = [
    ...(parsed.decoded ? (['decoded'] as View[]) : []),
    ...(parsed.isJson ? (['json'] as View[]) : []),
    'text',
    'hex',
    'base64'
  ]
  const view = chosen && available.includes(chosen) ? chosen : detected

  const copyText = (): string => {
    switch (view) {
      case 'decoded':
        return JSON.stringify(parsed.decoded?.value, null, 2)
      case 'json':
        return JSON.stringify(parsed.json, null, 2)
      case 'text':
        return parsed.text ?? utf8Decode(parsed.bytes)
      case 'hex':
        return toHexDump(parsed.bytes)
      case 'base64':
        return payload
    }
  }

  const labels: Record<View, string> = {
    decoded: parsed.decoded?.label ?? 'Decoded',
    json: 'JSON',
    text: 'Text',
    hex: 'Hex',
    base64: 'Base64'
  }

  return (
    <div className={cx('flex min-h-0 flex-col', className)}>
      <div className="flex shrink-0 items-center gap-1 pb-1.5">
        <div
          role="tablist"
          aria-label="Payload format"
          className="flex gap-0.5 rounded-md bg-raised p-0.5"
        >
          {available.map((v) => (
            <button
              key={v}
              role="tab"
              aria-selected={v === view}
              onClick={() => setChosen(v)}
              className={cx(
                'rounded px-2 py-0.5 text-xs font-medium',
                v === view ? 'bg-panel text-fg shadow-sm' : 'text-muted hover:text-fg'
              )}
            >
              {labels[v]}
            </button>
          ))}
        </div>
        <span className="ml-auto text-xs text-faint">{formatBytes(size)}</span>
        <CopyButton text={copyText} label="Copy payload" />
      </div>

      {truncated && (
        <Notice
          tone="warn"
          className="mb-1.5 flex shrink-0 items-center justify-between gap-2 text-xs"
        >
          <span>
            Showing the first {formatBytes(parsed.bytes.length)} of {formatBytes(size)}.
          </span>
          {onLoadFull && (
            <Button size="sm" busy={loadingFull} onClick={onLoadFull}>
              Load full payload
            </Button>
          )}
        </Notice>
      )}
      {parsed.decoded?.error && view === 'decoded' && (
        <Notice tone="danger" className="mb-1.5 shrink-0 text-xs">
          {parsed.decoded.label} could not decode this payload: {parsed.decoded.error}. Showing hex
          instead.
        </Notice>
      )}

      <div
        className="min-h-0 flex-1 overflow-auto rounded-md border border-line bg-code p-2"
        data-testid="payload-body"
      >
        {size === 0 ? (
          <span className="text-faint">Empty payload</span>
        ) : view === 'decoded' && !parsed.decoded?.error ? (
          <JsonView value={parsed.decoded?.value} expandDepth={3} />
        ) : view === 'json' ? (
          <JsonView value={parsed.json} expandDepth={3} />
        ) : view === 'text' ? (
          <pre className="font-mono text-xs leading-5 break-all whitespace-pre-wrap">
            {parsed.text ?? utf8Decode(parsed.bytes)}
          </pre>
        ) : view === 'base64' ? (
          <pre className="font-mono text-xs leading-5 break-all whitespace-pre-wrap">{payload}</pre>
        ) : (
          <>
            <pre className="font-mono text-xs leading-5">
              {toHexDump(parsed.bytes.subarray(0, HEX_LIMIT))}
            </pre>
            {parsed.bytes.length > HEX_LIMIT && (
              <p className="pt-1 text-xs text-faint">
                Hex view stops at {formatBytes(HEX_LIMIT)}. Copy or export the message for the rest.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
