import type { ComponentType } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { Trace } from '../model/trace'

/** What every view of a trace gets. Views draw; they never fetch and never compute the trace. */
export interface TraceViewProps {
  trace: Trace
  /** The id of the selected message (see `messageId`), or null. */
  selected: string | null
  /** The selection moved (arrow keys, a click). */
  onSelect: (id: string) => void
  /** A click, Enter or double-click on a message: show it in the detail pane. */
  onOpen: (id: string) => void
}

export interface TraceViewDef {
  id: string
  label: string
  icon: LucideIcon
  Component: ComponentType<TraceViewProps>
}
