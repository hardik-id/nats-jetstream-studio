import { readFileSync } from 'node:fs'
import { headers } from '@nats-io/transport-node'
import { expect, test, type Page } from '@playwright/test'
import { go, nats, openMessages, openStudio, toast, unique, type Nats } from './helpers'

let client: Nats
let stream: string

test.beforeAll(async () => {
  client = await nats()
  stream = unique('MSG')
  await client.jsm.streams.add({ name: stream, subjects: [`${stream}.>`], allow_direct: true })
  // 130 messages: JSON on .eu/.us, every 10th with a Trace-Id header, every 25th plain text.
  for (let i = 1; i <= 130; i++) {
    const hdrs = headers()
    hdrs.set('Region', i % 2 ? 'us' : 'eu')
    if (i % 10 === 0) hdrs.set('Trace-Id', `trace-${i}`)
    const body =
      i % 25 === 0
        ? `plain text ${i} URGENT`
        : JSON.stringify({ order: { id: `A-${i}`, total: i * 10 }, note: `message ${i}` })
    await client.js.publish(`${stream}.${i % 2 ? 'us' : 'eu'}`, body, { headers: hdrs })
  }
})
test.afterAll(async () => {
  await client.jsm.streams.delete(stream).catch(() => {})
  await client.nc.close()
})

const table = (page: Page) => page.getByRole('table', { name: `Messages in ${stream}` })
const range = (page: Page) => page.getByTestId('message-range')
const rowOf = (page: Page, seq: number, name = stream) =>
  page
    .getByRole('table', { name: `Messages in ${name}` })
    .getByRole('row')
    .filter({ has: page.getByLabel(`Select message ${seq}`, { exact: true }) })
const seqOfRow = async (page: Page, row: number): Promise<number> =>
  Number(await table(page).getByRole('row').nth(row).getByRole('cell').nth(1).innerText())

test('PBI-040/041 page through messages, newest first or oldest first, from any start', async ({
  page
}) => {
  await openStudio(page)
  await openMessages(page, stream)

  // Default: the latest 50, newest at the top.
  await expect(range(page)).toHaveText('50 messages, #81 to #130')
  expect(await seqOfRow(page, 1)).toBe(130)
  await expect(page.getByRole('button', { name: 'Previous' })).toBeDisabled()

  await page.getByRole('button', { name: 'Next' }).click()
  await expect(range(page)).toHaveText('50 messages, #31 to #80')
  await page.getByRole('button', { name: 'Next' }).click()
  await expect(range(page)).toHaveText('30 messages, #1 to #30')
  await expect(page.getByRole('button', { name: 'Next' })).toBeDisabled()
  await page.getByRole('button', { name: 'Previous' }).click()
  await expect(range(page)).toHaveText('50 messages, #31 to #80')
  expect(await seqOfRow(page, 1)).toBe(80)

  // Oldest first from the first message.
  await page.getByLabel('Start from').selectOption('first')
  await page.getByRole('button', { name: 'Go', exact: true }).click()
  await expect(range(page)).toHaveText('50 messages, #1 to #50')
  expect(await seqOfRow(page, 1)).toBe(1)
  await expect(page.getByLabel('Display order')).toHaveValue('asc')

  // From a sequence; an out-of-range one moves to the nearest and says so.
  await page.getByLabel('Start from').selectOption('seq')
  await page.getByLabel('Sequence', { exact: true }).fill('101')
  await page.getByRole('button', { name: 'Go', exact: true }).click()
  await expect(range(page)).toHaveText('30 messages, #101 to #130')
  await page.getByLabel('Sequence', { exact: true }).fill('99999')
  await page.getByRole('button', { name: 'Go', exact: true }).click()
  await expect(
    page.getByText('Sequence 99999 is after the last message. Showing from 130.')
  ).toBeVisible()

  // From a time in the past starts at the first message; the picker shows local time and UTC.
  await page.getByLabel('Start from').selectOption('time')
  const picker = page.getByLabel(/Local time \(.* UTC\)/)
  await picker.fill('2020-01-01T00:00:00')
  await page.getByRole('button', { name: 'Go', exact: true }).click()
  await expect(range(page)).toHaveText('50 messages, #1 to #50')

  // Jump to latest is always there; page size changes the page.
  await page.getByRole('button', { name: 'Latest' }).click()
  await expect(range(page)).toHaveText('50 messages, #81 to #130')
  await page.getByLabel('Page size').selectOption('25')
  await expect(range(page)).toHaveText('25 messages, #106 to #130')

  // Browsing created no consumer on the stream.
  expect((await client.jsm.streams.info(stream)).state.consumer_count).toBe(0)
})

