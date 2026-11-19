import { memo, type ReactNode, type Ref } from 'react'
import { ViewportPortal } from '@xyflow/react'
import type { Dot, Motion } from '../../model/motion'
import type { GraphFlowEdge } from './elements'

const DOT_RADIUS = 3.6
/** Seconds a dot takes to fade in at the start of its trip and out at the end. */
const FADE = 0.12

/**
 * The moving dots: small circles that travel along the edges with SVG `<animateMotion>`, all in
 * one `<svg>` over the graph. They run on the browser's animation clock (no React render per
 * frame), and being in one `<svg>` they share one clock, so they stay in step and pause
 * together. When and how fast each one goes comes from `planMotion`.
 */
function FlowDotsComponent({
  ref,
  idPrefix,
  edges,
  motion
}: {
  ref: Ref<SVGSVGElement>
  /** Unique in the document: the animations refer to each other by id. */
  idPrefix: string
  edges: readonly GraphFlowEdge[]
  motion: Motion
}): ReactNode {
  return (
    <ViewportPortal>
      <svg
        ref={ref}
        className="trace-graph-dots pointer-events-none absolute top-0 left-0 overflow-visible"
        width="1"
        height="1"
        aria-hidden
        data-testid="graph-dots"
      >
        {edges.map((e, i) =>
          e.data && !e.data.faint
            ? (motion.dots[e.id] ?? []).map((dot, k) => (
                <MovingDot
                  key={`${e.id}#${k}`}
                  id={`${idPrefix}_${i}_${k}`}
                  dot={dot}
                  cycle={motion.cycle}
                  path={e.data!.geometry.path}
                  slow={e.data!.edge.slowest}
                />
              ))
            : null
        )}
      </svg>
    </ViewportPortal>
  )
}

/**
 * One dot. It travels during its part of the cycle and is hidden for the rest; between trips
 * nothing of it animates, so the browser only works on the dots that are on their way. Each trip
 * starts when the previous one ended plus the idle time, so every dot repeats with the cycle
 * and all of them stay in step.
 */
function MovingDot({
  id,
  dot,
  cycle,
  path,
  slow
}: {
  id: string
  dot: Dot
  cycle: number
  path: string
  slow: boolean
}): ReactNode {
  const travel = `${dot.travel.toFixed(3)}s`
  const fade = Math.min(FADE, dot.travel * 0.15) / dot.travel
  return (
    <circle
      r={DOT_RADIUS}
      visibility="hidden"
      className={slow ? 'fill-warn' : 'fill-accent'}
      data-testid="graph-dot"
    >
      <animateMotion
        id={id}
        begin={`${dot.start.toFixed(3)}s;${id}.end+${(cycle - dot.travel).toFixed(3)}s`}
        dur={travel}
        path={path}
        calcMode="linear"
      />
      <set attributeName="visibility" to="visible" begin={`${id}.begin`} dur={travel} />
      <animate
        attributeName="opacity"
        begin={`${id}.begin`}
        dur={travel}
        values="0;1;1;0"
        keyTimes={`0;${fade.toFixed(4)};${(1 - fade).toFixed(4)};1`}
      />
    </circle>
  )
}

export const FlowDots = memo(FlowDotsComponent)
