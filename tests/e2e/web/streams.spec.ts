import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { go, nats, openStream, openStudio, toast, unique } from './helpers'

test('PBI-030 streams list: columns, search, filters and hidden bucket streams', async ({
  page
}) => {
  await openStudio(page)
  await go(page, 'Streams')
  const table = page.getByRole('table', { name: 'Streams' })
  for (const header of [
    'Name',
    'Subjects',
    'Storage',
    'Retention',
    'Replicas',
    'Messages',
    'Size',
    'Consumers',
    'First seq',
    'Last seq',
    'Last message'
  ]) {
    await expect(table.getByRole('columnheader', { name: header, exact: true })).toBeVisible()
  }
  const orders = table.getByRole('row').filter({ hasText: 'ORDERS' })
  await expect(orders).toContainText('orders.>')
  await expect(orders).toContainText('file')
  await expect(orders).toContainText('limits')

  // KV and Object Store streams are hidden until asked for.
  await expect(table.getByText('KV_app-config')).toHaveCount(0)
  await page.getByLabel(/Show KV and Object Store streams/).check()
  await expect(table.getByRole('button', { name: 'KV_app-config', exact: true })).toBeVisible()
  await page.getByLabel(/Show KV and Object Store streams/).uncheck()

  // Search matches names and subjects.
  await page.getByLabel('Search streams by name or subject').fill('telemetry.')
  await expect(table.getByRole('button', { name: 'TELEMETRY', exact: true })).toBeVisible()
  await expect(table.getByRole('button', { name: 'ORDERS', exact: true })).toHaveCount(0)
  await page.getByLabel('Search streams by name or subject').fill('')
  await page.getByLabel('Filter by retention').selectOption('workqueue')
  await expect(table.getByRole('row')).toHaveCount(2)
  await expect(table.getByRole('button', { name: 'JOBS', exact: true })).toBeVisible()
  await page.getByLabel('Filter by retention').selectOption('')

  // Sorting by a column.
  await table.getByRole('button', { name: 'Messages' }).click()
  await expect(table.getByRole('columnheader', { name: 'Messages' })).toHaveAttribute(
    'aria-sort',
    'ascending'
  )
})

test('PBI-124 a dragged column width keeps header and rows aligned and survives a reload', async ({
  page
}, testInfo) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await openStudio(page)
  await go(page, 'Streams')
  const table = page.getByRole('table', { name: 'Streams' })
  const header = table.getByRole('columnheader', { name: 'Name', exact: true })
  // The first column holds the row checkbox; Name is the second.
  const cell = table.getByRole('row').nth(1).getByRole('cell').nth(1)
  await expect(cell).toBeVisible()
  const width = async (l: typeof header): Promise<number> => (await l.boundingBox())!.width
  const before = await width(header)

  const handle = table.getByRole('separator', { name: 'Resize Name' })
  await header.hover()
  const box = (await handle.boundingBox())!
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + box.width / 2, y)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 120, y, { steps: 6 })
  await page.mouse.up()
  await expect.poll(() => width(header)).toBeGreaterThan(before + 100)
  const after = await width(header)
  expect(Math.abs((await width(cell)) - after)).toBeLessThan(1.5)
  expect((await cell.boundingBox())!.x).toBeCloseTo((await header.boundingBox())!.x, 0)
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.screenshot({ path: testInfo.outputPath('resized-dark.png') })
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.screenshot({ path: testInfo.outputPath('resized-light.png') })

  // Stored, so it is still there after a reload.
  await page.waitForTimeout(500) // the write goes over the socket without a visible signal
  await page.reload()
  await go(page, 'Streams')
  await expect.poll(() => width(header)).toBeCloseTo(after, 0)

  // Double-click resets it.
  await handle.dblclick()
  await expect.poll(() => width(header)).toBeCloseTo(before, 0)
})