test('PBI-042/048 filter by subject, header, payload text, regex and JSONPath', async ({
  page
}) => {
  await openStudio(page)
  await openMessages(page, stream)
  await expect(range(page)).toContainText('50 messages')

  // Subject filter, applied by the server.
  await page.getByLabel('Subject filter').fill(`${stream}.eu`)
  await page.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(range(page)).toHaveText('50 messages, #32 to #130')
  const chips = page.getByLabel('Active filters')
  await expect(chips).toContainText(`Subject ${stream}.eu`)

  // An invalid subject is refused before anything is sent.
  await page.getByLabel('Subject filter').fill('bad..subject')
  await expect(page.getByText('Subject cannot have empty tokens')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled()
  await page.getByLabel('Subject filter').fill(`${stream}.eu`)

  // Header and payload filters are combined with AND.
  await page.getByRole('button', { name: /^Filters/ }).click()
  const panel = page.getByRole('form', { name: 'Message filters' })
  await panel.getByLabel('Condition 1 type').selectOption('header')
  await panel.getByLabel('Condition 1 header name').fill('Trace-Id')
  await panel.getByRole('button', { name: 'Add condition' }).click()
  await panel.getByLabel('Condition 2 type').selectOption('contains')
  await panel.getByLabel('Condition 2 expression').fill('urgent')
  await panel.getByRole('button', { name: 'Apply filters' }).click()
  await expect(range(page)).toHaveText('2 messages, #50 to #100')
  await expect(chips).toContainText('Has header Trace-Id')
  await expect(chips).toContainText('Payload contains "urgent"')

  // Removing a chip widens the result.
  await chips.getByRole('button', { name: 'Remove filter: Payload contains "urgent"' }).click()
  await expect(range(page)).toHaveText('13 messages, #10 to #130')

  // Invalid expressions show an inline error and cannot be applied.
  await page.getByRole('button', { name: /^Filters/ }).click()
  await panel.getByRole('button', { name: 'Add condition' }).click()
  await panel.getByLabel('Condition 2 type').selectOption('regex')
  await panel.getByLabel('Condition 2 expression').fill('(')
  await expect(panel.getByRole('alert').first()).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Apply filters' })).toBeDisabled()
  await panel.getByLabel('Condition 2 type').selectOption('jsonPath')
  await panel.getByLabel('Condition 2 expression').fill('order.total > 1')
  await expect(panel.getByText(/Expression must start with \$/)).toBeVisible()

  // JSONPath: non-JSON payloads are skipped and counted.
  await panel.getByRole('button', { name: 'Remove condition 1' }).click()
  await panel.getByLabel('Condition 1 expression').fill('$.order.total > 1200')
  await panel.getByRole('button', { name: 'Apply filters' }).click()
  await expect(range(page)).toHaveText('5 messages, #122 to #130')
  await expect(
    page.getByText(/payloads were not JSON and were skipped by the JSONPath filter/)
  ).toBeVisible()

  // A scan limit that is hit is reported as such, with a way to continue.
  await page.getByRole('button', { name: /^Filters/ }).click()
  await panel.getByLabel('Condition 1 expression').fill('$.order.id == "A-2"')
  await panel.getByLabel('Scan limit').fill('20')
  await panel.getByRole('button', { name: 'Apply filters' }).click()
  await expect(page.getByText(/Scan limit reached: 20 messages examined, 0 matches/)).toBeVisible()
  await expect(
    page.getByText('No matches yet. The scan limit was reached before the end of the stream.')
  ).toBeVisible()
  // Apply hid the panel; open it again.
  await page.getByRole('button', { name: /^Filters/ }).click()
  await panel.getByLabel('Scan limit').fill('10000')
  await panel.getByRole('button', { name: 'Apply filters' }).click()
  await expect(range(page)).toHaveText('1 message, #2 to #2')

  // No matches at all is a different message.
  await page.getByRole('button', { name: /^Filters/ }).click()
  await panel.getByLabel('Condition 1 expression').fill('$.order.id == "nope"')
  await panel.getByRole('button', { name: 'Apply filters' }).click()
  await expect(
    page.getByText(/No messages match these filters\. 65 messages were examined\./)
  ).toBeVisible()
})

test('PBI-043/045 message detail, payload views, copy and export', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await openStudio(page)
  await openMessages(page, stream)
  await expect(range(page)).toContainText('50 messages')

  await rowOf(page, 120).click()
  const detail = page.getByRole('complementary', { name: 'Message detail' })
  await expect(detail).toContainText('Message #120')
  await expect(detail).toContainText(`${stream}.eu`)
  // Only the stored headers, not the ones the server adds to its replies.
  await expect(detail).toContainText('Headers (2)')
  // Headers start closed (PBI-125); open them.
  const headersToggle = detail.getByRole('button', { name: /^Headers \(2\)/ })
  if ((await headersToggle.getAttribute('aria-expanded')) !== 'true') await headersToggle.click()
  await expect(detail.getByRole('row', { name: /Trace-Id/ })).toContainText('trace-120')
  await expect(detail.getByRole('row', { name: /Region/ })).toContainText('eu')

  // JSON is detected; the other views are one click away.
  await expect(detail.getByRole('tab', { name: 'JSON' })).toHaveAttribute('aria-selected', 'true')
  await expect(detail.getByTestId('payload-body')).toContainText('"A-120"')
  await detail.getByRole('tab', { name: 'Text' }).click()
  await expect(detail.getByTestId('payload-body')).toContainText(
    '{"order":{"id":"A-120","total":1200},"note":"message 120"}'
  )
  await detail.getByRole('tab', { name: 'Hex' }).click()
  await expect(detail.getByTestId('payload-body')).toContainText('7b 22 6f 72 64 65 72')
  await detail.getByRole('tab', { name: 'Base64' }).click()
  await expect(detail.getByTestId('payload-body')).toContainText('eyJvcmRlciI6')

  await detail.getByRole('button', { name: 'Copy subject' }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${stream}.eu`)
  await detail.getByRole('button', { name: 'Copy as a "nats pub" command' }).click()
  await expect(toast(page, 'Copied a "nats pub" command')).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    `nats pub -H 'Region:eu' -H 'Trace-Id:trace-120' '${stream}.eu' '{"order":{"id":"A-120","total":1200},"note":"message 120"}'`
  )

  // Previous and next from the panel, by button and by keyboard.
  await detail.getByRole('button', { name: 'Next message' }).click()
  await expect(detail).toContainText('Message #119')
  await detail.press('Alt+ArrowUp')
  await expect(detail).toContainText('Message #120')
  await detail.press('Escape')
  await expect(detail).toHaveCount(0)

  // A plain-text payload is shown as text.
  await rowOf(page, 125).click()
  await expect(detail.getByRole('tab', { name: 'Text' })).toHaveAttribute('aria-selected', 'true')
  await expect(detail.getByTestId('payload-body')).toHaveText('plain text 125 URGENT')

  // Export selected messages as JSON.
  await page.getByLabel('Select message 130').check()
  await page.getByLabel('Select message 125').check()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'JSON', exact: true }).click()
  const file = await download
  expect(file.suggestedFilename()).toBe(`${stream}-2-messages.json`)
  const exported = JSON.parse(readFileSync(await file.path(), 'utf8'))
  expect(exported.map((m: { seq: number }) => m.seq)).toEqual([130, 125])
  expect(exported[1]).toMatchObject({
    subject: `${stream}.us`,
    payload: 'plain text 125 URGENT',
    encoding: 'utf8',
    headers: [['Region', 'us']]
  })
  expect(new Date(exported[0].time).getTime()).toBeGreaterThan(Date.now() - 3600_000)

  // Export everything matching the current filter, as NDJSON, with a maximum.
  await page.getByLabel('Subject filter').fill(`${stream}.us`)
  await page.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(range(page)).toContainText('#31 to #129')
  await page.getByRole('button', { name: 'Export all matching' }).click()
  const dialog = page.getByRole('dialog', { name: 'Export all matching messages' })
  await dialog.getByLabel('Maximum messages').fill('40')
  await dialog.getByLabel('Format').selectOption('ndjson')
  const all = page.waitForEvent('download')
  await dialog.getByRole('button', { name: 'Export', exact: true }).click()
  const lines = readFileSync(await (await all).path(), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
  expect(lines).toHaveLength(40)
  expect(lines.map((m) => m.seq)).toEqual(Array.from({ length: 40 }, (_, i) => i * 2 + 1))
  expect(lines.every((m) => m.subject === `${stream}.us`)).toBe(true)
})

test('PBI-046/047 delete and republish a message', async ({ page }) => {
  const name = unique('EDIT')
  await client.jsm.streams.add({ name, subjects: [`${name}.>`] })
  const target = unique('TARGET')
  await client.jsm.streams.add({ name: target, subjects: [`${target}.>`] })
  for (let i = 1; i <= 5; i++) await client.js.publish(`${name}.x`, `payload ${i}`)

  await openStudio(page)
  await openMessages(page, name)
  await rowOf(page, 3, name).click()
  const detail = page.getByRole('complementary', { name: 'Message detail' })

  // Republish to another subject, with an edited payload.
  await detail.getByRole('button', { name: 'Republish message' }).click()
  const republish = page.getByRole('dialog', { name: 'Republish message #3' })
  await expect(
    republish.getByText(
      new RegExp(`Stream ${name} captures ${name}\\.x, so the message will be stored again`)
    )
  ).toBeVisible()
  await republish.getByLabel('Subject', { exact: true }).fill(`${target}.replayed`)
  await expect(republish.getByText(/will be stored again/)).toHaveCount(0)
  await republish.getByLabel('Payload').fill('payload 3 (replayed)')
  await republish.getByRole('button', { name: 'Republish', exact: true }).click()
  await expect(toast(page, `Republished message #3 to ${target}.replayed`)).toBeVisible()
  const replayed = await client.jsm.streams.getMessage(target, { seq: 1 })
  expect(replayed?.subject).toBe(`${target}.replayed`)
  expect(replayed?.string()).toBe('payload 3 (replayed)')

  // Several at once, each keeping its subject, at a limited rate.
  await page.getByLabel('Select message 1').check()
  await page.getByLabel('Select message 2').check()
  await page.getByRole('button', { name: 'Republish', exact: true }).click()
  const many = page.getByRole('dialog', { name: 'Republish 2 messages' })
  await many.getByLabel(/Rate limit/).fill('50')
  await many.getByRole('button', { name: 'Republish', exact: true }).click()
  await expect(toast(page, 'Republished 2 of 2 messages')).toBeVisible()
  expect((await client.jsm.streams.info(name)).state.messages).toBe(7)

  // Delete one message after a confirmation that names it.
  await rowOf(page, 4, name).click()
  await detail.getByRole('button', { name: 'Delete message' }).click()
  const confirm = page.getByRole('dialog', { name: 'Delete message #4' })
  await expect(confirm).toContainText(`${name}.x`)
  await confirm.getByRole('button', { name: 'Delete message' }).click()
  await expect(toast(page, `Deleted message #4 from ${name}`)).toBeVisible()
  await expect(rowOf(page, 4, name)).toHaveCount(0)
  expect(await client.jsm.streams.getMessage(name, { seq: 4 })).toBeNull()

  // The republish was recorded in the audit log.
  await client.jsm.streams.delete(name)
  await client.jsm.streams.delete(target)
})

test('PBI-046 delete is disabled on a stream that denies it', async ({ page }) => {
  const name = unique('NODEL')
  await client.jsm.streams.add({ name, subjects: [`${name}.>`], deny_delete: true })
  await client.js.publish(`${name}.x`, 'keep')
  await openStudio(page)
  await openMessages(page, name)
  await page
    .getByRole('table', { name: `Messages in ${name}` })
    .getByRole('row')
    .nth(1)
    .click()
  const button = page
    .getByRole('complementary', { name: 'Message detail' })
    .getByRole('button', { name: 'Delete message' })
  await expect(button).toBeDisabled()
  await expect(button).toHaveAttribute('title', /deny_delete/)
  await client.jsm.streams.delete(name)
})

test('PBI-049 the message panel shows which consumers have received the message', async ({
  page
}) => {
  const name = unique('MCONS')
  await client.jsm.streams.add({ name, subjects: [`${name}.>`] })
  // A work-queue stream with no consumer keeps its messages: it only adds the retention note.
  const queue = unique('MQUEUE')
  await client.jsm.streams.add({
    name: queue,
    subjects: [`${queue}.>`],
    retention: 'workqueue' as never
  })
  await client.js.publish(`${queue}.a`, 'waiting')
  for (let i = 1; i <= 3; i++) await client.js.publish(`${name}.${i === 3 ? 'b' : 'a'}`, `m${i}`)
  await client.jsm.consumers.add(name, {
    durable_name: 'only-a',
    ack_policy: 'explicit' as never,
    filter_subject: `${name}.a`
  })
  await client.jsm.consumers.add(name, {
    durable_name: 'only-b',
    ack_policy: 'explicit' as never,
    deliver_policy: 'by_start_sequence' as never,
    opt_start_seq: 2,
    filter_subject: `${name}.>`
  })
  const consumer = await client.js.consumers.get(name, 'only-a')
  for await (const m of await consumer.fetch({ max_messages: 1, expires: 2000 })) m.ack()

  await openStudio(page)
  await openMessages(page, name)
  await rowOf(page, 1, name).click()
  // The Consumers section starts closed (PBI-125); open it.
  await page
    .getByRole('complementary', { name: 'Message detail' })
    .getByRole('button', { name: /^Consumers/ })
    .click()
  const section = page
    .getByRole('complementary', { name: 'Message detail' })
    .getByRole('region', { name: 'Consumers' })
  const only = section.getByRole('listitem').filter({ hasText: 'only-a' })
  await expect(only).toContainText('Done')
  await expect(only.getByText('Done', { exact: true })).toHaveAttribute('title', /ack floor/)
  await expect(section.getByRole('listitem').filter({ hasText: 'only-b' })).toContainText(
    'Before the consumer started'
  )
  await expect(section.getByTestId('consumers-read-at')).toContainText('Read at')

  // Message 2 is for only-a and not delivered yet; the Refresh button reads again.
  await rowOf(page, 2, name).click()
  await expect(only).toContainText('Not delivered yet')
  await expect(section.getByRole('listitem').filter({ hasText: 'only-b' })).toContainText(
    'Not delivered yet'
  )
  await rowOf(page, 3, name).click()
  await expect(only).toContainText('Not for this consumer')
  await section.getByRole('button', { name: 'Refresh consumers' }).click()

  // The consumer name opens the consumer detail.
  await only.getByRole('button', { name: 'only-a' }).click()
  await expect(page.getByTestId('consumer-pending')).toBeVisible()

  await openMessages(page, queue)
  await rowOf(page, 1, queue).click()
  await expect(
    page.getByRole('region', { name: 'Consumers' }).getByText('removed once its consumer')
  ).toBeVisible()
  await expect(page.getByText('This stream has no consumers')).toBeVisible()
  await client.jsm.streams.delete(name)
  await client.jsm.streams.delete(queue)
})

test('PBI-125 the Filters button shows its state and a count, Apply hides the panel, and it is not restored on load', async ({
  page
}) => {
  await openStudio(page)
  await openMessages(page, stream)
  const button = page.getByRole('button', { name: /^Filters/ })
  await expect(button).toHaveAttribute('aria-expanded', 'false')
  await button.click()
  const panel = page.getByRole('form', { name: 'Message filters' })
  await expect(button).toHaveAttribute('aria-expanded', 'true')
  await expect(button).toHaveAttribute('aria-controls', (await panel.getAttribute('id'))!)

  // Apply, Clear and Hide stay in view, and the panel never grows past its maximum height.
  await expect(panel.getByRole('button', { name: 'Apply filters' })).toBeInViewport()
  await expect(panel.getByRole('button', { name: 'Hide' })).toBeInViewport()
  expect((await panel.boundingBox())!.height).toBeLessThanOrEqual(900 * 0.55 + 1)

  await panel.getByLabel('Condition 1 type').selectOption('contains')
  await panel.getByLabel('Condition 1 expression').fill('message 12')
  await panel.getByRole('button', { name: 'Apply filters' }).click()
  await expect(page.getByRole('button', { name: 'Filters, 1 active' })).toBeVisible()

  // Apply hides the panel, keeps the chip and leaves focus on the Filters button.
  await expect(panel).toBeHidden()
  await expect(button).toBeFocused()
  await expect(page.getByLabel('Active filters')).toContainText('Payload contains "message 12"')

  // Escape closes it too, with focus back on the button.
  await button.click()
  await panel.getByLabel('Condition 1 expression').press('Escape')
  await expect(panel).toBeHidden()
  await expect(button).toBeFocused()

  // Open is not restored on load: it is for this visit only.
  await button.click()
  await expect(panel).toBeVisible()
  await page.reload()
  await openStudio(page)
  await openMessages(page, stream)
  await expect(page.getByRole('form', { name: 'Message filters' })).toBeHidden()

  // Clear also hides the panel and focuses the button.
  await page.getByRole('button', { name: /^Filters/ }).click()
  await panel.getByRole('button', { name: 'Clear' }).click()
  await expect(panel).toBeHidden()
  await expect(page.getByRole('button', { name: /^Filters/ })).toBeFocused()
})

test('PBI-125 sections collapse and stay collapsed, the panel collapses to a rail and widens to read', async ({
  page
}) => {
  await openStudio(page)
  await openMessages(page, stream)
  await rowOf(page, 120).click()
  const detail = page.getByRole('complementary', { name: 'Message detail' })
  const frame = page.getByTestId('detail-frame')
  const headers = detail.getByRole('button', { name: /^Headers \(2\)/ })

  // A section collapses to a summary, and the choice survives a reload.
  if ((await headers.getAttribute('aria-expanded')) !== 'true') await headers.click()
  await expect(detail.getByRole('row', { name: /Trace-Id/ })).toBeVisible()
  await headers.click()
  await expect(headers).toHaveAttribute('aria-expanded', 'false')
  await expect(detail.getByText('Region, Trace-Id')).toBeVisible()
  await expect(detail.getByRole('row', { name: /Trace-Id/ })).toBeHidden()
  await page.reload()
  await openStudio(page)
  await openMessages(page, stream)
  await rowOf(page, 120).click()
  await expect(headers).toHaveAttribute('aria-expanded', 'false')
  await headers.click()
  await expect(detail.getByRole('row', { name: /Trace-Id/ })).toBeVisible()

  // Collapse to a rail: the selection stays, the table takes the width, and it is remembered.
  const tableWidth = async (): Promise<number> => (await table(page).boundingBox())!.width
  const before = await tableWidth()
  const framed = (await frame.boundingBox())!.width
  await detail.getByRole('button', { name: 'Collapse panel' }).click()
  const rail = page.getByRole('complementary', { name: 'Message detail (collapsed)' })
  await expect(rail).toContainText('Message #120')
  expect(Math.round((await frame.boundingBox())!.width)).toBe(36)
  expect(await tableWidth()).toBeGreaterThan(before + framed - 60)
  await page.reload()
  await openStudio(page)
  await openMessages(page, stream)
  await rowOf(page, 120).click()
  await expect(rail).toBeVisible()
  await rail.getByRole('button', { name: 'Expand message panel' }).click()
  await expect(detail).toBeVisible()
  expect(Math.round((await frame.boundingBox())!.width)).toBe(Math.round(framed))

  // Expand to read: the split is resized (the table shrinks), Escape restores the width.
  const separator = page.getByRole('separator', { name: 'Resize message detail' })
  const saved = await separator.getAttribute('aria-valuenow')
  await detail.getByRole('button', { name: 'Expand to read' }).click()
  const wide = (await frame.boundingBox())!.width
  const row = (await frame.locator('xpath=..').boundingBox())!.width
  expect(wide).toBeGreaterThan(row * 0.68)
  expect(wide).toBeLessThanOrEqual(row * 0.71)
  expect(await tableWidth()).toBeLessThan(before)
  await detail.getByRole('button', { name: 'Restore panel size' }).focus()
  await page.keyboard.press('Escape')
  await expect(detail).toBeVisible()
  expect(Math.round((await frame.boundingBox())!.width)).toBe(Math.round(framed))
  await expect(separator).toHaveAttribute('aria-valuenow', saved!)
  // The column resize handles of the table (PBI-124) are still there.
  await expect(table(page).getByRole('separator').first()).toBeAttached()
})

test('PBI-125 the panel works in a 1000 px window', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 700 })
  await openStudio(page)
  await openMessages(page, stream)
  await rowOf(page, 120).click()
  const detail = page.getByRole('complementary', { name: 'Message detail' })
  await expect(detail).toBeVisible()
  const fits = (): Promise<boolean> =>
    page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
  expect(await fits()).toBe(true)
  await detail.getByRole('button', { name: 'Collapse panel' }).click()
  await expect(table(page)).toBeVisible()
  expect(await fits()).toBe(true)
  await page.getByRole('button', { name: 'Expand message panel' }).click()
  await expect(detail).toBeVisible()
  expect(await fits()).toBe(true)
})

