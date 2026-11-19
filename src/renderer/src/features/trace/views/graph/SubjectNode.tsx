import { memo, type ReactNode } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { cx } from '../../../../components/ui'
import { BRANCH_INDENT } from '../../model/layout'
import type { SubjectFlowNode } from './elements'

/**
 * A subject: a pill with the subject (or the grouped subject), its stream and how many messages
 * of the trace are on it. The selected message's node gets a ring and its position ("2 of 3").
 */
function SubjectNodeComponent({ data, width, height }: NodeProps<SubjectFlowNode>): ReactNode {
  const { node, current } = data
  const count = node.messages.length
  return (
    <div
      className={cx(
        'flex items-center gap-2 rounded-full border-[1.5px] bg-panel pr-3 pl-4 shadow-sm transition-[box-shadow,border-color]',
        current !== null
          ? 'border-accent ring-4 ring-accent/25'
          : 'border-[var(--graph-node-border)] hover:border-accent/70'
      )}
      style={{ width, height }}
      title={node.subjects.join('\n')}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-[12px] leading-4 font-medium text-fg">
          {node.key}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10.5px] leading-4 text-muted">
          <span className="truncate rounded-sm bg-raised px-1">{node.streams.join(', ')}</span>
          {current !== null && count > 1 && (
            <span className="shrink-0 text-accent tabular-nums">
              {current + 1} of {count}
            </span>
          )}
        </div>
      </div>
      {count > 1 && (
        <span className="shrink-0 rounded-full bg-raised px-1.5 text-[11px] leading-[18px] text-muted tabular-nums">
          ×{count}
        </span>
      )}
      <Handle type="source" position={Position.Right} isConnectable={false} />
      {/* Side branches leave from below, where their line runs down to the consumers. */}
      <Handle
        id="branch"
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        style={{ left: BRANCH_INDENT / 2 }}
      />
    </div>
  )
}

export const SubjectNode = memo(SubjectNodeComponent)
