import type { ClientMessage, ServerMessage } from './rpc'

export type UpdateEvent =
  | { type: 'checking' }
  | { type: 'available'; version: string; notes?: string }
  | { type: 'not-available'; version: string }
  | { type: 'progress'; percent: number }
  | { type: 'downloaded'; version: string }
  | { type: 'error'; message: string }

export interface PickFileOptions {
  title?: string
  filters?: { name: string; extensions: string[] }[]
}

/** What the desktop preload script exposes to the UI as `window.studioDesktop`. */
export interface DesktopBridge {
  send(message: ClientMessage): void
  onMessage(handler: (message: ServerMessage) => void): () => void
  /** Opens the OS file dialog and returns the chosen path, or null when cancelled. */
  pickFile(options?: PickFileOptions): Promise<string | null>
  pathForFile(file: File): string
  openExternal(url: string): Promise<void>
  onUpdateEvent(handler: (event: UpdateEvent) => void): () => void
  checkForUpdates(): Promise<void>
  downloadUpdate(): Promise<void>
  installUpdate(): Promise<void>
}