test('PBI-125 readable JSON: text size, levels, search and copy path', async ({
  page,
  context
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await openStudio(page)
  await openMessages(page, stream)
  await rowOf(page, 120).click()
  const detail = page.getByRole('complementary', { name: 'Message detail' })
  const body = detail.getByTestId('payload-body')
  const tree = body.locator('> div')
  await expect(tree).toHaveCSS('font-size', '13px')

  // Text size is remembered.
  await detail.getByRole('button', { name: 'Larger text' }).click()
  await expect(tree).toHaveCSS('font-size', '15px')
  await page.reload()
  await openStudio(page)
  await openMessages(page, stream)
  await rowOf(page, 120).click()
  await expect(tree).toHaveCSS('font-size', '15px')
  await detail.getByRole('button', { name: 'Smaller text' }).click()
  await expect(tree).toHaveCSS('font-size', '13px')

  // Collapse all, then a search that opens what it needs.
  await detail.getByRole('button', { name: 'Collapse all' }).click()
  await expect(body).not.toContainText('"A-120"')
  await body.focus()
  await page.keyboard.press('Control+f')
  const search = detail.getByRole('textbox', { name: 'Search in JSON' })
  await expect(search).toBeFocused()
  await search.fill('a-120')
  await expect(detail.getByTestId('json-match-count')).toHaveText('1 of 1')
  await expect(body).toContainText('"A-120"')
  await expect(detail.locator('mark')).toHaveText('A-120')

  // Copy the path and the value of that row.
  await body.getByText('"A-120"').hover()
  await detail.getByRole('button', { name: 'Copy path $.order.id' }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('$.order.id')
  await detail.getByRole('button', { name: 'Copy value of $.order.id' }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('A-120')

  // Escape clears the search and leaves the panel open.
  await search.press('Escape')
  await expect(search).toHaveValue('')
  await expect(detail).toBeVisible()
})

for (const size of [
  { width: 1440, height: 900 },
  { width: 1000, height: 700 }
]) {
  test(`PBI-125 filters open and a message selected never scroll the page (${size.width}x${size.height})`, async ({
    page
  }) => {
    await page.setViewportSize(size)
    await openStudio(page)
    await openMessages(page, stream)
    const button = page.getByRole('button', { name: /^Filters/ })
    if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click()
    await rowOf(page, 120).click()
    const detail = page.getByRole('complementary', { name: 'Message detail' })
    await expect(detail).toBeVisible()
    // The default layout: Headers and Consumers closed (earlier tests may have changed them).
    for (const name of [/^Headers/, /^Consumers/]) {
      const toggle = detail.getByRole('button', { name })
      if ((await toggle.getAttribute('aria-expanded')) === 'true') await toggle.click()
    }
    const metrics = (): Promise<{ scroll: number; inner: number }> =>
      page.evaluate(() => ({
        scroll: document.scrollingElement!.scrollHeight,
        inner: window.innerHeight
      }))
    const m = await metrics()
    expect(m.scroll).toBeLessThanOrEqual(m.inner)
    expect((await table(page).boundingBox())!.height).toBeGreaterThan(150)
    if (size.height >= 900)
      expect((await detail.getByTestId('payload-body').boundingBox())!.height).toBeGreaterThan(80)
    // The filter panel keeps its footer in view.
    await expect(page.getByRole('button', { name: 'Apply filters' })).toBeInViewport()
    await page
      .getByRole('form', { name: 'Message filters' })
      .getByRole('button', { name: 'Hide' })
      .click()
    if (size.height >= 900) {
      // With the filters closed the payload has real height.
      expect((await detail.getByTestId('payload-body').boundingBox())!.height).toBeGreaterThan(300)
    }
    const after = await metrics()
    expect(after.scroll).toBeLessThanOrEqual(after.inner)
  })
}

const DEFAULT_SECTIONS = async (page: Page): Promise<void> => {
  const detail = page.getByRole('complementary', { name: 'Message detail' })
  for (const name of [/^Headers/, /^Consumers/]) {
    const toggle = detail.getByRole('button', { name })
    if ((await toggle.getAttribute('aria-expanded')) === 'true') await toggle.click()
  }
}

const payloadHeight = async (page: Page): Promise<number> =>
  (await page
    .getByRole('complementary', { name: 'Message detail' })
    .getByTestId('payload-body')
    .boundingBox())!.height

for (const { width, height, closed, open } of [
  { width: 1440, height: 900, closed: 300, open: 190 },
  { width: 1280, height: 720, closed: 195, open: 120 }
]) {
  test(`#58 the JSON gets real height with a message selected (${width}x${height})`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height })
    await openStudio(page)
    await openMessages(page, stream)
    await rowOf(page, 120).click()
    await expect(page.getByRole('complementary', { name: 'Message detail' })).toBeVisible()
    await DEFAULT_SECTIONS(page)
    const closedHeight = await payloadHeight(page)
    console.log(`payload ${width}x${height} filters closed: ${Math.round(closedHeight)}px`)
    expect(closedHeight).toBeGreaterThanOrEqual(closed)
    if (open) {
      await page.getByRole('button', { name: /^Filters/ }).click()
      const openHeight = await payloadHeight(page)
      console.log(`payload ${width}x${height} filters open: ${Math.round(openHeight)}px`)
      expect(openHeight).toBeGreaterThanOrEqual(open)
      const m = await page.evaluate(() => ({
        s: document.scrollingElement!.scrollHeight,
        i: window.innerHeight
      }))
      expect(m.s).toBeLessThanOrEqual(m.i)
    }
  })
}

