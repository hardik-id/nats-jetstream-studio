import { expect, test } from '@playwright/test'
import { connection, go, nats, openStudio, sidebar, studioUrl, toast, unique } from './helpers'

test('PBI-003 empty state leads to a connection, and the shell shows where you are', async ({
  page
}) => {
  await page.goto(studioUrl())
  await expect(page.getByText('Nothing open')).toBeVisible()
  await expect(sidebar(page).getByRole('group')).toHaveCount(3)

  await openStudio(page)
  await go(page, 'Overview')
  const active = page.getByTestId('active-connection')
  await expect(active).toContainText('Local dev')
  await expect(active).toContainText('dev')
  await expect(active).toContainText(/studio-test-\d+ · NATS/)

  // Several resources open at once; tabs can be closed.
  await go(page, 'Streams')
  await go(page, 'Consumers')
  const tabs = page.getByRole('tablist', { name: 'Open tabs' })
  await expect(tabs.getByRole('tab')).toHaveText(['Overview', 'Streams', 'Consumers'])
  await expect(tabs.getByRole('tab', { name: 'Consumers' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await tabs.getByRole('button', { name: 'Close Streams' }).click()
  await expect(tabs.getByRole('tab')).toHaveText(['Overview', 'Consumers'])
  await tabs.getByRole('tab', { name: 'Overview' }).click()
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()
})

test('PBI-003 theme follows the system and can be overridden', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto(studioUrl())
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.getByRole('button', { name: 'Theme: system' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.getByRole('button', { name: 'Theme: light' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
})

test('PBI-003 the layout is usable at 1280 x 720', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await openStudio(page)
  await go(page, 'Streams')
  await expect(page.getByRole('button', { name: 'New stream' })).toBeInViewport()
  await expect(
    page
      .getByRole('table', { name: 'Streams' })
      .getByRole('button', { name: 'ORDERS', exact: true })
  ).toBeInViewport()
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth
  )
  expect(overflow).toBe(false)
})

test('PBI-011/012 add a connection: validation, test, save, edit, duplicate, delete', async ({
  page
}) => {
  const name = unique('conn')
  await page.goto(studioUrl())
  await sidebar(page).getByRole('button', { name: 'Add connection' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add connection' })

  // Required fields and URL validation are enforced before saving.
  await dialog.getByLabel('Server URLs').fill('http://example.com')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog.getByText('Name is required')).toBeVisible()
  await expect(dialog.getByText(/Unsupported scheme/)).toBeVisible()

  await dialog.getByLabel('Name').fill(name)
  await dialog.getByLabel('Server URLs').fill(process.env.NATS_E2E_URL!)
  await dialog.getByLabel('Method').selectOption('userpass')
  await dialog.getByLabel('User', { exact: true }).fill('app')
  await dialog.getByLabel('Password').fill('wrong-password')

  // Test without saving: a wrong password is named as such.
  await dialog.getByRole('button', { name: 'Test connection' }).click()
  await expect(
    dialog.getByText('Authentication failed: the server rejected these credentials')
  ).toBeVisible()
  await expect(connection(page, name)).toHaveCount(0)

  await dialog.getByLabel('Password').fill('app')
  await dialog.getByRole('button', { name: 'Test connection' }).click()
  await expect(
    dialog.getByText(
      /Connected to studio-test-\d+ \(NATS \d+\.\d+\.\d+\) in [\d.]+ ms\. JetStream is available\./
    )
  ).toBeVisible()

  await dialog.getByLabel('Environment').fill('test')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(toast(page, `Added "${name}"`)).toBeVisible()
  const group = connection(page, name)
  await expect(group).toContainText('test')

  // Connect, then edit: the password is not shown again, only that one is saved.
  await group
    .getByRole('button', { name: new RegExp(name) })
    .first()
    .click()
  await expect(group.getByRole('button', { name: 'Streams', exact: true })).toBeVisible()
  await group.getByRole('button', { name: `Actions for ${name}` }).click()
  await page.getByRole('menuitem', { name: 'Edit' }).click()
  const edit = page.getByRole('dialog', { name: `Edit connection: ${name}` })
  await expect(edit.getByLabel('Password')).toHaveValue('')
  await expect(edit.getByText('Saved. Leave empty to keep it.')).toBeVisible()
  await edit.getByLabel('Name').fill(`${name}-renamed`)
  await edit.getByRole('button', { name: 'Save' }).click()
  const renamed = connection(page, `${name}-renamed`)
  await expect(renamed).toBeVisible()

  await renamed.getByRole('button', { name: `Actions for ${name}-renamed` }).click()
  await page.getByRole('menuitem', { name: 'Duplicate' }).click()
  const copy = connection(page, `${name}-renamed copy`)
  await expect(copy).toBeVisible()

  for (const target of [`${name}-renamed copy`, `${name}-renamed`]) {
    await connection(page, target)
      .getByRole('button', { name: `Actions for ${target}` })
      .click()
    await page.getByRole('menuitem', { name: 'Delete' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Delete connection' }).click()
    await expect(connection(page, target)).toHaveCount(0)
  }
})

test('PBI-013/015 several connections at once, each independent, with status shown', async ({
  page
}) => {
  await openStudio(page)
  await openStudio(page, 'System')
  const dev = connection(page, 'Local dev')
  const sys = connection(page, 'System')
  await expect(dev.getByRole('img', { name: 'Connected' })).toBeVisible()
  await expect(sys.getByRole('img', { name: 'Connected' })).toBeVisible()

  // A tab belongs to one connection and says which.
  await go(page, 'Overview', 'System')
  await expect(page.getByTestId('active-connection')).toContainText('System')
  await go(page, 'Overview', 'Local dev')
  await expect(page.getByTestId('active-connection')).toContainText('Local dev')

  // Disconnecting one leaves the other working.
  await sys.getByRole('button', { name: 'Actions for System' }).click()
  await page.getByRole('menuitem', { name: 'Disconnect' }).click()
  await expect(sys.getByRole('img', { name: 'Not connected' })).toBeVisible()
  await expect(dev.getByRole('img', { name: 'Connected' })).toBeVisible()
  await go(page, 'Streams')
  await expect(
    page
      .getByRole('table', { name: 'Streams' })
      .getByRole('button', { name: 'ORDERS', exact: true })
  ).toBeVisible()
})

test('PBI-020/021/022 overview shows server, account usage and cluster for a system user', async ({
  page
}) => {
  await openStudio(page)
  await go(page, 'Overview')
  const server = page.locator('section').filter({ hasText: 'Server name' })
  await expect(server).toContainText(/studio-test-\d+/)
  await expect(server).toContainText('APP')
  await expect(server).toContainText('app')
  await expect(page.getByTestId('usage-File storage')).toContainText(/of unlimited|of \d/)
  await expect(page.getByTestId('usage-Streams')).toContainText(/\d+ of/)
  await expect(page.getByRole('meter', { name: 'Streams' })).toBeVisible()
  await expect(page.getByText(/Cluster details need a user in the system account/)).toBeVisible()

  await openStudio(page, 'System')
  await go(page, 'Overview', 'System')
  const cluster = page
    .getByRole('tabpanel')
    .filter({ hasText: 'JetStream meta leader' })
    .or(page.locator('section').filter({ hasText: 'JS streams' }))
    .first()
  await expect(cluster).toContainText(/studio-test-\d+/)
  // The system account has no JetStream of its own, and the page says so instead of failing.
  await expect(page.getByText('JetStream is not enabled for this account.')).toBeVisible()
  await connection(page, 'System').getByRole('button', { name: 'Actions for System' }).click()
  await page.getByRole('menuitem', { name: 'Disconnect' }).click()
})

test('PBI-016 a read-only connection blocks changes in the UI and on the server', async ({
  page
}) => {
  const { jsm, nc } = await nats()
  const before = (await jsm.streams.info('ORDERS')).state.messages
  await openStudio(page, 'Production')
  await expect(connection(page, 'Production').getByLabel('Read-only')).toBeVisible()
  await go(page, 'Streams', 'Production')
  await expect(page.getByTestId('active-connection')).toContainText('Read-only')

  const newStream = page.getByRole('button', { name: 'New stream' })
  await expect(newStream).toBeDisabled()
  await expect(newStream).toHaveAttribute('title', /read-only/)
  await page
    .getByRole('table', { name: 'Streams' })
    .getByRole('button', { name: 'JOBS', exact: true })
    .click()
  await page.getByRole('tab', { name: 'Configuration' }).click()
  for (const action of ['Edit', 'Purge', 'Delete stream'])
    await expect(page.getByRole('button', { name: action, exact: true })).toBeDisabled()

  await go(page, 'Publish', 'Production')
  await expect(
    page.getByText(/This connection is read-only, so publishing is blocked/)
  ).toBeVisible()
  await expect(
    page.locator('form').getByRole('button', { name: 'Publish', exact: true })
  ).toBeDisabled()

  // Reading still works.
  await go(page, 'Consumers', 'Production')
  await expect(
    page
      .getByRole('table', { name: 'Consumers' })
      .getByRole('button', { name: 'billing', exact: true })
  ).toBeVisible()
  expect((await jsm.streams.info('JOBS')).config.name).toBe('JOBS')
  expect((await jsm.streams.info('ORDERS')).state.messages).toBeGreaterThanOrEqual(before)
  await nc.close()
})

test('PBI-003 tabs can be reordered by dragging', async ({ page }) => {
  await openStudio(page)
  await go(page, 'Overview')
  await go(page, 'Streams')
  await go(page, 'Consumers')
  const tabs = page.getByRole('tablist', { name: 'Open tabs' })
  await expect(tabs.getByRole('tab')).toHaveText(['Overview', 'Streams', 'Consumers'])
  await tabs
    .getByRole('tab', { name: 'Consumers' })
    .dragTo(tabs.getByRole('tab', { name: 'Overview' }))
  await expect(tabs.getByRole('tab')).toHaveText(['Consumers', 'Overview', 'Streams'])
  // The order is part of the saved session.
  await page.reload()
  await expect(tabs.getByRole('tab')).toHaveText(['Consumers', 'Overview', 'Streams'])
})
