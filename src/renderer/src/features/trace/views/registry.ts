import { lazy } from 'react'
import { ChartGantt, Rows3, Waypoints } from 'lucide-react'
import type { TraceViewDef } from './types'
import { TimelineView } from './TimelineView'
import { LanesView } from './LanesView'
import { LANES_CONTROLS } from './lanesSettings'
import { GRAPH_CONTROLS } from './graphSettings'

/**
 * The views of a trace, in the order of the View dropdown. A new view is one file in this folder
 * and one entry here; the toolbar shows the dropdown once there is more than one, and the view's
 * own `controls` while it is active. A view with a large dependency is loaded on first use with
 * `lazy` (the Graph view and its graph library are a separate chunk); `TraceTab` shows a loading
 * state meanwhile.
 */
export const TRACE_VIEWS: readonly TraceViewDef[] = [
  { id: 'timeline', label: 'Timeline', icon: ChartGantt, Component: TimelineView },
  { id: 'lanes', label: 'Lanes', icon: Rows3, controls: LANES_CONTROLS, Component: LanesView },
  {
    id: 'graph',
    label: 'Graph',
    icon: Waypoints,
    controls: GRAPH_CONTROLS,
    Component: lazy(() => import('./GraphView'))
  }
]