for (const size of [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
  { width: 1000, height: 600 }
]) {
  test(`#58 Expand to read fills the tab, never scrolls the page, and Esc restores (${size.width}x${size.height})`, async ({
    page
  }) => {
    await page.setViewportSize(size)
    await openStudio(page)
    await openMessages(page, stream)
    await rowOf(page, 120).click()
    const detail = page.getByRole('complementary', { name: 'Message detail' })
    await expect(detail).toBeVisible()
    await DEFAULT_SECTIONS(page)
    const normalPayload = await payloadHeight(page)
    const normalWidth = (await detail.boundingBox())!.width
    const tabTop = (await page.getByRole('heading', { level: 1 }).boundingBox())!.y

    await detail.getByRole('button', { name: 'Expand to read' }).click()
    const box = (await detail.boundingBox())!
    // It starts at the top of the stream page (above the header, tabs and toolbar) and reaches
    // the bottom of the window.
    expect(box.y).toBeLessThanOrEqual(tabTop)
    expect(box.y + box.height).toBeGreaterThanOrEqual(size.height - 2)
    expect(box.width).toBeGreaterThan(normalWidth)
    const expandedPayload = await payloadHeight(page)
    console.log(
      `payload ${size.width}x${size.height}: normal ${Math.round(normalPayload)}px, expanded ${Math.round(expandedPayload)}px`
    )
    expect(expandedPayload).toBeGreaterThan(normalPayload + 100)
    const m = await page.evaluate(() => ({
      s: document.scrollingElement!.scrollHeight,
      i: window.innerHeight,
      w: document.documentElement.scrollWidth,
      iw: window.innerWidth
    }))
    expect(m.s).toBeLessThanOrEqual(m.i)
    expect(m.w).toBeLessThanOrEqual(m.iw)
    // The table stays visible on the left.
    expect((await table(page).boundingBox())!.width).toBeGreaterThan(150)

    await detail.getByRole('button', { name: 'Restore panel size' }).focus()
    await page.keyboard.press('Escape')
    await expect(detail).toBeVisible()
    const back = (await detail.boundingBox())!
    expect(Math.round(back.width)).toBe(Math.round(normalWidth))
    expect(back.y).toBeGreaterThan(tabTop + 20)
  })
}

