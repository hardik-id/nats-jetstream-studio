// Types only: the graph model is part of the lazily loaded Graph view.
import type { GraphOptions } from '../model/graph'
import { GROUP_SUBJECTS, groupsSubjects } from './controls'
import type { ViewControl, ViewSettings } from './types'

/** The controls of the Graph view. The toolbar renders these; the view reads the values. */
export const GRAPH_CONTROLS: readonly ViewControl[] = [
  {
    kind: 'toggle',
    id: 'showConsumers',
    label: 'Show consumers',
    default: true
  },
  { kind: 'toggle', id: 'animate', label: 'Animate', default: true },
  {
    ...GROUP_SUBJECTS,
    hint: 'Messages whose subjects differ only by an id (a number, UUID or hash) share a node, as orders.*.paid.'
  }
]

export interface GraphSettings extends GraphOptions {
  /** Dots travel along the arrows (unless the system asks for reduced motion). */
  animate: boolean
}

/** The graph options for resolved settings (see `resolveSettings`). */
export function graphSettings(settings: ViewSettings): GraphSettings {
  return {
    consumers: settings.showConsumers !== false,
    group: groupsSubjects(settings),
    animate: settings.animate !== false
  }
}
