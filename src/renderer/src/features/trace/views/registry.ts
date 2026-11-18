import { ChartGantt } from 'lucide-react'
import type { TraceViewDef } from './types'
import { TimelineView } from './TimelineView'

/**
 * The views of a trace, in the order of the View dropdown. A new view is one file in this folder
 * and one line here; the toolbar shows the dropdown once there is more than one.
 */
export const TRACE_VIEWS: readonly TraceViewDef[] = [
  { id: 'timeline', label: 'Timeline', icon: ChartGantt, Component: TimelineView }
]