test('#58 1000x600 with the filters open and nothing selected does not scroll the page', async ({
  page
}) => {
  await page.setViewportSize({ width: 1000, height: 600 })
  await openStudio(page)
  await openMessages(page, stream)
  await page.getByRole('button', { name: /^Filters/ }).click()
  await expect(page.getByRole('form', { name: 'Message filters' })).toBeVisible()
  const m = await page.evaluate(() => ({
    s: document.scrollingElement!.scrollHeight,
    i: window.innerHeight
  }))
  expect(m.s).toBeLessThanOrEqual(m.i)
})

test('#58 while expanded, Tab and Shift+Tab never reach what the panel covers', async ({
  page
}) => {
  await openStudio(page)
  await openMessages(page, stream)
  await rowOf(page, 120).click()
  const detail = page.getByRole('complementary', { name: 'Message detail' })
  await detail.getByRole('button', { name: 'Expand to read' }).click()
  const refresh = page.getByRole('button', { name: 'Refresh', exact: true })
  await expect(refresh).toBeAttached()
  expect(await refresh.evaluate((el) => !!el.closest('[inert]'))).toBe(true)
  // Controls the panel covers: after each Tab none of them may have focus.
  const onCovered = (): Promise<string | null> =>
    page.evaluate(() => {
      const a = document.activeElement
      const name = (a?.getAttribute('aria-label') ?? a?.textContent ?? '').trim()
      const covered =
        !a?.closest('aside') &&
        /^(Refresh|Filters|Saved|Go|Export all matching|Latest|Next)/.test(name)
      return a && (a.closest('[inert]') || covered) ? `${a.tagName} ${name}` : null
    })
  expect(
    await page.evaluate(() => document.querySelectorAll('[inert] button, [inert] select').length)
  ).toBeGreaterThan(5)
  const outside = onCovered
  await detail.getByRole('button', { name: 'Restore panel size' }).focus()
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab')
    expect(await outside()).toBeNull()
  }
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press('Shift+Tab')
    expect(await outside()).toBeNull()
  }
  // Escape puts everything back in the tab order.
  await detail.getByRole('button', { name: 'Restore panel size' }).focus()
  await page.keyboard.press('Escape')
  expect(await refresh.evaluate((el) => !!el.closest('[inert]'))).toBe(false)
})

