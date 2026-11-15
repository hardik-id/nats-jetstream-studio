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
