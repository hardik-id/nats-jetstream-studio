import { useId, useState, type ReactNode } from 'react'
import { ChevronDown, Database, PanelRightClose, Radio, Send } from 'lucide-react'
import { formatCount } from '@shared/format'
import { Badge, Button, CollapsibleSection, CopyButton, Facts, Menu } from '../../components/ui'
import { useTabs } from '../../state/tabs'
import {
  describeActions,
  resolveScope,
  runBrowse,
  runPublish,
  runTail,
  scopeStreams,
  type ActionDescriptor
} from './subjectActions'
import {
  availableScopes,
  scopeLabel,
  type StreamPatterns,
  type SubjectInfo,
  type SubjectScope
} from './subjectTree'

export interface SubjectDetailProps {
  connId: string
  /** The selected node (a `SubjectTreeNode` fits); null shows the hint. */
  node: SubjectInfo | null
  /** Subject patterns of the streams on the Subjects screen (KV and Object Store left out). */
  streams: readonly StreamPatterns[]
  /** The connection is read-only: Publish is disabled with the reason. */
  readOnly?: boolean
  /** Shows a button that collapses the pane to its rail (the layout belongs to the screen). */
  onCollapse?: () => void
}

const REASON = 'text-xs text-muted'

/**
 * The detail pane of the Subjects screen (PBI-127): the subject, its counts and streams, a scope
 * control that shows the exact filter, and labelled actions. Opening a tab never changes server
 * state; sending a published message still goes through the gateway rules.
 */
export function SubjectDetail({
  connId,
  node,
  streams,
  readOnly = false,
  onCollapse
}: SubjectDetailProps): ReactNode {
  return (
    <aside
      aria-label="Subject details"
      data-testid="subject-detail"
      className="flex h-full min-h-0 flex-col overflow-y-auto bg-panel"
    >
      {onCollapse && (
        <div className="flex shrink-0 justify-end px-2 pt-2">
          <Button
            size="sm"
            variant="ghost"
            aria-label="Collapse details"
            title="Collapse details"
            icon={<PanelRightClose className="h-3.5 w-3.5" aria-hidden />}
            onClick={onCollapse}
          />
        </div>
      )}
      {node ? (
        // Keyed by path so the chosen scope and stream start over for another subject.
        <Body key={node.path} connId={connId} node={node} streams={streams} readOnly={readOnly} />
      ) : (
        <p className="p-4 text-muted">
          Select a subject to see its streams and to browse, tail or publish on it.
        </p>
      )}
    </aside>
  )
}