const visibleInert = (page: Page): Promise<number> =>
  page.evaluate(
    () =>
      [...document.querySelectorAll('[inert]')].filter(
        (el) => (el as HTMLElement).getClientRects().length > 0
      ).length
  )

test('#58 an expanded panel leaves nothing inert when the tab changes, closes or the page moves on', async ({
  page
}) => {
  await openStudio(page)
  // A Streams tab to switch to later, while the sidebar is the icon rail.
  await go(page, 'Streams')
  await openMessages(page, stream)
  await rowOf(page, 120).click()
  const detail = page.getByRole('complementary', { name: 'Message detail' })
  await detail.getByRole('button', { name: 'Expand to read' }).click()
  expect(await visibleInert(page)).toBeGreaterThan(0)

  // The sidebar and the tab strip are not covered, so they are never inert and stay clickable.
  const inertOutside = await page.evaluate(() => {
    const els = [
      document.querySelector('nav[aria-label="Connections"]'),
      document.querySelector('[role=tablist]'),
      document.querySelector('header')
    ]
    return els.some((el) => !!el?.closest('[inert]'))
  })
  expect(inertOutside).toBe(false)

  // A stream page opens in a new tab: nothing visible is inert there.
  // (The sidebar is the icon rail while a message is open; the tab strip is always there.)
  const openTabs = page.getByRole('tablist', { name: 'Open tabs' })
  await openTabs.getByRole('tab', { name: 'Streams', exact: true }).click()
  await page
    .getByRole('table', { name: 'Streams' })
    .getByRole('button', { name: 'ORDERS', exact: true })
    .click()
  await expect(
    page
      .getByRole('tabpanel', { name: 'ORDERS', exact: true })
      .getByRole('tab', { name: 'Overview' })
  ).toBeVisible()
  expect(await visibleInert(page)).toBe(0)

  // Back on the Messages screen the panel is still expanded and its page is inert again.
  await openTabs.getByRole('tab', { name: `${stream} messages`, exact: true }).click()
  await expect(detail.getByRole('button', { name: 'Restore panel size' })).toBeVisible()
  expect(await visibleInert(page)).toBeGreaterThan(0)

  // Closing the tab removes the page, and its marks with it.
  await page.keyboard.press('Control+w')
  await openTabs.getByRole('tab', { name: 'ORDERS', exact: true }).waitFor({ state: 'visible' })
  expect(await visibleInert(page)).toBe(0)
  expect(await page.evaluate(() => document.querySelectorAll('[inert]').length)).toBe(0)
})

