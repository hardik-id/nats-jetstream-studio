import { app, ipcMain, type BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateEvent } from '@shared/desktop'

/**
 * Auto-update (PBI-100). Updates are never downloaded or installed without the user saying so:
 * the app only checks on start, then the UI offers "Download" and "Restart to install".
 */
export function setupUpdater(getWindow: () => BrowserWindow | null): void {
  const { autoUpdater } = electronUpdater
  const send = (event: UpdateEvent): void => getWindow()?.webContents.send('studio:update', event)

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.on('checking-for-update', () => send({ type: 'checking' }))
  autoUpdater.on('update-available', (info) =>
    send({
      type: 'available',
      version: info.version,
      notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined
    })
  )
  autoUpdater.on('update-not-available', (info) =>
    send({ type: 'not-available', version: info.version })
  )
  autoUpdater.on('download-progress', (progress) =>
    send({ type: 'progress', percent: Math.round(progress.percent) })
  )
  autoUpdater.on('update-downloaded', (info) => send({ type: 'downloaded', version: info.version }))
  autoUpdater.on('error', (err) => send({ type: 'error', message: err.message }))

  const check = async (): Promise<void> => {
    // Only installed builds can update; in development there is nothing to check against.
    if (!app.isPackaged) {
      send({ type: 'not-available', version: app.getVersion() })
      return
    }
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      send({ type: 'error', message: (err as Error).message })
    }
  }

  ipcMain.handle('studio:update-check', check)
  ipcMain.handle('studio:update-download', async () => {
    await autoUpdater.downloadUpdate()
  })
  ipcMain.handle('studio:update-install', () => {
    autoUpdater.quitAndInstall()
  })

  if (app.isPackaged) setTimeout(() => void check(), 5000)
}
