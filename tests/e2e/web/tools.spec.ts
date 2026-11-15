import { readFileSync, writeFileSync } from 'node:fs'
import * as protobuf from 'protobufjs'
import { expect, test } from '@playwright/test'
import { connection, go, nats, openStream, openStudio, sidebar, toast, unique } from './helpers'

test('PBI-090 command palette: search across resources, grouped, Enter opens', async ({ page }) => {
  await openStudio(page)
  await page.keyboard.press('Control+k')
  const palette = page.getByRole('dialog', { name: 'Search' })
  const input = palette.getByRole('combobox')
  await expect(input).toBeFocused()

  // Before typing: navigation and actions.
  await expect(palette.getByRole('option', { name: /Add connection/ })).toBeVisible()

  await input.fill('orders')
  const options = palette.getByRole('option')
  await expect(options.first()).toContainText('ORDERS')
  await expect(options.first()).toContainText('Local dev')
  await expect(palette.getByText('Streams', { exact: true })).toBeVisible()
  // Consumers of that stream are found through the stream name too.
  await expect(palette.getByText('Consumers', { exact: true })).toBeVisible()
  await expect(palette.getByRole('option', { name: /billing/ }).first()).toBeVisible()

  // Fuzzy: letters in order, not necessarily adjacent.
  await input.fill('appcfg')
  await expect(options.first()).toContainText('app-config')
  await input.fill('zzzz-nothing')
  await expect(palette.getByText('No matches for “zzzz-nothing”')).toBeVisible()

  // Arrow keys move, Enter opens in a tab.
  await input.fill('artifacts')
  await expect(options.first()).toContainText('artifacts')
  await input.press('Enter')
  await expect(palette).toHaveCount(0)
  await expect(
    page.getByRole('tablist', { name: 'Open tabs' }).getByRole('tab', { name: 'artifacts' })
  ).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('table', { name: 'Objects' })).toBeVisible()

  await page.keyboard.press('Control+k')
  await input.fill('ship')
  await input.press('ArrowDown')
  await input.press('ArrowUp')
  await input.press('Enter')
  await expect(page.getByTestId('consumer-pending')).toBeVisible()

  // Actions are included, and Escape closes.
  await page.keyboard.press('Control+k')
  await input.fill('keyboard')
  await input.press('Enter')
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+k')
  await page.keyboard.press('Escape')
  await expect(palette).toHaveCount(0)
})

