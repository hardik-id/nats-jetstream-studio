import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react'
import {
  ChevronDown,
  ChevronUp,
  Maximize2,
  Minimize2,
  PanelRightClose,
  PanelRightOpen,
  X
} from 'lucide-react'
import type { FilterCondition, Header } from '@shared/api'
import { formatBytes, formatTime } from '@shared/format'
import type { PayloadDecoder } from '../lib/decoders'
import { useSetting } from '../lib/hooks'
import { DetailSectionsContext, normalizeSections, type DetailSectionId } from './detailSections'
import { FilterButton } from './JsonView'
import { PayloadViewer } from './PayloadViewer'
import { Button, CollapsibleSection, CopyButton, cx } from './ui'

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
  /**
   * Adds a filter condition from this message (PBI-126): buttons on the headers and on the JSON
   * tree's values. Absent (Live tail): no buttons.
   */
  onFilter?: (condition: FilterCondition) => void
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
  sections,
  onFilter
}: MessageDetailProps): ReactNode {
  const utc = new Date(message.time).toISOString()
  const [stored, setStored, storedLoaded, storedError] = useSetting<unknown>(
    'messages.detailSections',
    null
  )
  const sections_ = useMemo(() => normalizeSections(stored), [stored])
  // Two quick clicks must both count, so a toggle starts from the value the last one wrote, not
  // from what has been stored by now. Nothing is written before the stored value has been read
  // (it would replace the other sections' choices with defaults).
  const latest = useRef(sections_)
  useEffect(() => {
    latest.current = sections_
  }, [sections_])
  const ready = storedLoaded || storedError !== null
  const toggle = useCallback(
    (id: DetailSectionId) => {
      if (!ready) return
      const next = { ...latest.current, [id]: !latest.current[id] }
      latest.current = next
      void setStored(next)
    },
    [ready, setStored]
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
            if (expanded && onToggleExpanded) {
              onToggleExpanded()
              // Focus was somewhere in the panel; keep it on the button that toggles the size.
              e.currentTarget.querySelector<HTMLElement>('[data-expand-toggle]')?.focus()
            } else onClose()
          }
        }}
      >
        <header className="flex shrink-0 items-center gap-1 border-b border-line px-3 py-1.5 [@media(max-height:800px)]:py-0.5">
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
              data-expand-toggle=""
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

        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3 py-1.5">
          <div
            className={cx(
              'flex flex-col gap-1 overflow-y-auto',
              sections_.payload
                ? sections_.consumers
                  ? // An open Consumers list needs room for a few rows; the area scrolls as a whole.
                    'max-h-[68%] min-h-[13rem] shrink-0'
                  : 'max-h-[25%] shrink-0 [@media(max-height:800px)]:max-h-[max(25%,6.5rem)]'
                : 'min-h-0 flex-1'
            )}
          >
            <CollapsibleSection
              title="Details"
              summary={`${message.seq !== undefined ? `#${message.seq} · ` : ''}${formatBytes(message.size)}`}
              open={details.open}
              onToggle={details.toggle}
            >
              <dl className="flex flex-col gap-0.5 [@media(max-height:800px)]:flex-row [@media(max-height:800px)]:flex-wrap [@media(max-height:800px)]:items-baseline [@media(max-height:800px)]:gap-x-3">
                <Fact label="Subject">
                  <span className="flex min-w-0 items-center gap-1">
                    <span className="truncate font-mono text-xs" title={message.subject}>
                      {message.subject}
                    </span>
                    <CopyButton text={message.subject} label="Copy subject" />
                    {onFilter && (
                      <>
                        <FilterButton
                          exclude={false}
                          text=""
                          label={`Filter to subject ${message.subject}`}
                          onClick={() => onFilter({ kind: 'subject', expr: message.subject })}
                        />
                        <FilterButton
                          exclude
                          text=""
                          label={`Exclude subject ${message.subject}`}
                          onClick={() =>
                            onFilter({ kind: 'subject', expr: message.subject, exclude: true })
                          }
                        />
                      </>
                    )}
                  </span>
                </Fact>
                <div className="flex flex-wrap items-baseline gap-x-4 [@media(max-height:800px)]:contents">
                  {message.seq !== undefined && (
                    // The title says it; the one-line layout of a short window drops it (size: Payload says it).
                    <div className="contents [@media(max-height:800px)]:hidden">
                      <Fact label="Sequence" inline>
                        <span className="tabular font-mono text-xs">{message.seq}</span>
                      </Fact>
                    </div>
                  )}
                  <div className="contents [@media(max-height:800px)]:hidden">
                    <Fact label="Size" inline>
                      {formatBytes(message.size)}
                    </Fact>
                  </div>
                  <Fact label={message.seq !== undefined ? 'Stored' : 'Received'} inline>
                    <span title={utc}>
                      {formatTime(message.time)}{' '}
                      <span className="text-faint [@media(max-height:800px)]:hidden">
                        ({utc} UTC)
                      </span>
                    </span>
                  </Fact>
                </div>
                {message.reply && (
                  <Fact label="Reply to">
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
                      <tr key={i} className="group border-t border-line first:border-t-0">
                        <th
                          scope="row"
                          className="w-2/5 py-1 pr-2 text-left align-top font-mono font-normal break-all text-muted"
                        >
                          {key}
                        </th>
                        <td className="py-1 font-mono break-all">{value}</td>
                        {onFilter && (
                          <td className="w-14 py-1 pl-1 text-right align-top whitespace-nowrap">
                            <span className="inline-flex gap-1 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                              <FilterButton
                                exclude={false}
                                text=""
                                label={`Include header ${key} = ${value}`}
                                onClick={() => onFilter({ kind: 'header', key, value })}
                              />
                              <FilterButton
                                exclude
                                text=""
                                label={`Exclude header ${key} = ${value}`}
                                onClick={() =>
                                  onFilter({ kind: 'header', key, value, exclude: true })
                                }
                              />
                            </span>
                          </td>
                        )}
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
              onFilter={onFilter}
            />
          </CollapsibleSection>
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
  inline,
  children
}: {
  label: string
  /** Label and value side by side, sized to their content (several can share a row). */
  inline?: boolean
  children: ReactNode
}): ReactNode {
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <dt className={cx('shrink-0 text-[11px] text-faint uppercase', !inline && 'w-[4.5rem]')}>
        {label}
      </dt>
      <dd className={cx('min-w-0', inline ? '' : 'flex-1 truncate')}>{children}</dd>
    </div>
  )
}
