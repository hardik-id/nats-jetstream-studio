import { useCallback, useMemo, type ReactNode } from 'react'
import {
  ChevronDown,
  ChevronUp,
  Maximize2,
  Minimize2,
  PanelRightClose,
  PanelRightOpen,
  X
} from 'lucide-react'
import type { Header } from '@shared/api'
import { formatBytes, formatTime } from '@shared/format'
import type { PayloadDecoder } from '../lib/decoders'
import { useSetting } from '../lib/hooks'
import { DetailSectionsContext, normalizeSections, type DetailSectionId } from './detailSections'
import { PayloadViewer } from './PayloadViewer'
import { Button, CollapsibleSection, CopyButton, cx, Kbd } from './ui'

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
  /** Shrinks the panel to a rail. The message stays selected. */
  onCollapse?: () => void
  /** True while the panel is widened for reading. */
  expanded?: boolean
  onToggleExpanded?: () => void
  onPrevious?: () => void
  onNext?: () => void
  onLoadFull?: () => void
  loadingFull?: boolean
  /** Extra buttons: delete, republish... */
  actions?: ReactNode
  /** Extra sections shown between the headers and the payload (stream messages only). */
  sections?: ReactNode
}

/** The side panel for one message: subject, sequence, time, headers and payload (PBI-043). */
export function MessageDetail({
  message,
  decoders,
  onClose,
  onCollapse,
  expanded,
  onToggleExpanded,
  onPrevious,
  onNext,
  onLoadFull,
  loadingFull,
  actions,
  sections
}: MessageDetailProps): ReactNode {
  const utc = new Date(message.time).toISOString()
  const [stored, setStored] = useSetting<unknown>('messages.detailSections', null)
  const sections_ = useMemo(() => normalizeSections(stored), [stored])
  const toggle = useCallback(
    (id: DetailSectionId) => void setStored({ ...sections_, [id]: !sections_[id] }),
    [sections_, setStored]
  )
  const ctx = useMemo(() => ({ sections: sections_, toggle }), [sections_, toggle])
  const details = { open: sections_.details, toggle: () => toggle('details') }
  const headers = { open: sections_.headers, toggle: () => toggle('headers') }
  const payload = { open: sections_.payload, toggle: () => toggle('payload') }
  return (
    <DetailSectionsContext.Provider value={ctx}>
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
            // A widened panel goes back to its size first; a second Escape closes it.
            if (expanded && onToggleExpanded) onToggleExpanded()
            else onClose()
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
          {onToggleExpanded && (
            <Button
              size="sm"
              variant="ghost"
              onClick={onToggleExpanded}
              title={expanded ? 'Restore panel size (Esc)' : 'Expand to read'}
              aria-label={expanded ? 'Restore panel size' : 'Expand to read'}
              icon={
                expanded ? (
                  <Minimize2 className="h-4 w-4" aria-hidden />
                ) : (
                  <Maximize2 className="h-4 w-4" aria-hidden />
                )
              }
            />
          )}
          {onCollapse && (
            <Button
              size="sm"
              variant="ghost"
              onClick={onCollapse}
              title="Collapse panel to a rail"
              aria-label="Collapse panel"
              icon={<PanelRightClose className="h-4 w-4" aria-hidden />}
            />
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close message detail"
            icon={<X className="h-4 w-4" aria-hidden />}
          />
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
          <div
            className={cx(
              'flex flex-col gap-1 overflow-y-auto',
              payload.open ? 'max-h-[45%] shrink-0' : 'min-h-0 flex-1'
            )}
          >
            <CollapsibleSection
              title="Details"
              summary={`${message.seq !== undefined ? `#${message.seq} · ` : ''}${formatBytes(message.size)}`}
              open={details.open}
              onToggle={details.toggle}
            >
              <dl className="grid grid-cols-4 gap-x-4 gap-y-2">
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
                <Fact label={message.seq !== undefined ? 'Stored' : 'Received'} half>
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
            </CollapsibleSection>

            <CollapsibleSection
              title={`Headers (${message.headers.length})`}
              summary={message.headers.map(([k]) => k).join(', ')}
              open={headers.open}
              onToggle={headers.toggle}
              actions={
                message.headers.length > 0 ? (
                  <CopyButton
                    text={() => message.headers.map(([k, v]) => `${k}: ${v}`).join('\n')}
                    label="Copy headers"
                  />
                ) : undefined
              }
            >
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
            </CollapsibleSection>

            {sections}
          </div>

          <CollapsibleSection
            title="Payload"
            summary={formatBytes(message.size)}
            actions={<span className="text-xs text-faint">{formatBytes(message.size)}</span>}
            open={payload.open}
            onToggle={payload.toggle}
            grow
            className="min-h-32"
          >
            <PayloadViewer
              className="min-h-0 flex-1"
              showSize={false}
              payload={message.payload}
              size={message.size}
              truncated={message.truncated}
              subject={message.subject}
              decoders={decoders}
              onLoadFull={onLoadFull}
              loadingFull={loadingFull}
            />
          </CollapsibleSection>
          {(onPrevious || onNext) && (
            <p className="shrink-0 text-xs text-faint">
              <Kbd>Alt</Kbd> + <Kbd>↑</Kbd> / <Kbd>↓</Kbd> moves between messages
            </p>
          )}
        </div>
      </aside>
    </DetailSectionsContext.Provider>
  )
}

/** What is left of a collapsed detail panel: a thin rail that keeps the selection visible. */
export function DetailRail({
  label,
  onExpand
}: {
  label: string
  onExpand: () => void
}): ReactNode {
  return (
    <aside
      aria-label="Message detail (collapsed)"
      className="flex h-full w-full flex-col items-center gap-2 border-l border-line bg-panel py-2"
    >
      <Button
        size="sm"
        variant="ghost"
        onClick={onExpand}
        title="Expand message panel"
        aria-label="Expand message panel"
        icon={<PanelRightOpen className="h-4 w-4" aria-hidden />}
      />
      <span
        className="text-xs font-medium whitespace-nowrap text-muted [text-orientation:mixed] [writing-mode:vertical-rl]"
        data-testid="detail-rail-label"
      >
        {label}
      </span>
    </aside>
  )
}

function Fact({
  label,
  wide,
  half,
  children
}: {
  label: string
  /** The whole row of the four-column grid. */
  wide?: boolean
  /** Half the row; the value may wrap onto a second line. */
  half?: boolean
  children: ReactNode
}): ReactNode {
  return (
    <div className={wide ? 'col-span-4 min-w-0' : half ? 'col-span-2 min-w-0' : 'min-w-0'}>
      <dt className="text-[11px] text-faint uppercase">{label}</dt>
      <dd className={half ? 'min-w-0' : 'min-w-0 truncate'}>{children}</dd>
    </div>
  )
}
