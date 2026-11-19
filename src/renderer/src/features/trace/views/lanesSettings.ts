import { DEFAULT_LANE_OPTIONS, type LaneOptions } from '../model/lanes'
import { GROUP_SUBJECTS, groupsSubjects } from './controls'
import type { ViewControl, ViewSettings } from './types'

/** The controls of the Lanes view. The toolbar renders these; the view reads the values. */
export const LANES_CONTROLS: readonly ViewControl[] = [
  {
    kind: 'select',
    id: 'laneBy',
    label: 'Lane by',
    options: [
      { value: 'subject', label: 'Subject' },
      { value: 'stream', label: 'Stream' }
    ],
    default: DEFAULT_LANE_OPTIONS.by
  },
  {
    kind: 'select',
    id: 'scale',
    label: 'Scale',
    options: [
      { value: 'steps', label: 'Even steps' },
      { value: 'time', label: 'Real time' }
    ],
    default: DEFAULT_LANE_OPTIONS.scale
  },
  {
    ...GROUP_SUBJECTS,
    hint: 'Messages whose subjects differ only by an id (a number, UUID or hash) share a lane, as orders.*.paid. Only with Lane by Subject.',
    disabled: (settings) => settings.laneBy === 'stream'
  }
]

/** The layout options for resolved settings (see `resolveSettings`). */
export function laneOptions(settings: ViewSettings): LaneOptions {
  return {
    by: settings.laneBy === 'stream' ? 'stream' : 'subject',
    scale: settings.scale === 'time' ? 'time' : 'steps',
    group: groupsSubjects(settings)
  }
}
