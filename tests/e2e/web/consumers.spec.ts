import { expect, test } from '@playwright/test'
import { go, nats, openStream, openStudio, toast, unique } from './helpers'

test('PBI-050/051/054 consumers list, health and detail with lag', async ({ page }) => {
  await openStudio(page)
  await openStream(page, 'ORDERS', 'Consumers')
  const table = page.getByRole('table', { name: 'Consumers' })
  for (const header of [
    'Name',
    'Health',
    'Kind',
    'Type',
    'Filter subjects',
    'Ack policy',
    'Pending',
    'Ack pending',
    'Redelivered',
    'Waiting pulls',
    'Last active'
  ]) {
    await expect(table.getByRole('columnheader', { name: header, exact: true })).toBeVisible()
  }
  const billing = table
    .getByRole('row')
    .filter({ has: page.getByRole('button', { name: 'billing', exact: true }) })
  await expect(billing).toContainText('Durable')
  await expect(billing).toContainText('Pull')
  await expect(billing).toContainText('orders.*.paid')
  await expect(billing).toContainText('explicit')

  // The "audit" consumer never acknowledges: its window is full and messages are redelivered.
  const audit = table
    .getByRole('row')
    .filter({ has: page.getByRole('button', { name: 'audit', exact: true }) })
  await expect(audit).toContainText(/Ack pending at maximum/, { timeout: 20_000 })
  await page.getByLabel(/Unhealthy only/).check()
  await expect(table.getByRole('button', { name: 'audit', exact: true })).toBeVisible()
  await expect(table.getByRole('button', { name: 'billing', exact: true })).toHaveCount(0)
  await page.getByLabel(/Unhealthy only/).uncheck()

  // Search by filter subject.
  await page.getByLabel('Search consumers').fill('shipped')
  await expect(table.getByRole('row')).toHaveCount(2)
  await expect(table.getByRole('button', { name: 'shipping', exact: true })).toBeVisible()
  await page.getByLabel('Search consumers').fill('')

  // Detail: position, lag and a link to the next undelivered message.
  await table.getByRole('button', { name: 'audit', exact: true }).click()
  await expect(page.getByText(/Needs attention:.*Ack pending at maximum/)).toBeVisible()
  await expect(page.getByTestId('consumer-ack-pending')).toHaveText('20')
  const pending = Number((await page.getByTestId('consumer-pending').innerText()).replace(/,/g, ''))
  expect(pending).toBeGreaterThan(100)
  await expect(page.getByText(/stream #\d+ · consumer #\d+/).first()).toBeVisible()
  await expect(page.locator('pre').filter({ hasText: '"durable_name": "audit"' })).toBeVisible()

  await page.getByRole('button', { name: 'Show the next undelivered message' }).click()
  await expect(page.getByLabel('Start from')).toHaveValue('seq')
  const first = await page
    .getByRole('table', { name: 'Messages in ORDERS' })
    .getByRole('row')
    .nth(1)
    .getByRole('cell')
    .nth(1)
    .innerText()
  expect(Number(first)).toBe(21)

  // The overview counts unhealthy consumers and links to them.
  await go(page, 'Overview')
  const health = page.locator('section').filter({ hasText: 'Consumer health' })
  await expect(health).toContainText(/need attention/)
  await expect(health.getByRole('button', { name: 'ORDERS / audit' })).toBeVisible()

  // All consumers of the connection in one list.
  await go(page, 'Consumers')
  const all = page.getByRole('table', { name: 'Consumers' })
  await expect(all.getByRole('columnheader', { name: 'Stream', exact: true })).toBeVisible()
  for (const name of ['analytics', 'audit', 'billing', 'shipping', 'worker'])
    await expect(all.getByRole('button', { name, exact: true })).toBeVisible()
})

test('PBI-052/053 create, edit, pause, resume and delete a consumer', async ({ page }) => {
  const stream = unique('CONS')
  const { jsm, js, nc } = await nats()
  await jsm.streams.add({ name: stream, subjects: [`${stream}.>`] })
  for (let i = 0; i < 8; i++) await js.publish(`${stream}.${i % 2 ? 'odd' : 'even'}`, 'm')

  await openStudio(page)
  await openStream(page, stream, 'Consumers')
  await expect(page.getByText('This stream has no consumers')).toBeVisible()
  await page.getByRole('button', { name: 'New consumer' }).click()
  const form = page.getByRole('dialog', { name: `New consumer on ${stream}` })

  await form.getByRole('button', { name: 'Create consumer' }).click()
  await expect(form.getByText('A durable consumer needs a name')).toBeVisible()
  await form.getByLabel('Name').fill('e2e-worker')
  await form.getByLabel('Description').fill('made by the e2e test')
  await form.getByLabel('Filter subjects').fill(`${stream}.odd`)
  await form.getByLabel('Ack wait').fill('45s')
  await form.getByLabel('Max deliveries').fill('5')
  await form.getByLabel('Backoff').fill('1s, 5s')

  // The JSON view shows exactly what will be sent.
  await form.getByRole('tab', { name: 'JSON' }).click()
  const sent = JSON.parse(await form.getByLabel('Configuration as JSON').inputValue())
  expect(sent).toMatchObject({
    name: 'e2e-worker',
    durable_name: 'e2e-worker',
    filter_subject: `${stream}.odd`,
    ack_wait: 45e9,
    max_deliver: 5,
    backoff: [1e9, 5e9],
    ack_policy: 'explicit'
  })
  await form.getByRole('tab', { name: 'Form' }).click()
  await form.getByRole('button', { name: 'Create consumer' }).click()
  await expect(toast(page, 'Created consumer e2e-worker')).toBeVisible()

  // The new consumer opens; only the odd subject is pending.
  await expect(page.getByTestId('consumer-pending')).toHaveText('4')
  expect((await jsm.consumers.info(stream, 'e2e-worker')).config).toMatchObject({
    filter_subject: `${stream}.odd`,
    max_deliver: 5,
    description: 'made by the e2e test'
  })

  // Edit: fixed fields are disabled; a change is saved.
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const edit = page.getByRole('dialog', { name: 'Edit consumer e2e-worker' })
  await expect(edit.getByLabel('Name')).toBeDisabled()
  await expect(edit.getByLabel('Ack policy')).toBeDisabled()
  await expect(edit.getByLabel('Start delivering from')).toBeDisabled()
  await edit.getByLabel('Max ack pending').fill('250')
  await edit.getByRole('button', { name: 'Save changes' }).click()
  await expect(toast(page, 'Saved consumer e2e-worker')).toBeVisible()
  expect((await jsm.consumers.info(stream, 'e2e-worker')).config.max_ack_pending).toBe(250)

  // Pause until a time, shown in the detail; then resume.
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  const pause = page.getByRole('dialog', { name: 'Pause consumer e2e-worker' })
  await pause.getByRole('button', { name: '1h', exact: true }).click()
  await pause.getByRole('button', { name: 'Pause', exact: true }).click()
  await expect(page.getByText(/Delivery is paused until .* remaining\)\./)).toBeVisible()
  expect((await jsm.consumers.info(stream, 'e2e-worker')).paused).toBe(true)
  await page.getByRole('button', { name: 'Resume', exact: true }).click()
  await expect(toast(page, 'Resumed consumer e2e-worker')).toBeVisible()
  expect((await jsm.consumers.info(stream, 'e2e-worker')).paused).toBeFalsy()

  // Delete needs the name typed.
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  const del = page.getByRole('dialog', { name: 'Delete consumer e2e-worker' })
  await expect(del).toContainText('4 messages are still pending')
  await del.getByLabel(/to confirm/).fill('e2e-worker')
  await del.getByRole('button', { name: 'Delete consumer' }).click()
  await expect(toast(page, 'Deleted consumer e2e-worker')).toBeVisible()
  await expect(jsm.consumers.info(stream, 'e2e-worker')).rejects.toThrow()
  await jsm.streams.delete(stream)
  await nc.close()
})
