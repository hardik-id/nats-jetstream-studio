import { useRef, type ReactNode } from 'react'
import { PanelRightClose, PanelRightOpen } from 'lucide-react'
import { formatCount } from '@shared/format'
import { Badge, Button, CopyButton, Facts } from '../../components/ui'
import { PANE_MIN_WIDTH } from '../../state/subjectsUi'
import type { StreamPatterns, SubjectInfo } from './subjectTree'

const PANE_STEP = 24
/** The width of the collapsed pane: a rail with the expand button. */
export const PANE_RAIL_WIDTH = 36

/**
 * The detail pane's frame (the PBI-125 pattern): a separator on its left edge resizes it by
 * pointer or arrow keys; collapsed, it is a thin rail. The saved width is kept while collapsed.
 */
export function PaneFrame({
  width,
  onWidth,
  onCommit,
  collapsed,
  children
}: {
  width: number
  onWidth: (w: number) => void
  onCommit: (w: number) => void
  collapsed: boolean
  children: ReactNode
}): ReactNode {
  const frame = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; width: number; last: number } | null>(null)
  // The pane takes at most 60% of the row, so the tree always keeps room.
  const maxWidth = (): number => {
    const row = frame.current?.parentElement?.clientWidth || 1600
    return Math.max(PANE_MIN_WIDTH, Math.floor(row * 0.6))
  }
  const clamp = (w: number): number => Math.min(maxWidth(), Math.max(PANE_MIN_WIDTH, Math.round(w)))
  const current = Math.max(PANE_MIN_WIDTH, Math.round(width))
  if (collapsed) {
    return (
      <div
        ref={frame}
        className="relative shrink-0"
        style={{ width: PANE_RAIL_WIDTH }}
        data-testid="subjects-pane-frame"
      >
        {children}
      </div>
    )
  }
  return (
    <div
      ref={frame}
      className="relative shrink-0"
      data-testid="subjects-pane-frame"
      style={{ width: current, maxWidth: '60%', minWidth: PANE_MIN_WIDTH }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize subject details"
        aria-valuenow={current}
        aria-valuemin={PANE_MIN_WIDTH}
        tabIndex={0}
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none hover:bg-accent/40 active:bg-accent/60"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { x: e.clientX, width: current, last: current }
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d) return
          d.last = clamp(d.width + (d.x - e.clientX))
          onWidth(d.last)
        }}
        onPointerUp={() => {
          const d = drag.current
          drag.current = null
          if (d) onCommit(d.last)
        }}
        onKeyDown={(e) => {
          const delta = e.key === 'ArrowLeft' ? PANE_STEP : e.key === 'ArrowRight' ? -PANE_STEP : 0
          if (e.key === 'Home') onCommit(PANE_MIN_WIDTH)
          else if (e.key === 'End') onCommit(maxWidth())
          else if (delta) onCommit(clamp(current + delta))
          else return
          e.preventDefault()
        }}
      />
      {children}
    </div>
  )
}

/** The collapsed pane: an expand button and the selected subject, written sideways. */
export function PaneRail({ label, onExpand }: { label: string; onExpand: () => void }): ReactNode {
  return (
    <aside
      aria-label="Subject details (collapsed)"
      className="flex h-full w-full flex-col items-center gap-2 border-l border-line bg-panel py-2"
    >
      <Button
        size="sm"
        variant="ghost"
        onClick={onExpand}
        title="Show subject details"
        aria-label="Show subject details"
        icon={<PanelRightOpen className="h-4 w-4" aria-hidden />}
      />
      <span
        className="max-h-full truncate text-xs font-medium whitespace-nowrap text-muted [text-orientation:mixed] [writing-mode:vertical-rl]"
        data-testid="subjects-rail-label"
      >
        {label}
      </span>
    </aside>
  )
}

export interface SubjectDetailProps {
  connId: string
  /** The selected subject, or null. */
  node: SubjectInfo | null
  /** Subject patterns of every stream shown on this screen (to find the owners of a scope). */
  streams: readonly StreamPatterns[]
  readOnly: boolean
  onCollapse: () => void
}

/**
 * PLACEHOLDER for the real detail pane (slice C: `SubjectDetail.tsx` with the labelled actions
 * and the scope control). It shows what the tree already knows. The pane frame, the rail and
 * this slot's props are final; swap this component for `SubjectDetail` when slice C is merged.
 */
export function SubjectDetailPlaceholder({ node, onCollapse }: SubjectDetailProps): ReactNode {
  return (
    <aside
      aria-label="Subject details"
      className="flex h-full min-h-0 w-full flex-col border-l border-line bg-panel"
    >
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-line px-3">
        <h2
          className="min-w-0 flex-1 truncate font-mono text-[13px] font-semibold"
          title={node?.path}
        >
          {node ? node.path : 'Subject details'}
        </h2>
        {node && <CopyButton text={node.path} label="Copy subject" />}
        <Button
          size="sm"
          variant="ghost"
          onClick={onCollapse}
          title="Collapse panel"
          aria-label="Collapse panel"
          icon={<PanelRightClose className="h-4 w-4" aria-hidden />}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {node ? (
          <div className="flex flex-col gap-3">
            <Facts
              columns={1}
              items={[
                ['Stored here and below', formatCount(node.total)],
                ['Stored on this subject', formatCount(node.own)],
                ['Seen live this session', formatCount(node.liveTotal)],
                [
                  'Streams',
                  node.streams.length ? (
                    <span className="flex flex-wrap gap-1">
                      {node.streams.map((s) => (
                        <Badge key={s}>{s}</Badge>
                      ))}
                    </span>
                  ) : (
                    'None'
                  )
                ]
              ]}
            />
            <p className="text-xs text-muted">
              Use the actions menu on the row to browse, tail or publish.
            </p>
          </div>
        ) : (
          <p className="text-muted">
            Select a subject to see where it is stored and what to do with it.
          </p>
        )}
      </div>
    </aside>
  )
}
