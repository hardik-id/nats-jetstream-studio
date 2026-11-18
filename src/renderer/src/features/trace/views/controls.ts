import type { TraceViewDef, ViewSettings } from './types'

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
