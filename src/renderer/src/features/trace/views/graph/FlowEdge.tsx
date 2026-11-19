import { memo, useContext, type ReactNode } from 'react'
import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from '@xyflow/react'
import { cx } from '../../../../components/ui'
import { GraphActions } from './actions'
import type { GraphFlowEdge } from './elements'

/** Stroke width from the number of steps an edge stands for: thicker for busier edges. */
export const strokeWidth = (count: number): number => 1.6 + Math.min(3, Math.log2(count))

/**
 * An edge of the trace graph: a thin static line (solid for a known delivery, dashed for an
 * inferred hop, dotted for a message not delivered yet) and its label. Where it runs comes from
 * the layout (see `edgeGeometry`); the moving dots are drawn over all edges by `FlowDots`.
 */
function FlowEdgeComponent({ id, markerEnd, data }: EdgeProps<GraphFlowEdge>): ReactNode {
  const actions = useContext(GraphActions)
  if (!data) return null
  const { edge, label, geometry, branch, current, colour, faint } = data
  const text = branch ? null : label
  const width = strokeWidth(edge.count) + (current ? 1 : 0)
  const dash = edge.kind === 'hop' ? '7 5' : edge.kind === 'pending' ? '1.5 4' : undefined

  return (
    <>
      <title>{data.name}</title>
      <BaseEdge
        id={id}
        path={geometry.path}
        markerEnd={markerEnd}
        interactionWidth={18}
        style={{
          stroke: colour,
          strokeWidth: width,
          strokeDasharray: dash,
          opacity: faint ? 0.35 : undefined
        }}
      />
      {(text || edge.slowest) && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-auto absolute flex cursor-pointer flex-col items-center gap-0.5"
            style={{
              transform: `translate(-50%, -50%) translate(${geometry.labelX}px, ${geometry.labelY}px)`
            }}
            onClick={() => actions.pickEdge(edge.id)}
            onMouseEnter={actions.pause}
            onMouseLeave={actions.resume}
            aria-hidden
          >
            {edge.slowest && (
              <span className="rounded-sm bg-warn px-1 text-[9.5px] leading-[14px] font-bold tracking-wider text-bg">
                SLOWEST
              </span>
            )}
            {text && (
              <span
                data-testid="graph-edge-label"
                className={cx(
                  'rounded border bg-bg px-1.5 text-[11px] leading-[17px] whitespace-nowrap tabular-nums',
                  edge.slowest
                    ? 'border-warn/60 font-semibold text-warn'
                    : current
                      ? 'border-accent/60 text-accent'
                      : 'border-line text-muted'
                )}
              >
                {text}
              </span>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

export const FlowEdge = memo(FlowEdgeComponent)
