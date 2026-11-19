import type { ToggleControl, TraceViewDef, ViewSettings } from './types'

/**
 * The settings a view runs with: each of its controls takes the stored value when that is valid
 * (a listed option, a boolean) and the control's default otherwise. A value stored by an older
 * version, or by hand, can therefore never reach a view.
 */
export function resolveSettings(
  view: Pick<TraceViewDef, 'controls'>,
  stored: ViewSettings | undefined
): ViewSettings {
  const out: Record<string, string | boolean> = {}
  for (const c of view.controls ?? []) {
    const value = stored?.[c.id]
    if (c.kind === 'select')
      out[c.id] =
        typeof value === 'string' && c.options.some((o) => o.value === value) ? value : c.default
    else out[c.id] = typeof value === 'boolean' ? value : c.default
  }
  return out
}

/**
 * "Group similar subjects", shared by the views that draw one thing per subject (Lanes, Graph).
 * One id, so the choice carries over when the view changes; each view adds its own hint.
 */
export const GROUP_SUBJECTS: ToggleControl = {
  kind: 'toggle',
  id: 'groupSubjects',
  label: 'Group similar subjects',
  default: true,
  placement: 'more'
}

/** Whether subjects are grouped, for resolved settings. */
export const groupsSubjects = (settings: ViewSettings): boolean => settings.groupSubjects !== false
