import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { DesktopBridge, UpdateEvent } from '@shared/desktop'
import type { ClientMessage, ServerMessage } from '@shared/rpc'

/**
 * The only things the UI can reach in the desktop app. The renderer gets these functions and
 * nothing else: no ipcRenderer, no Node APIs.
 */
const bridge: DesktopBridge = {
  send(message: ClientMessage): void {
    ipcRenderer.send('studio:rpc', message)
  },
  onMessage(handler: (message: ServerMessage) => void): () => void {
    const listener = (_event: unknown, message: ServerMessage): void => handler(message)
    ipcRenderer.on('studio:rpc', listener)
    return () => ipcRenderer.removeListener('studio:rpc', listener)
  },
  pickFile(options) {
    return ipcRenderer.invoke('studio:pick-file', options)
  },
  pathForFile(file: File): string {
    return webUtils.getPathForFile(file)
  },
  openExternal(url: string): Promise<void> {
    return ipcRenderer.invoke('studio:open-external', url)
  },
  onUpdateEvent(handler: (event: UpdateEvent) => void): () => void {
    const listener = (_event: unknown, update: UpdateEvent): void => handler(update)
    ipcRenderer.on('studio:update', listener)
    return () => ipcRenderer.removeListener('studio:update', listener)
  },
  checkForUpdates(): Promise<void> {
    return ipcRenderer.invoke('studio:update-check')
  },
  downloadUpdate(): Promise<void> {
    return ipcRenderer.invoke('studio:update-download')
  },
  installUpdate(): Promise<void> {
    return ipcRenderer.invoke('studio:update-install')
  }
}

contextBridge.exposeInMainWorld('studioDesktop', bridge)
