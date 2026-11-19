import { memo, type ReactNode } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Users } from 'lucide-react'
import { cx } from '../../../../components/ui'
import type { ConsumerFlowNode } from './elements'
import { consumerSummary } from './text'

/**
 * A consumer: a rounded rectangle with the consumer icon, its name and stream, and where it
 * stands with the messages of the trace. A ring marks the consumers of the selected message.
 */
function ConsumerNodeComponent({ data, width, height }: NodeProps<ConsumerFlowNode>): ReactNode {
  const { node, current } = data
  return (
    <div
      className={cx(
        'flex items-center gap-2.5 rounded-lg border-[1.5px] bg-bg px-3 shadow-sm transition-[box-shadow,border-color]',
        current
          ? 'border-accent/80 ring-2 ring-accent/20'
          : 'border-[var(--graph-node-border)] hover:border-accent/70'
      )}
      style={{ width, height }}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
        <Users className="h-4 w-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] leading-4 font-semibold text-fg">{node.name}</div>
        <div className="truncate text-[10.5px] leading-4 text-muted">{node.stream}</div>
        <div
          className={cx(
            'truncate text-[10.5px] leading-4 tabular-nums',
            node.undelivered || node.waiting ? 'text-warn' : 'text-ok'
          )}
        >
          {consumerSummary(node)}
        </div>
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  )
}

export const ConsumerNode = memo(ConsumerNodeComponent)