function Body({
  connId,
  node,
  streams,
  readOnly
}: {
  connId: string
  node: SubjectInfo
  streams: readonly StreamPatterns[]
  readOnly: boolean
}): ReactNode {
  const tabs = useTabs()
  const groupId = useId()
  const [chosen, setChosen] = useState<SubjectScope | null>(null)
  const [chosenStream, setChosenStream] = useState<{ key: string; stream: string } | null>(null)
  const [countsOpen, setCountsOpen] = useState(true)
  const [streamsOpen, setStreamsOpen] = useState(true)

  const scopes = availableScopes(node)
  const scope = resolveScope(node, chosen)
  const actions = describeActions(node, scope, streams, readOnly)
  const { browse } = actions
  const streamKey = `${scope}`
  const stream =
    chosenStream?.key === streamKey && browse.streams.includes(chosenStream.stream)
      ? chosenStream.stream
      : browse.defaultStream
  const listed = scope ? scopeStreams(node, scope, streams) : []

  const below = Math.max(0, node.total - node.own)
  const liveBelow = Math.max(0, node.liveTotal - node.live)

  return (
    <div className="flex flex-col gap-3 p-4">
      <div>
        <div className="flex items-start gap-1">
          <h3
            className="min-w-0 flex-1 font-mono text-sm font-semibold break-all"
            title={node.path}
          >
            {node.path}
          </h3>
          <CopyButton text={node.path} label="Copy subject path" />
        </div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {node.liveOnly && (
            <Badge tone="accent" title="Seen in a live tail this session; not stored in a stream">
              live only
            </Badge>
          )}
          {node.hasChildren && (
            <Badge>
              {formatCount(node.childCount)} {node.childCount === 1 ? 'child' : 'children'}
            </Badge>
          )}
        </div>
        {!node.valid && (
          <p role="note" className="mt-2 rounded-md border border-line bg-raised p-2 text-xs">
            Not a valid subject: it has an empty token, whitespace or a wildcard token, so no scope,
            filter or action is offered for it.
          </p>
        )}
      </div>

      <CollapsibleSection
        title="Messages"
        summary={`${formatCount(node.own)} here, ${formatCount(below)} below`}
        open={countsOpen}
        onToggle={() => setCountsOpen((v) => !v)}
      >
        <Facts
          columns={3}
          items={[
            ['Stored on this subject', formatCount(node.own)],
            ['Stored below', node.hasChildren ? formatCount(below) : 'no children'],
            [
              'Live this session',
              node.hasChildren
                ? `${formatCount(node.live)} here, ${formatCount(liveBelow)} below`
                : formatCount(node.live)
            ]
          ]}
        />
        <p className="mt-1 text-xs text-faint">
          Live counts only cover messages seen in a live tail since the app started.
        </p>
      </CollapsibleSection>

      <CollapsibleSection
        title="Streams"
        summary={listed.length ? listed.map((s) => s.name).join(', ') : 'none'}
        open={streamsOpen}
        onToggle={() => setStreamsOpen((v) => !v)}
      >
        {listed.length === 0 ? (
          <p className="text-xs text-muted">
            {scope ? 'No stream stores or captures this filter.' : '-'}
          </p>
        ) : (
          <ul className="flex flex-col gap-1" aria-label="Streams for this scope">
            {listed.map((s) => (
              <li key={s.name} className="flex items-baseline gap-2 text-[13px]">
                <span className="min-w-0 truncate font-mono" title={s.name}>
                  {s.name}
                </span>
                <span className="text-xs text-muted">
                  {s.stored > 0
                    ? `${formatCount(s.stored)} stored`
                    : 'nothing stored here, captures this subject'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CollapsibleSection>

      {scopes.length > 0 && (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-xs font-semibold text-muted">Scope</legend>
          <div role="radiogroup" aria-label="Scope" className="flex flex-col gap-1">
            {scopes.map((s) => (
              <label key={s} className="flex cursor-pointer items-start gap-2 text-[13px]">
                <input
                  type="radio"
                  name={groupId}
                  className="mt-0.5 accent-[var(--color-accent)]"
                  checked={scope === s}
                  onChange={() => setChosen(s)}
                />
                <span className="min-w-0 break-words">{scopeLabel(node, s)}</span>
              </label>
            ))}
          </div>
          <p className="text-xs text-muted">
            Filter used:{' '}
            <code data-testid="subject-filter" className="font-mono text-fg">
              {actions.filter}
            </code>
          </p>
        </fieldset>
      )}

      <div role="group" aria-label="Actions" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            icon={<Database className="h-3.5 w-3.5" aria-hidden />}
            disabled={!browse.enabled}
            title={browse.reason}
            onClick={() => runBrowse(tabs, connId, browse, stream)}
          >
            {browse.label}
          </Button>
          {browse.streams.length > 1 && stream && (
            <Menu
              trigger={(p) => (
                <Button
                  {...p}
                  aria-label={`Stream to browse: ${stream}`}
                  title="Choose the stream to browse"
                  icon={<ChevronDown className="h-3.5 w-3.5" aria-hidden />}
                >
                  {stream}
                </Button>
              )}
              items={browse.streams.map((s) => ({
                label: s === stream ? `${s} (selected)` : s,
                onSelect: () => setChosenStream({ key: streamKey, stream: s })
              }))}
            />
          )}
        </div>
        <Reason action={browse} />
        {browse.enabled && browse.streams.length > 1 && (
          <p className={REASON}>
            Stored in {browse.streams.length} streams; browsing {stream}.
          </p>
        )}

        <div>
          <Button
            icon={<Radio className="h-3.5 w-3.5" aria-hidden />}
            disabled={!actions.tail.enabled}
            title={actions.tail.reason}
            onClick={() => runTail(tabs, connId, actions.tail)}
          >
            {actions.tail.label}
          </Button>
          <Reason action={actions.tail} />
        </div>

        <div>
          <Button
            icon={<Send className="h-3.5 w-3.5" aria-hidden />}
            disabled={!actions.publish.enabled}
            title={actions.publish.reason}
            aria-describedby={actions.publish.reason ? `${groupId}-publish` : undefined}
            onClick={() => runPublish(tabs, connId, actions.publish)}
          >
            {actions.publish.label}
          </Button>
          <Reason action={actions.publish} id={`${groupId}-publish`} />
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <CopyButton text={node.path} label={actions.copySubject.label} size="md" />
          <span className="text-xs text-muted">{actions.copySubject.label}</span>
          {actions.filter && (
            <>
              <CopyButton text={actions.filter} label={`Copy filter ${actions.filter}`} size="md" />
              <span className="text-xs text-muted">
                {actions.copyFilter.label} ({actions.filter})
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** The reason an action is unavailable, as text (a disabled button alone says nothing). */
function Reason({ action, id }: { action: ActionDescriptor; id?: string }): ReactNode {
  if (action.enabled || !action.reason) return null
  return (
    <p id={id} className={`${REASON} mt-1`}>
      Unavailable: {action.reason}
    </p>
  )
}