test('PBI-093 keyboard navigation, help overlay and session restore', async ({ page }) => {
  await openStudio(page)
  await go(page, 'Streams')
  const table = page.getByRole('table', { name: 'Streams' })
  await expect(table.getByRole('button', { name: 'ORDERS', exact: true })).toBeVisible()

  // Tables work from the keyboard: arrows move, Enter opens.
  await table.focus()
  await page.keyboard.press('ArrowDown')
  await expect(table.getByRole('row', { selected: true })).toContainText('EVENTS')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(table.getByRole('row', { selected: true })).toContainText('ORDERS')
  await page.keyboard.press('Home')
  await expect(table.getByRole('row', { selected: true })).toContainText('EVENTS')
  await page.keyboard.press('End')
  await expect(table.getByRole('row', { selected: true })).toContainText('TELEMETRY')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Enter')
  await expect(
    page.getByRole('tablist', { name: 'Open tabs' }).getByRole('tab', { name: 'ORDERS' })
  ).toHaveAttribute('aria-selected', 'true')

  // "?" lists the shortcuts, but not while typing in a field.
  await page.getByRole('tab', { name: 'Messages' }).click()
  await page.getByLabel('Subject filter').fill('?')
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toHaveCount(0)
  await page.getByLabel('Subject filter').fill('orders.eu.>')
  await page.getByRole('button', { name: 'Apply', exact: true }).click()
  await page.getByRole('table', { name: 'Messages in ORDERS' }).focus()
  await page.keyboard.press('?')
  const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
  await expect(help).toContainText('Search streams, consumers and buckets')
  await expect(help).toContainText('Close the current tab')
  await page.keyboard.press('Escape')
  await expect(help).toHaveCount(0)

  // Ctrl+Tab cycles through tabs.
  await page.keyboard.press('Control+Tab')
  await expect(
    page.getByRole('tablist', { name: 'Open tabs' }).getByRole('tab', { name: 'Streams' })
  ).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Control+Shift+Tab')
  await expect(
    page.getByRole('tablist', { name: 'Open tabs' }).getByRole('tab', { name: 'ORDERS' })
  ).toHaveAttribute('aria-selected', 'true')

  // After a restart the tabs, the active tab and its section come back.
  await page.reload()
  const tabs = page.getByRole('tablist', { name: 'Open tabs' })
  await expect(tabs.getByRole('tab')).toHaveText(['Streams', 'ORDERS'])
  await expect(tabs.getByRole('tab', { name: 'ORDERS' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tab', { name: 'Messages' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('message-range')).toContainText('50 messages')
  await expect(page.getByTestId('active-connection')).toContainText('Local dev')
})

test('PBI-091 favourites and saved filters persist, export and import', async ({
  page
}, testInfo) => {
  await openStudio(page)
  await go(page, 'Streams')
  const table = page.getByRole('table', { name: 'Streams' })
  const row = table
    .getByRole('row')
    .filter({ has: page.getByRole('button', { name: 'JOBS', exact: true }) })
  await row.getByRole('button', { name: 'Add to favourites' }).click()
  const group = connection(page, 'Local dev')
  await expect(group.getByText('Favourites')).toBeVisible()
  await expect(group.getByRole('button', { name: 'JOBS', exact: true })).toBeVisible()

  // A consumer and a subject can be starred as well.
  await openStream(page, 'ORDERS', 'Consumers')
  const billing = page
    .getByRole('table', { name: 'Consumers' })
    .getByRole('row')
    .filter({ has: page.getByRole('button', { name: 'billing', exact: true }) })
  await billing.getByRole('button', { name: 'Add to favourites' }).click()
  await expect(group.getByRole('button', { name: 'ORDERS / billing' })).toBeVisible()

  // Saved filter.
  await page.getByRole('tab', { name: 'Messages' }).click()
  await page.getByLabel('Subject filter').fill('orders.eu.paid')
  await page.getByRole('button', { name: 'Apply', exact: true }).click()
  await page.getByRole('button', { name: 'Saved' }).click()
  await page.getByRole('menuitem', { name: 'Save current filters...' }).click()
  await page.getByRole('dialog', { name: 'Save filters' }).getByLabel('Name').fill('EU paid')
  await page
    .getByRole('dialog', { name: 'Save filters' })
    .getByRole('button', { name: 'Save' })
    .click()
  await expect(toast(page, 'Saved filter "EU paid"')).toBeVisible()
  await page
    .getByLabel('Active filters')
    .getByRole('button', { name: /Remove filter: Subject/ })
    .click()
  await expect(page.getByLabel('Subject filter')).toHaveValue('')

  // Both survive a restart and work from the sidebar and the menu.
  await page.reload()
  await expect(group.getByRole('button', { name: 'JOBS', exact: true })).toBeVisible()
  await group.getByRole('button', { name: 'ORDERS / billing' }).click()
  await expect(page.getByTestId('consumer-pending')).toBeVisible()
  await page
    .getByRole('tablist', { name: 'Open tabs' })
    .getByRole('tab', { name: 'ORDERS' })
    .click()
  await page.getByRole('button', { name: 'Saved' }).click()
  await page.getByRole('menuitem', { name: 'EU paid' }).click()
  await expect(page.getByLabel('Subject filter')).toHaveValue('orders.eu.paid')
  await expect(page.getByLabel('Active filters')).toContainText('Subject orders.eu.paid')

  // Export both to a file.
  const exportItem = page.getByRole('menuitem', { name: 'Export filters and favourites...' })
  const importItem = page.getByRole('menuitem', { name: 'Import filters and favourites...' })
  await page.getByRole('button', { name: 'Saved' }).click()
  const download = page.waitForEvent('download')
  await exportItem.click()
  // The confirmation goes away by itself after a few seconds, so it is checked first, before
  // the download is saved and read.
  await expect(toast(page, 'Exported 1 saved filter and 2 favourites')).toBeVisible()
  const exported = await download
  expect(exported.suggestedFilename()).toBe('saved-filters-Local_dev.json')
  const file = testInfo.outputPath('saved-filters-Local_dev.json')
  await exported.saveAs(file)
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
    version: 1,
    savedFilters: [{ name: 'EU paid', subject: 'orders.eu.paid', filters: {} }],
    favorites: [
      { kind: 'stream', stream: 'JOBS' },
      { kind: 'consumer', stream: 'ORDERS', consumer: 'billing' }
    ]
  })

  // Starts on the Messages tab of ORDERS and leaves no saved filter and no favourite behind.
  const removeEverything = async (): Promise<void> => {
    await page.getByRole('button', { name: 'Saved' }).click()
    await page.getByRole('menuitem', { name: 'Remove all saved filters' }).click()
    await page.getByRole('tab', { name: 'Consumers', exact: true }).click()
    await billing.getByRole('button', { name: 'Remove from favourites' }).click()
    await go(page, 'Streams')
    await row.getByRole('button', { name: 'Remove from favourites' }).click()
    await expect(group.getByText('Favourites')).toHaveCount(0)
  }
  await removeEverything()
  await openStream(page, 'ORDERS', 'Messages')
  await page
    .getByLabel('Active filters')
    .getByRole('button', { name: /Remove filter: Subject/ })
    .click()
  await expect(page.getByLabel('Subject filter')).toHaveValue('')
  await page.getByRole('button', { name: 'Saved' }).click()
  await expect(page.getByRole('menuitem', { name: 'EU paid' })).toHaveCount(0)
  await expect(exportItem).toBeDisabled()
  await expect(exportItem).toHaveAttribute(
    'title',
    'There are no saved filters or favourites to export'
  )

  // A file that is not a valid export is refused with the reason, and nothing of it is taken.
  const broken = testInfo.outputPath('broken.json')
  writeFileSync(
    broken,
    JSON.stringify({
      version: 1,
      savedFilters: [{ name: 'Broken', subject: 'orders..paid', filters: {} }],
      favorites: [{ kind: 'stream', stream: 'JOBS' }]
    })
  )
  const refusedChooser = page.waitForEvent('filechooser')
  await importItem.click()
  await (await refusedChooser).setFiles(broken)
  const refused = page.getByRole('alert').filter({
    hasText: 'Saved filter "Broken" has an invalid subject. Subject cannot have empty tokens.'
  })
  await expect(refused).toBeVisible()
  await refused.getByRole('button', { name: 'Dismiss' }).click()
  await expect(group.getByText('Favourites')).toHaveCount(0)
  await page.getByRole('button', { name: 'Saved' }).click()
  await expect(page.getByRole('menuitem', { name: 'Broken' })).toHaveCount(0)
  await expect(exportItem).toBeDisabled()

  // Importing the exported file brings the saved filter and the favourites back.
  const chooser = page.waitForEvent('filechooser')
  await importItem.click()
  await (await chooser).setFiles(file)
  await expect(toast(page, 'Imported 1 saved filter and 2 favourites')).toBeVisible()
  await expect(group.getByRole('button', { name: 'JOBS', exact: true })).toBeVisible()
  await expect(group.getByRole('button', { name: 'ORDERS / billing' })).toBeVisible()

  // What was imported is stored, not only shown: it is still there after a restart.
  await page.reload()
  await expect(group.getByRole('button', { name: 'JOBS', exact: true })).toBeVisible()
  await expect(group.getByRole('button', { name: 'ORDERS / billing' })).toBeVisible()
  await page
    .getByRole('tablist', { name: 'Open tabs' })
    .getByRole('tab', { name: 'ORDERS' })
    .click()
  await page.getByRole('button', { name: 'Saved' }).click()
  await page.getByRole('menuitem', { name: 'EU paid' }).click()
  await expect(page.getByLabel('Subject filter')).toHaveValue('orders.eu.paid')
  await expect(page.getByLabel('Active filters')).toContainText('Subject orders.eu.paid')

  // Clean up so other tests start from the same state.
  await removeEverything()
})

test('PBI-092 audit log records changes and exports CSV', async ({ page }) => {
  const name = unique('AUD')
  await openStudio(page)
  await go(page, 'Streams')
  await page.getByRole('button', { name: 'New stream' }).click()
  const form = page.getByRole('dialog', { name: 'New stream' })
  await form.getByLabel('Name').fill(name)
  await form.getByLabel('Subjects').fill(`${name}.>`)
  await form.getByRole('button', { name: 'Create stream' }).click()
  await expect(toast(page, `Created stream ${name}`)).toBeVisible()
  await page.getByRole('tab', { name: 'Configuration' }).click()
  await page.getByRole('button', { name: 'Delete stream' }).click()
  const del = page.getByRole('dialog', { name: `Delete stream ${name}` })
  await del.getByLabel(/to confirm/).fill(name)
  await del.getByRole('button', { name: 'Delete stream' }).click()
  await expect(toast(page, `Deleted stream ${name}`)).toBeVisible()

  await go(page, 'Audit log')
  const table = page.getByRole('table', { name: 'Audit log' })
  await page.getByLabel('Search', { exact: true }).fill(name)
  await expect(table.getByRole('row')).toHaveCount(3)
  await expect(table.getByRole('row').nth(1)).toContainText('stream.delete')
  await expect(table.getByRole('row').nth(1)).toContainText('done')
  await expect(table.getByRole('row').nth(2)).toContainText('stream.create')
  await expect(table.getByRole('row').nth(2)).toContainText('Local dev')
  await page.getByLabel('Result').selectOption('error')
  await expect(page.getByText(/Nothing recorded yet/)).toBeVisible()
  await page.getByLabel('Result').selectOption('')

  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export CSV' }).click()
  const csv = readFileSync(await (await download).path(), 'utf8')
  expect(csv.split('\n')[0]).toBe('"time","connection","action","target","result","detail","user"')
  expect(csv).toContain(`"stream.create","${name}","ok"`)
  expect(csv).toContain(`"stream.delete","${name}","ok"`)
})

test('PBI-080/081 charts and alerts', async ({ page }) => {
  const stream = unique('ALERT')
  const { jsm, js, nc } = await nats()
  await jsm.streams.add({ name: stream, subjects: [`${stream}.>`] })
  await jsm.consumers.add(stream, { durable_name: 'slow', ack_policy: 'explicit' as never })
  await openStudio(page)

  // A rule: pending above 3 on this stream's consumers.
  await go(page, 'Alerts')
  await page.getByRole('button', { name: 'New rule' }).click()
  const rule = page.getByRole('dialog', { name: 'New alert rule' })
  await rule.getByLabel('Name').fill('Slow consumer')
  await rule.getByLabel('Stream').fill(stream)
  await rule.getByLabel(/Fire above/).fill('3')
  await rule.getByLabel(/For at least/).fill('0')
  await rule.getByRole('button', { name: 'Save rule' }).click()
  await expect(
    page.getByText(`Consumer pending messages above 3 on any consumer of ${stream}`)
  ).toBeVisible()
  await expect(page.getByText('No alerts have fired since the studio started.')).toBeVisible()

  for (let i = 0; i < 6; i++) await js.publish(`${stream}.x`, 'm')
  await expect(toast(page, /Alert: Slow consumer: .* > slow is at 6 \(threshold 3\)/)).toBeVisible({
    timeout: 15_000
  })
  const fired = page.locator('section').filter({ hasText: 'Fired this session' })
  await expect(fired.getByRole('row').filter({ hasText: 'Slow consumer' })).toContainText(
    `${stream} > slow`
  )

  // Snooze and switch off.
  await page.getByLabel('Snooze Slow consumer').selectOption({ label: '1 hour' })
  await expect(page.getByText(/snoozed until/)).toBeVisible()
  await page.getByRole('button', { name: 'End snooze' }).click()
  await expect(page.getByText(/snoozed until/)).toHaveCount(0)
  await page.getByLabel('On', { exact: true }).uncheck()
  await expect(page.locator('li').filter({ hasText: 'Slow consumer' })).toContainText('off')

  // Health thresholds can be changed and reset.
  const health = page.locator('section').filter({ hasText: 'Consumer health thresholds' })
  await health.getByLabel('Many redeliveries').fill('7')
  await health.getByRole('button', { name: 'Save thresholds' }).click()
  await expect(toast(page, 'Saved health thresholds')).toBeVisible()
  await health.getByRole('button', { name: 'Reset to defaults' }).click()
  await expect(health.getByLabel('Many redeliveries')).toHaveValue('100')

  // Charts: three measures, a range switch, and a table view of the same numbers.
  await openStream(page, stream)
  const activity = page.locator('section').filter({ hasText: 'Activity' })
  await expect(activity.locator('figure')).toHaveCount(3)
  await expect(activity.locator('figure').nth(1)).toContainText('Messages stored')
  await expect(activity.locator('figure').nth(1).locator('svg path').first()).toBeVisible({
    timeout: 15_000
  })
  await expect(activity.locator('figure').nth(1).getByTestId('chart-latest')).toHaveText('6')
  await activity.getByRole('button', { name: '1 hour' }).click()
  await expect(activity.getByRole('button', { name: '1 hour' })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  // The crosshair reads values from the keyboard too.
  await activity.getByRole('img', { name: /Messages stored/ }).focus()
  await page.keyboard.press('ArrowLeft')
  await expect(activity.locator('figure').nth(1).getByTestId('chart-latest')).toContainText(
    /at \d\d:\d\d:\d\d/
  )
  await activity.getByRole('button', { name: 'Table' }).click()
  await expect(activity.getByRole('columnheader', { name: 'Messages per second' })).toBeVisible()
  await expect(activity.getByRole('row').nth(1)).toContainText('6')

  await go(page, 'Alerts')
  await page.getByRole('button', { name: 'Delete rule Slow consumer' }).click()
  await expect(page.getByText(/No rules yet/)).toBeVisible()
  await jsm.streams.delete(stream)
  await nc.close()
})

test('PBI-044 Protobuf payloads are decoded with registered .proto files', async ({
  page
}, testInfo) => {
  const stream = unique('PROTO')
  const proto = `syntax = "proto3";\npackage shop;\nenum Status { UNKNOWN = 0; PAID = 1; }\nmessage Order { string id = 1; int64 total_cents = 2; Status status = 3; repeated string tags = 4; }\n`
  const root = protobuf.parse(proto, { keepCase: true }).root
  const Order = root.lookupType('shop.Order')
  const bytes = Order.encode(
    Order.fromObject({ id: 'A-77', total_cents: 12345, status: 1, tags: ['gift', 'eu'] })
  ).finish()
  const { jsm, js, nc } = await nats()
  await jsm.streams.add({ name: stream, subjects: [`${stream}.>`] })
  await js.publish(`${stream}.orders.created`, bytes)
  await js.publish(
    `${stream}.orders.created`,
    'this is not protobuf at all, just text that will not parse'
  )
  await js.publish(`${stream}.other`, bytes)

  await openStudio(page)
  await go(page, 'Decoders')
  const file = testInfo.outputPath('order.proto')
  writeFileSync(file, proto)
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Add .proto file' }).click()
  await (await chooser).setFiles(file)
  await expect(toast(page, 'Added order.proto')).toBeVisible()
  await expect(page.getByText(/1 message type: shop\.Order/)).toBeVisible()

  await page.getByRole('button', { name: 'Add mapping' }).click()
  await page.getByLabel('Mapping 1 subject').fill(`${stream}.orders.>`)
  await expect(page.getByLabel('Mapping 1 message type')).toHaveValue('shop.Order')

  // A matching subject is shown decoded by default.
  await openStream(page, stream, 'Messages')
  const table = page.getByRole('table', { name: `Messages in ${stream}` })
  const detail = page.getByRole('complementary', { name: 'Message detail' })
  await table
    .getByRole('row')
    .filter({ has: page.getByLabel('Select message 1', { exact: true }) })
    .click()
  await expect(detail.getByRole('tab', { name: 'Protobuf shop.Order' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  const body = detail.getByTestId('payload-body')
  await expect(body).toContainText('"A-77"')
  await expect(body).toContainText('12345')
  await expect(body).toContainText('"PAID"')
  await expect(body).toContainText('"gift"')

  // A payload that is not that type falls back to hex and says why.
  await table
    .getByRole('row')
    .filter({ has: page.getByLabel('Select message 2', { exact: true }) })
    .click()
  await expect(detail.getByRole('tab', { name: 'Text' })).toHaveAttribute('aria-selected', 'true')
  await detail.getByRole('tab', { name: 'Protobuf shop.Order' }).click()
  await expect(detail.getByText(/Protobuf shop\.Order could not decode this payload/)).toBeVisible()

  // A subject without a mapping gets no decoder.
  await table
    .getByRole('row')
    .filter({ has: page.getByLabel('Select message 3', { exact: true }) })
    .click()
  await expect(detail.getByRole('tab', { name: 'Protobuf shop.Order' })).toHaveCount(0)
  await expect(detail.getByRole('tab', { name: 'Hex' })).toHaveAttribute('aria-selected', 'true')

  // Remove the registration again. An open detail panel collapses the sidebar to its rail
  // (PBI-123), so close it first.
  await detail.getByRole('button', { name: 'Close message detail' }).click()
  await go(page, 'Decoders')
  await page.getByRole('button', { name: 'Remove mapping 1' }).click()
  await page.getByRole('button', { name: 'Remove order.proto' }).click()
  await expect(page.getByText(/Add the \.proto files that define your messages/)).toBeVisible()
  await jsm.streams.delete(stream)
  await nc.close()
  expect(sidebar(page)).toBeTruthy()
})
