import { useEffect, useMemo, useRef, useState } from 'react'
import type { SubjectSort, SubjectSource } from '../features/subjects/subjectTree'
import { useSetting } from '../lib/hooks'

/** What the Subjects screen remembers per connection (PBI-127). */
export interface SubjectsUiState {
  /** Open nodes. `null` until the user opens or closes one: the top level is open then. */
  expanded: string[] | null
  selected: string | null
  sort: SubjectSort
  onlyWithMessages: boolean
  source: SubjectSource
  /** Width of the detail pane in px. */
  paneWidth: number
  /** `null`: not chosen, the pane is a rail on a narrow window. */
  paneCollapsed: boolean | null
}

export const PANE_MIN_WIDTH = 300
export const PANE_DEFAULT_WIDTH = 380
/** The most open nodes that are stored (Expand all is capped at 5,000 rows). */
export const MAX_STORED_EXPANDED = 5000

export const SUBJECTS_UI_DEFAULTS: SubjectsUiState = {
  expanded: null,
  selected: null,
  sort: 'messages',
  onlyWithMessages: false,
  source: 'all',
  paneWidth: PANE_DEFAULT_WIDTH,
  paneCollapsed: null
}

export const subjectsUiKey = (connId: string): string => `subjects.ui.${connId}`

const SORTS: SubjectSort[] = ['messages', 'name', 'live']
const SOURCES: SubjectSource[] = ['all', 'streams', 'live']

/** What is stored may be anything (an older version, a hand-edited file): keep what is usable. */
export function sanitizeSubjectsUi(raw: unknown): SubjectsUiState {
  const d = SUBJECTS_UI_DEFAULTS
  if (!raw || typeof raw !== 'object') return d
  const r = raw as Record<string, unknown>
  const width = typeof r.paneWidth === 'number' && Number.isFinite(r.paneWidth) ? r.paneWidth : null
  return {
    expanded: Array.isArray(r.expanded)
      ? r.expanded.filter((p): p is string => typeof p === 'string').slice(0, MAX_STORED_EXPANDED)
      : null,
    selected: typeof r.selected === 'string' ? r.selected : null,
    sort: SORTS.includes(r.sort as SubjectSort) ? (r.sort as SubjectSort) : d.sort,
    onlyWithMessages: r.onlyWithMessages === true,
    source: SOURCES.includes(r.source as SubjectSource) ? (r.source as SubjectSource) : d.source,
    paneWidth: width === null ? d.paneWidth : Math.max(PANE_MIN_WIDTH, Math.round(width)),
    paneCollapsed: typeof r.paneCollapsed === 'boolean' ? r.paneCollapsed : null
  }
}

/**
 * The remembered state of the screen. `update` merges a patch into what is stored and writes it;
 * it does nothing until the stored value has been read, so the defaults never replace it.
 */
export function useSubjectsUi(connId: string): {
  ui: SubjectsUiState
  /** The stored value was read, or reading failed (then the state only lives in memory). */
  ready: boolean
  /** The saved view could not be read, so changes are not saved. */
  loadFailed: boolean
  update: (patch: Partial<SubjectsUiState>) => void
} {
  const [raw, setRaw, loaded, loadError] = useSetting<unknown>(subjectsUiKey(connId), null)
  // When the stored value cannot be read, the screen still works from memory: nothing is written,
  // because the defaults would replace what is stored.
  const [memory, setMemory] = useState<SubjectsUiState | null>(null)
  const failed = !loaded && loadError !== null
  const stored = useMemo(() => sanitizeSubjectsUi(raw), [raw])
  const ui = failed ? (memory ?? SUBJECTS_UI_DEFAULTS) : stored
  const latestRef = useRef({ ui, loaded, failed })
  useEffect(() => {
    latestRef.current = { ui, loaded, failed }
  })
  const update = (patch: Partial<SubjectsUiState>): void => {
    const cur = latestRef.current
    if (!cur.loaded && !cur.failed) return
    const next = { ...cur.ui, ...patch }
    // Two updates in one event must both land: the next call starts from this value.
    latestRef.current = { ...cur, ui: next }
    if (cur.failed) setMemory(next)
    else void setRaw(next)
  }
  return { ui, ready: loaded || failed, loadFailed: failed, update }
}
