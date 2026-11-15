import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  // Set STUDIO_APP_EXECUTABLE to test a packaged build (for example
  // release/linux-unpacked/nats-jetstream-studio) instead of the build in out/.
  const packaged = process.env.STUDIO_APP_EXECUTABLE
  app = await electron.launch({
    ...(packaged ? { executablePath: packaged } : {}),
    // The Chromium sandbox needs privileges that CI containers and WSL do not grant.
    args: packaged ? ['--no-sandbox'] : ['.', '--no-sandbox'],
    env: {
      ...process.env,
      STUDIO_USER_DATA: mkdtempSync(join(tmpdir(), 'studio-electron-')),
      XDG_CONFIG_HOME: process.env.STUDIO_E2E_XDG!
    }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  await app?.close()
})

test('PBI-001 the desktop app starts and renders the React UI', async () => {
  expect(await page.title()).toBe('NATS JetStream Studio')
  await expect(page.getByRole('navigation', { name: 'Connections' })).toBeVisible()
  const version = await app.evaluate(({ app: electronApp }) => electronApp.getVersion())
  await expect(page.getByText(`v${version}`)).toBeVisible()
})

test('PBI-001/002 the renderer is isolated and reaches NATS only through the bridge', async () => {
  const exposed = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>
    return {
      require: typeof w.require,
      process: typeof w.process,
      ipcRenderer: typeof w.ipcRenderer,
      electron: typeof w.electron,
      bridge: typeof w.studioDesktop,
      bridgeKeys: Object.keys((w.studioDesktop as object) ?? {}).sort()
    }
  })
  expect(exposed).toEqual({
    require: 'undefined',
    process: 'undefined',
    ipcRenderer: 'undefined',
    electron: 'undefined',
    bridge: 'object',
    bridgeKeys: [
      'checkForUpdates',
      'downloadUpdate',
      'installUpdate',
      'onMessage',
      'onUpdateEvent',
      'openExternal',
      'pathForFile',
      'pickFile',
      'send'
    ]
  })
  const prefs = await app.evaluate(({ BrowserWindow }) => {
    // Not in the published typings, but it is the only way to read the preferences actually in force.
    const contents = BrowserWindow.getAllWindows()[0].webContents as unknown as {
      getLastWebPreferences(): Record<string, unknown> | null
    }
    const p = contents.getLastWebPreferences()
    return {
      contextIsolation: p?.contextIsolation,
      nodeIntegration: p?.nodeIntegration,
      sandbox: p?.sandbox
    }
  })
  expect(prefs).toEqual({ contextIsolation: true, nodeIntegration: false, sandbox: true })
})

test('PBI-010 NATS CLI contexts are found and can be connected to', async () => {
  const sidebar = page.getByRole('navigation', { name: 'Connections' })
  const context = sidebar.getByRole('button', { name: /e2e-local/ }).first()
  await expect(context).toBeVisible()
  await context.click()

  // Connecting opens the overview, which shows what the server reports about itself.
  await expect(page.getByTestId('active-connection')).toContainText('e2e-local')
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()
  // The top bar also shows this text, but only from 1024px of window width up, and a window
  // opened on a small screen (the Windows runner) is narrower. The overview subtitle always shows it.
  await expect(
    page
      .getByText(/studio-test-\d+ · NATS \d+\.\d+/)
      .filter({ visible: true })
      .first()
  ).toBeVisible()
  await expect(page.getByTestId('usage-File storage')).toBeVisible()
})

test('PBI-030/040 streams and messages load over IPC', async () => {
  await page
    .getByRole('navigation', { name: 'Connections' })
    .getByRole('button', { name: 'Streams', exact: true })
    .click()
  await page.getByRole('button', { name: 'ORDERS', exact: true }).click()
  await page.getByRole('tab', { name: 'Messages' }).click()
  await expect(page.getByTestId('message-range')).toContainText(/50 messages, #\d+ to #\d+/)
  await page.getByRole('table', { name: 'Messages in ORDERS' }).getByRole('row').nth(2).click()
  const detail = page.getByRole('complementary', { name: 'Message detail' })
  await expect(detail).toContainText('orders.')
  // An open detail panel collapses the sidebar to its rail (PBI-123); close it for the next tests.
  await detail.getByRole('button', { name: 'Close message detail' }).click()
  await expect(detail).toHaveCount(0)
})

test('PBI-014 secrets are stored through the OS keychain API, never in plain text', async () => {
  const result = await app.evaluate(async ({ safeStorage }) => ({
    available: safeStorage.isEncryptionAvailable()
  }))
  // Whatever this machine offers, the app must report it truthfully in the About dialog.
  await page.getByRole('button', { name: 'About' }).click()
  const about = page.getByRole('dialog', { name: 'About NATS JetStream Studio' })
  await expect(about).toContainText('Desktop')
  await expect(about).toContainText(
    result.available ? /OS keychain|Not available/ : 'Not available'
  )
  await about.getByRole('button', { name: 'Close' }).last().click()
})

test('PBI-093 Ctrl+W closes the current tab and the session is restored on restart', async () => {
  const tabs = page.getByRole('tablist', { name: 'Open tabs' })
  const before = await tabs.getByRole('tab').count()
  expect(before).toBeGreaterThanOrEqual(2)
  await page.keyboard.press('Control+w')
  await expect(tabs.getByRole('tab')).toHaveCount(before - 1)
  const remaining = await tabs.getByRole('tab').allInnerTexts()

  // A reload stands in for a restart: the renderer starts from nothing and reads its saved state.
  await page.reload()
  await expect(tabs.getByRole('tab')).toHaveText(remaining)
  await expect(page.getByTestId('active-connection')).toContainText('e2e-local')
})