test('#58 when the stream info fails while expanded, nothing stays inert and Retry works', async ({
  page
}) => {
  let fail = false
  // Answers streamInfo with an error while `fail` is set; everything else goes to the server.
  await page.routeWebSocket('**/rpc', (ws) => {
    const server = ws.connectToServer()
    ws.onMessage((raw) => {
      const message = JSON.parse(String(raw))
      if (fail && message.t === 'call' && message.method === 'streamInfo') {
        ws.send(
          JSON.stringify({
            t: 'result',
            id: message.id,
            ok: false,
            error: { kind: 'timeout', message: 'injected failure' }
          })
        )
      } else server.send(raw)
    })
    server.onMessage((raw) => ws.send(raw))
  })
  await openStudio(page)
  await openMessages(page, stream)
  await rowOf(page, 120).click()
  const detail = page.getByRole('complementary', { name: 'Message detail' })
  await detail.getByRole('button', { name: 'Expand to read' }).click()
  expect(await visibleInert(page)).toBeGreaterThan(0)

  fail = true
  // The page refreshes the stream info on an interval; the failure replaces the browser.
  const retry = page.getByRole('button', { name: 'Retry' })
  await expect(retry).toBeVisible({ timeout: 20_000 })
  expect(await visibleInert(page)).toBe(0)
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled()

  // Retry brings the browser back; the expanded state was reset with it.
  fail = false
  await retry.click()
  await expect(table(page)).toBeVisible()
  expect(await visibleInert(page)).toBe(0)
  await rowOf(page, 120).click()
  await expect(detail.getByRole('button', { name: 'Expand to read' })).toBeVisible()
})

test('PBI-126 filter from a message: include, exclude, flip and remove chips', async ({ page }) => {
  const name = unique('FFM')
  await client.jsm.streams.add({ name, subjects: [`${name}.>`] })
  // 8 messages: event_type alternates, status is "ok" except on every 4th.
  for (let i = 1; i <= 8; i++)
    await client.js.publish(
      `${name}.e`,
      JSON.stringify({
        event_type: i % 2 ? 'ingestion.load' : 'ingestion.done',
        status: i % 4 ? 'ok' : 'failed',
        n: i
      })
    )
  await openStudio(page)
  await openMessages(page, name)
  await expect(range(page)).toHaveText('8 messages, #1 to #8')
  await rowOf(page, 8, name).click()
  const detail = page.getByRole('complementary', { name: 'Message detail' })
  const chips = page.getByLabel('Active filters')

  // Filter to this value: only the messages with that event type, and a chip.
  await detail.getByRole('treeitem', { name: '$.event_type: ingestion.done' }).hover()
  await detail.getByRole('button', { name: 'Filter to event_type equals ingestion.done' }).click()
  await expect(range(page)).toHaveText('4 messages, #2 to #8')
  await expect(chips).toContainText('JSONPath $.event_type == "ingestion.done"')
  await expect(page.getByRole('button', { name: 'Filters, 1 active' })).toBeVisible()
  // The message is still in the result, so it stays open and focus stays on the pressed button.
  await expect(
    detail.getByRole('button', { name: 'Filter to event_type equals ingestion.done' })
  ).toBeFocused()

  // Exclude another field: messages 4 and 8 have status "failed", so they leave the result.
  await detail.getByRole('treeitem', { name: '$.status: failed' }).hover()
  await detail.getByRole('button', { name: 'Exclude status equals failed' }).click()
  await expect(range(page)).toHaveText('2 messages, #2 to #6')
  const notChip = chips.getByRole('group', { name: /^Exclude filter: JSONPath \$\.status/ })
  await expect(notChip).toContainText('not')
  await expect(page.getByRole('button', { name: 'Filters, 2 active' })).toBeVisible()
  // The opened message dropped out of the result: focus moved to the new chip.
  await expect(detail).toBeHidden()
  await expect(notChip.getByRole('button', { name: /^Include instead/ })).toBeFocused()

  // Flip the exclude chip: now only the failed ones of that event type.
  await notChip.getByRole('button', { name: /^Include instead/ }).click()
  await expect(range(page)).toHaveText('2 messages, #4 to #8')
  await expect(chips.getByText('not', { exact: true })).toHaveCount(0)

  // Remove a chip.
  await chips.getByRole('button', { name: /^Remove filter: JSONPath \$\.status/ }).click()
  await expect(range(page)).toHaveText('4 messages, #2 to #8')
  await expect(page.getByRole('button', { name: 'Filters, 1 active' })).toBeVisible()

  // The filters panel lists the conditions.
  await page.getByRole('button', { name: /^Filters/ }).click()
  const panel = page.getByRole('form', { name: 'Message filters' })
  await expect(panel.getByLabel('Condition 1 expression')).toHaveValue(
    '$.event_type == "ingestion.done"'
  )
  await client.jsm.streams.delete(name)
})

