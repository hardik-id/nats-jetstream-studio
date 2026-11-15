import { type ReactNode } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import type { Header } from '@shared/api'
import { formatBytes, formatTime } from '@shared/format'
import type { PayloadDecoder } from '../lib/decoders'
import { PayloadViewer } from './PayloadViewer'
import { Button, CopyButton, Kbd } from './ui'

export interface DetailMessage {
  subject: string
  /** Stream sequence; absent for live (core NATS) messages. */
  seq?: number
  /** ISO string or epoch ms. */
  time: string | number
  size: number
  headers: Header[]
  payload: string
  truncated: boolean
  reply?: string
}

export interface MessageDetailProps {
  message: DetailMessage
  decoders?: PayloadDecoder[]
  onClose: () => void
  onPrevious?: () => void
  onNext?: () => void
  onLoadFull?: () => void
  loadingFull?: boolean
  /** Extra buttons: delete, republish... */
  actions?: ReactNode
}

/** The side panel for one message: subject, sequence, time, headers and payload (PBI-043). */
export function MessageDetail({
  message,
  decoders,
  onClose,
  onPrevious,
  onNext,
  onLoadFull,
  loadingFull,
  actions
}: MessageDetailProps): ReactNode {
  const utc = new Date(message.time).toISOString()
  return (
    <aside
      aria-label="Message detail"
      className="flex h-full min-h-0 w-full flex-col border-l border-line bg-panel"
      onKeyDown={(e) => {
        // Alt+arrows step through messages without leaving the panel.
        if (e.altKey && e.key === 'ArrowUp' && onPrevious) {
          e.preventDefault()
          onPrevious()
        } else if (e.altKey && e.key === 'ArrowDown' && onNext) {
          e.preventDefault()
          onNext()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          onClose()
        }
      }}
    >
      <header className="flex shrink-0 items-center gap-1 border-b border-line px-3 py-1.5">
        <h3 className="mr-auto text-xs font-semibold tracking-wide text-muted uppercase">
          Message{message.seq !== undefined ? ` #${message.seq}` : ''}
        </h3>
        {actions}
        <Button
          size="sm"
          variant="ghost"
          disabled={!onPrevious}
          onClick={onPrevious}
          title="Previous message (Alt+Up)"
          aria-label="Previous message"
          icon={<ChevronUp className="h-4 w-4" aria-hidden />}
        />
        <Button
          size="sm"
          variant="ghost"
          disabled={!onNext}
          onClick={onNext}
          title="Next message (Alt+Down)"
          aria-label="Next message"
          icon={<ChevronDown className="h-4 w-4" aria-hidden />}
        />
        <Button
          size="sm"
          variant="ghost"
          onClick={onClose}
          title="Close (Esc)"
          aria-label="Close message detail"
          icon={<X className="h-4 w-4" aria-hidden />}
        />
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        <dl className="grid shrink-0 grid-cols-2 gap-x-4 gap-y-2">
          <Fact label="Subject" wide>
            <span className="flex min-w-0 items-center gap-1">
              <span className="truncate font-mono text-xs" title={message.subject}>
                {message.subject}
              </span>
              <CopyButton text={message.subject} label="Copy subject" />
            </span>
          </Fact>
          {message.seq !== undefined && (
            <Fact label="Sequence">
              <span className="tabular font-mono text-xs">{message.seq}</span>
            </Fact>
          )}
          <Fact label="Size">{formatBytes(message.size)}</Fact>
          <Fact label={message.seq !== undefined ? 'Stored' : 'Received'} wide>
            <span title={utc}>
              {formatTime(message.time)} <span className="text-faint">({utc} UTC)</span>
            </span>
          </Fact>
          {message.reply && (
            <Fact label="Reply to" wide>
              <span className="truncate font-mono text-xs">{message.reply}</span>
            </Fact>
          )}
        </dl>

        <section className="shrink-0">
          <div className="flex items-center justify-between pb-1">
            <h4 className="text-xs font-semibold text-muted">Headers ({message.headers.length})</h4>
            {message.headers.length > 0 && (
              <CopyButton
                text={() => message.headers.map(([k, v]) => `${k}: ${v}`).join('\n')}
                label="Copy headers"
              />
            )}
          </div>
          {message.headers.length === 0 ? (
            <p className="text-faint">No headers</p>
          ) : (
            <table className="w-full table-fixed border-collapse text-xs">
              <tbody>
                {message.headers.map(([key, value], i) => (
                  <tr key={i} className="border-t border-line first:border-t-0">
                    <th
                      scope="row"
                      className="w-2/5 py-1 pr-2 text-left align-top font-mono font-normal break-all text-muted"
                    >
                      {key}
                    </th>
                    <td className="py-1 font-mono break-all">{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="flex min-h-48 flex-1 flex-col">
          <h4 className="pb-1 text-xs font-semibold text-muted">Payload</h4>
          <PayloadViewer
            className="min-h-0 flex-1"
            payload={message.payload}
            size={message.size}
            truncated={message.truncated}
            subject={message.subject}
            decoders={decoders}
            onLoadFull={onLoadFull}
            loadingFull={loadingFull}
          />
        </section>
        {(onPrevious || onNext) && (
          <p className="shrink-0 text-xs text-faint">
            <Kbd>Alt</Kbd> + <Kbd>↑</Kbd> / <Kbd>↓</Kbd> moves between messages
          </p>
        )}
      </div>
    </aside>
  )
}

function Fact({
  label,
  wide,
  children
}: {
  label: string
  wide?: boolean
  children: ReactNode
}): ReactNode {
  return (
    <div className={wide ? 'col-span-2 min-w-0' : 'min-w-0'}>
      <dt className="text-[11px] text-faint uppercase">{label}</dt>
      <dd className="min-w-0 truncate">{children}</dd>
    </div>
  )
}