test('PBI-031/032/033/035 create, inspect, edit, export, purge and delete a stream', async ({
  page
}) => {
  const name = unique('E2E')
  const { jsm, js, nc } = await nats()
  await openStudio(page)
  await go(page, 'Streams')

  // Create through the form, checking the JSON view stays in sync.
  await page.getByRole('button', { name: 'New stream' }).click()
  const form = page.getByRole('dialog', { name: 'New stream' })
  await form.getByRole('button', { name: 'Create stream' }).click()
  await expect(form.getByText('Name is required')).toBeVisible()
  await form.getByLabel('Name').fill(name)
  await form.getByLabel('Subjects').fill(`${name}.orders.*\n${name}.events.>`)
  await form.getByLabel('Max messages', { exact: true }).fill('500')
  await form.getByLabel('Max age').fill('1h30m')
  await form.getByLabel('Max bytes').fill('10MB')
  await form.getByRole('tab', { name: 'JSON' }).click()
  const json = JSON.parse(await form.getByLabel('Configuration as JSON').inputValue())
  expect(json).toMatchObject({
    name,
    subjects: [`${name}.orders.*`, `${name}.events.>`],
    max_msgs: 500,
    max_age: 5400e9,
    max_bytes: 10 * 1024 * 1024
  })
  await form
    .getByLabel('Configuration as JSON')
    .fill(JSON.stringify({ ...json, description: 'from the JSON view', max_msgs: 750 }))
  await form.getByRole('tab', { name: 'Form' }).click()
  await expect(form.getByLabel('Description')).toHaveValue('from the JSON view')
  await expect(form.getByLabel('Max messages', { exact: true })).toHaveValue('750')
  await form.getByRole('button', { name: 'Create stream' }).click()
  await expect(toast(page, `Created stream ${name}`)).toBeVisible()
  expect((await jsm.streams.info(name)).config).toMatchObject({
    max_msgs: 750,
    max_age: 5400e9,
    description: 'from the JSON view'
  })

  // The new stream opens; state and configuration are shown.
  for (let i = 1; i <= 12; i++)
    await js.publish(`${name}.orders.${i % 2 ? 'eu' : 'us'}`, JSON.stringify({ n: i }))
  await page.getByRole('button', { name: 'Refresh' }).click()
  await expect(page.locator('section').filter({ hasText: 'First sequence' })).toContainText('12')
  await page.getByRole('tab', { name: 'Configuration' }).click()
  await expect(page.getByTestId('stream-config-json')).toContainText(`"name": "${name}"`)

  // A server validation error is shown with its code; the dialog stays open.
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const edit = page.getByRole('dialog', { name: `Edit stream ${name}` })
  await expect(edit.getByLabel('Name')).toBeDisabled()
  await expect(edit.getByLabel('Storage')).toBeDisabled()
  await edit.getByLabel('Max age').fill('30s')
  await edit.getByRole('button', { name: 'Save changes' }).click()
  await expect(edit.getByRole('alert')).toContainText(
    /duplicates window can not be larger then max age \(JetStream error 10052\)/
  )
  await edit.getByLabel('Max age').fill('2h')
  await edit.getByLabel('Max messages', { exact: true }).fill('900')
  await edit.getByRole('button', { name: 'Save changes' }).click()
  await expect(toast(page, `Saved stream ${name}`)).toBeVisible()
  expect((await jsm.streams.info(name)).config).toMatchObject({ max_msgs: 900, max_age: 7200e9 })

  // Export produces a file that "nats stream add --config" can read.
  await page.getByRole('button', { name: 'Export', exact: true }).click()
  const download = page.waitForEvent('download')
  await page.getByRole('dialog').getByRole('button', { name: 'Export', exact: true }).click()
  const file = await download
  expect(file.suggestedFilename()).toBe(`${name}.stream.json`)
  expect(JSON.parse(readFileSync(await file.path(), 'utf8'))).toMatchObject({
    name,
    max_msgs: 900,
    subjects: [`${name}.orders.*`, `${name}.events.>`]
  })

  // Purge by subject needs the stream name typed, and reports how many went.
  await page.getByRole('button', { name: 'Purge', exact: true }).click()
  const purge = page.getByRole('dialog', { name: `Purge stream ${name}` })
  await expect(purge).toContainText('holds 12 messages')
  await purge.getByLabel('Messages on a subject').check()
  await purge.getByLabel('Subject', { exact: true }).fill(`${name}.orders.eu`)
  const confirm = purge.getByRole('button', { name: 'Purge messages' })
  await expect(confirm).toBeDisabled()
  await purge.getByLabel(/to confirm/).fill(name)
  await confirm.click()
  await expect(toast(page, `Purged 6 messages from ${name}`)).toBeVisible()
  expect((await jsm.streams.info(name)).state.messages).toBe(6)

  // Delete, again with the name typed.
  await page.getByRole('button', { name: 'Delete stream' }).click()
  const del = page.getByRole('dialog', { name: `Delete stream ${name}` })
  await expect(del.getByRole('button', { name: 'Delete stream' })).toBeDisabled()
  await del.getByLabel(/to confirm/).fill(name)
  await del.getByRole('button', { name: 'Delete stream' }).click()
  await expect(toast(page, `Deleted stream ${name}`)).toBeVisible()
  await expect(jsm.streams.info(name)).rejects.toThrow()
  await nc.close()
})

test('PBI-034 per-subject counts, filter, and jump to messages', async ({ page }) => {
  const name = unique('SUBJ')
  const { jsm, js, nc } = await nats()
  await jsm.streams.add({ name, subjects: [`${name}.>`] })
  for (let i = 0; i < 7; i++) await js.publish(`${name}.eu.created`, 'x')
  for (let i = 0; i < 3; i++) await js.publish(`${name}.us.created`, 'x')
  await js.publish(`${name}.eu.shipped`, 'x')

  await openStudio(page)
  await openStream(page, name, 'Subjects')
  const table = page.getByRole('table', { name: 'Subjects' })
  await expect(table.getByRole('row')).toHaveCount(4)
  await expect(table.getByRole('row').nth(1)).toContainText(`${name}.eu.created`)
  await expect(table.getByRole('row').nth(1)).toContainText('7')
  await expect(page.getByText('3 subjects')).toBeVisible()

  await page.getByLabel('Filter subjects').fill(`${name}.*.created`)
  await expect(table.getByRole('row')).toHaveCount(3)
  await page.getByLabel('Filter subjects').fill('bad..filter')
  await expect(page.getByText('Subject cannot have empty tokens')).toBeVisible()
  await page.getByLabel('Filter subjects').fill('')

  // Clicking a subject opens the message browser filtered to it.
  await table.getByRole('button', { name: `${name}.us.created`, exact: true }).click()
  await expect(page.getByLabel('Subject filter')).toHaveValue(`${name}.us.created`)
  await expect(page.getByTestId('message-range')).toContainText('3 messages')
  await jsm.streams.delete(name)
  await nc.close()
})