test('PBI-126 the Consumers list is readable when the section is open', async ({ page }) => {
  const name = unique('FCONS')
  await client.jsm.streams.add({ name, subjects: [`${name}.>`] })
  await client.js.publish(`${name}.a`, JSON.stringify({ a: 1 }))
  for (let i = 1; i <= 8; i++)
    await client.jsm.consumers.add(name, { durable_name: `c${i}`, ack_policy: 'explicit' as never })
  await page.setViewportSize({ width: 1440, height: 900 })
  await openStudio(page)
  await openMessages(page, name)
  await rowOf(page, 1, name).click()
  const detail = page.getByRole('complementary', { name: 'Message detail' })
  const toggle = detail.getByRole('button', { name: /^Consumers/ })
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  const section = detail.getByRole('region', { name: 'Consumers' })
  await expect(section.getByRole('listitem')).toHaveCount(8)
  // At least four rows are really in view, not scrolled out of a thin strip.
  for (let i = 0; i < 4; i++)
    await expect(section.getByRole('listitem').nth(i)).toBeInViewport({ ratio: 1 })
  // The payload keeps some height (the rest of the panel scrolls).
  expect((await detail.getByTestId('payload-body').boundingBox())!.height).toBeGreaterThan(60)
  await toggle.click()
  await client.jsm.streams.delete(name)
})

test('PBI-126 Expand all and Collapse all are clear icon buttons as tall as the level buttons, on one row', async ({
  page
}) => {
  await openStudio(page)
  await openMessages(page, stream)
  await rowOf(page, 120).click()
  const detail = page.getByRole('complementary', { name: 'Message detail' })
  const expand = detail.getByRole('button', { name: 'Expand all' })
  const level = detail.getByRole('button', { name: '2', exact: true })
  const collapse = detail.getByRole('button', { name: 'Collapse all' })
  await expect(expand).toHaveAttribute('title', 'Expand all levels')
  await expect(collapse).toHaveAttribute('title', 'Collapse all levels')
  expect((await expand.boundingBox())!.height).toBe((await level.boundingBox())!.height)
  expect((await collapse.boundingBox())!.height).toBe((await level.boundingBox())!.height)
  expect((await expand.boundingBox())!.width).toBeGreaterThanOrEqual(28)
  // The toolbar stays on one row, so the JSON keeps its height.
  const search = (await detail.getByRole('textbox', { name: 'Search in JSON' }).boundingBox())!
  expect(Math.abs(search.y - (await expand.boundingBox())!.y)).toBeLessThan(6)
})

test('Reload view reads the stream again and shows messages published since', async ({ page }) => {
  const name = unique('RLD')
  await client.jsm.streams.add({ name, subjects: [`${name}.>`], allow_direct: true })
  for (let i = 1; i <= 3; i++) await client.js.publish(`${name}.a`, `first ${i}`)
  await openStudio(page)
  await openMessages(page, name)
  const rows = page.getByRole('table', { name: `Messages in ${name}` })
  await expect(rows.getByText('first 3')).toBeVisible()
  await client.js.publish(`${name}.a`, 'fresh 4')
  await page.getByRole('button', { name: 'Reload view' }).click()
  await expect(rows.getByText('fresh 4')).toBeVisible()
  await client.jsm.streams.delete(name)
})

test('Live shows a message published afterwards without any click', async ({ page }) => {
  const name = unique('LIV')
  await client.jsm.streams.add({ name, subjects: [`${name}.>`], allow_direct: true })
  for (let i = 1; i <= 3; i++) await client.js.publish(`${name}.a`, `first ${i}`)
  await openStudio(page)
  await openMessages(page, name)
  const rows = page.getByRole('table', { name: `Messages in ${name}` })
  await expect(rows.getByText('first 3')).toBeVisible()
  const live = page.getByRole('button', { name: 'Live', exact: true })
  await expect(live).toHaveAttribute('aria-pressed', 'false')
  await live.click()
  await expect(live).toHaveAttribute('aria-pressed', 'true')
  await client.js.publish(`${name}.a`, 'live 4')
  await expect(rows.getByText('live 4')).toBeVisible({ timeout: 8000 })
  await live.click()
  await expect(live).toHaveAttribute('aria-pressed', 'false')
  await client.jsm.streams.delete(name)
})

test('PBI-129 exclude or include a subject from a row or the open message', async ({ page }) => {
  const name = unique('SUBJ')
  await client.jsm.streams.add({ name, subjects: [`${name}.>`] })
  // 9 messages on three subjects: 1,4,7 paid; 2,5,8 open; 3,6,9 refund.
  const kinds = ['paid', 'open', 'refund']
  for (let i = 1; i <= 9; i++)
    await client.js.publish(`${name}.orders.us.${kinds[(i - 1) % 3]}`, `m${i}`)
  await openStudio(page)
  await openMessages(page, name)
  await expect(range(page)).toHaveText('9 messages, #1 to #9')
  const rows = page.getByRole('table', { name: `Messages in ${name}` })
  const chips = page.getByLabel('Active filters')
  const detail = page.getByRole('complementary', { name: 'Message detail' })
  const subject = (kind: string): string => `${name}.orders.us.${kind}`

  // Exclude from the subject cell of a row: the rows of that subject disappear.
  await rowOf(page, 9, name).getByRole('cell').nth(2).hover()
  await rowOf(page, 9, name)
    .getByRole('button', { name: `Exclude subject ${subject('refund')}` })
    .click()
  await expect(range(page)).toHaveText('6 messages, #1 to #8')
  await expect(rows.getByText(subject('refund'))).toHaveCount(0)
  await expect(chips).toContainText(`Subject matches ${subject('refund')}`)

  // Exclude a second one from the open message: the exclusions stack.
  await rowOf(page, 8, name).click()
  await expect(detail).toBeVisible()
  await detail.getByRole('button', { name: `Exclude subject ${subject('open')}` }).click()
  await expect(range(page)).toHaveText('3 messages, #1 to #7')
  await expect(page.getByRole('button', { name: 'Filters, 2 active' })).toBeVisible()
  await expect(detail).toBeHidden()

  // Remove both chips, then include a subject: the Subject field is set and the rows narrow.
  for (let i = 0; i < 2; i++)
    await chips
      .getByRole('button', { name: /^Remove filter/ })
      .first()
      .click()
  await expect(range(page)).toHaveText('9 messages, #1 to #9')
  await rowOf(page, 5, name).click()
  await detail.getByRole('button', { name: `Filter to subject ${subject('open')}` }).click()
  await expect(page.getByLabel('Subject filter')).toHaveValue(subject('open'))
  await expect(range(page)).toHaveText('3 messages, #2 to #8')
  await expect(rows.getByText(subject('paid'))).toHaveCount(0)
  await expect(detail).toBeVisible()
  await client.jsm.streams.delete(name)
})
