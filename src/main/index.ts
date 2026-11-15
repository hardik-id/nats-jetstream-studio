import { app, shell, BrowserWindow, dialog, ipcMain, type WebContents } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import natsPkg from '@nats-io/transport-node/package.json'
import icon from '../../resources/icon.png?asset'
import { cliContextDir } from '@core/cliContexts'
import { RpcSession } from '@core/rpcSession'
import { StudioService } from '@core/service'
import type { PickFileOptions } from '@shared/desktop'
import type { ClientMessage } from '@shared/rpc'
import { SafeStorageSecretStore } from './secretStore'
import { setupUpdater } from './updater'

let mainWindow: BrowserWindow | null = null
let service: StudioService | undefined
const sessions = new Map<number, RpcSession>()

// A separate data folder lets tests and side-by-side installs run without touching real settings.
if (process.env.STUDIO_USER_DATA) app.setPath('userData', process.env.STUDIO_USER_DATA)

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    // Sizes below are content sizes: on small Windows screens the frame must not eat into 1024 px.
    useContentSize: true,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: 'NATS JetStream Studio',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // The UI is an ordinary web page: no Node, no Electron APIs, only what the preload exposes.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Links never open inside the app window.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (/^https?:\/\//i.test(details.url)) void shell.openExternal(details.url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow?.webContents.getURL()) event.preventDefault()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function isAppWindow(contents: WebContents): boolean {
  return mainWindow !== null && contents.id === mainWindow.webContents.id
}

function sessionFor(contents: WebContents): RpcSession {
  let session = sessions.get(contents.id)
  if (!session) {
    session = new RpcSession(service!, (message) => {
      if (!contents.isDestroyed()) contents.send('studio:rpc', message)
    })
    sessions.set(contents.id, session)
    const dispose = (): void => {
      sessions.get(contents.id)?.dispose()
      sessions.delete(contents.id)
    }
    contents.once('destroyed', dispose)
    // A reload starts a new page whose stream ids start over, so the old streams must go.
    contents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) dispose()
    })
  }
  return session
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  void app.whenReady().then(() => {
    electronApp.setAppUserModelId('io.github.nats-jetstream-studio')
    app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

    service = new StudioService({
      dataDir: app.getPath('userData'),
      secretStore: new SafeStorageSecretStore(),
      cliContextDir: cliContextDir(),
      mode: 'desktop',
      appVersion: app.getVersion(),
      natsClientVersion: natsPkg.version
    })

    ipcMain.on('studio:rpc', (event, message: ClientMessage) => {
      if (!isAppWindow(event.sender)) return
      sessionFor(event.sender).handle(message)
    })

    ipcMain.handle('studio:pick-file', async (event, options: PickFileOptions | undefined) => {
      if (!isAppWindow(event.sender) || !mainWindow) return null
      const result = await dialog.showOpenDialog(mainWindow, {
        title: typeof options?.title === 'string' ? options.title : 'Choose a file',
        properties: ['openFile', 'showHiddenFiles'],
        filters: Array.isArray(options?.filters) ? options.filters : undefined
      })
      return result.canceled ? null : (result.filePaths[0] ?? null)
    })

    ipcMain.handle('studio:open-external', async (event, url: unknown) => {
      if (!isAppWindow(event.sender)) return
      if (typeof url === 'string' && /^https:\/\//i.test(url)) await shell.openExternal(url)
    })

    setupUpdater(() => mainWindow)
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  let disposing = false
  app.on('before-quit', (event) => {
    if (disposing || !service) return
    // Close NATS connections cleanly before the process exits.
    disposing = true
    event.preventDefault()
    void service.dispose().finally(() => app.quit())
  })
}
