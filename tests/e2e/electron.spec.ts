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
  // The stream page sends you to the Messages screen of the connection (PBI-128).
  await page.getByRole('button', { name: 'Browse messages', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Stream', exact: true })).toHaveValue('ORDERS')
  await expect(page.getByTestId('message-range')).toContainText(/50 messages, #\d+ to #\d+/)
  await page.getByRole('table', { name: 'Messages in ORDERS' }).getByRole('row').nth(2).click()
  const detail = page.getByRole('complementary', { name: 'Message detail' })
  await expect(detail).toContainText('orders.')
  // An open detail panel collapses the sidebar to its rail (PBI-123); close it for the next tests.
  await detail.getByRole('button', { name: 'Close message detail' }).click()
  await expect(detail).toHaveCount(0)
})

test("PBI-138 the Trace Graph view loads and draws under the desktop app's CSP", async () => {
  const refused: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy|Refused to/.test(m.text()))
      refused.push(m.text())
  })
  await page
    .getByRole('navigation', { name: 'Connections' })
    .getByRole('button', { name: 'Trace', exact: true })
    .click()
  await page.getByRole('textbox', { name: 'Header name 1' }).fill('Region')
  await page.getByRole('textbox', { name: 'Value 1' }).fill('eu')
  await page.getByRole('button', { name: 'Run trace' }).click()
  await expect(page.getByRole('table', { name: 'Trace timeline' })).toBeVisible()
  // The view and the graph library are a chunk of their own, loaded now.
  await page.getByRole('combobox', { name: 'View' }).selectOption('graph')
  const graph = page.getByRole('application', { name: 'Trace graph' })
  await expect(graph.getByRole('img', { name: /^Subject orders\.eu\./ }).first()).toBeVisible()
  // The library's styles apply, themed with the app's colours.
  const colours = await graph.locator('.react-flow').evaluate((el) => ({
    position: getComputedStyle(el).position,
    background: getComputedStyle(el).getPropertyValue('--xy-background-color').trim(),
    bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
  }))
  expect(colours.position).toBe('relative')
  expect(colours.background).toBe(colours.bg)
  expect(refused).toEqual([])
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

test('#44 the application menu has editing and zoom, and no close-window item', async () => {
  const menu = await app.evaluate(({ Menu }) => {
    const out: { role: string; accelerator: string }[] = []
    const walk = (m: Electron.Menu | null | undefined): void => {
      for (const item of m?.items ?? []) {
        out.push({ role: String(item.role ?? ''), accelerator: String(item.accelerator ?? '') })
        walk(item.submenu)
      }
    }
    walk(Menu.getApplicationMenu())
    return out
  })
  const roles = menu.map((i) => i.role.toLowerCase())
  for (const role of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectall', 'zoomin', 'zoomout']) {
    expect(roles).toContain(role)
  }
  expect(roles).not.toContain('close')
  expect(roles).not.toContain('forcereload')
  expect(menu.some((i) => /^(Ctrl|Cmd|CommandOrControl)\+W$/i.test(i.accelerator))).toBe(false)
})
