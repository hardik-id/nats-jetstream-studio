import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ThemeChoice = 'system' | 'light' | 'dark'

interface UiState {
  theme: ThemeChoice
  sidebarWidth: number
  /** Connections whose tree is collapsed in the sidebar. */
  collapsed: Record<string, boolean>
  setTheme(theme: ThemeChoice): void
  setSidebarWidth(width: number): void
  toggleCollapsed(connId: string): void
}

export const useUi = create<UiState>()(
  persist(
    (set, get) => ({
      theme: 'system',
      sidebarWidth: 260,
      collapsed: {},
      setTheme: (theme) => set({ theme }),
      setSidebarWidth: (sidebarWidth) =>
        set({ sidebarWidth: Math.min(480, Math.max(200, sidebarWidth)) }),
      toggleCollapsed: (connId) =>
        set({ collapsed: { ...get().collapsed, [connId]: !get().collapsed[connId] } })
    }),
    { name: 'studio.ui.v1' }
  )
)

/**
 * Pages that want the sidebar as an icon rail while they are open (PBI-115). Not persisted: the
 * user's own choice is a setting (`SIDEBAR_RAIL_SETTING`) and wins again once every request is
 * released. `requestRail(owner, true)` asks for the rail, `requestRail(owner, false)` releases it;
 * the owner is any stable string, so several pages can ask at once.
 */
interface RailState {
  owners: Record<string, true>
  requestRail(owner: string, on: boolean): void
}

export const useRail = create<RailState>((set, get) => ({
  owners: {},
  requestRail: (owner, on) => {
    if (on === Boolean(get().owners[owner])) return
    const owners = { ...get().owners }
    if (on) owners[owner] = true
    else delete owners[owner]
    set({ owners })
  }
}))

/** Asks for the icon rail (or releases the request). Callable outside React. */
export function requestRail(owner: string, on: boolean): void {
  useRail.getState().requestRail(owner, on)
}

/** True while some page has asked for the rail. */
export const useRailRequested = (): boolean => useRail((s) => Object.keys(s.owners).length > 0)

/** The user's own choice of the collapsed rail, saved with the window's settings. */
export const SIDEBAR_RAIL_SETTING = 'ui.sidebarRail'

/** Things that are open right now. Not persisted. */
interface OverlayState {
  palette: boolean
  help: boolean
  about: boolean
  /** null: closed. 'new': add a connection. Otherwise the id being edited. */
  connectionForm: string | null
  secretPrompt: string | null
  set(patch: Partial<Omit<OverlayState, 'set'>>): void
}

export const useOverlays = create<OverlayState>((set) => ({
  palette: false,
  help: false,
  about: false,
  connectionForm: null,
  secretPrompt: null,
  set: (patch) => set(patch)
}))

export function resolveTheme(choice: ThemeChoice): 'light' | 'dark' {
  if (choice !== 'system') return choice
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}
