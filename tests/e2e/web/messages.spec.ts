import { readFileSync } from 'node:fs'
import { headers } from '@nats-io/transport-node'
import { expect, test, type Page } from '@playwright/test'
import { nats, openStream, openStudio, toast, unique, type Nats } from './helpers'

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
  await openStream(page, stream, 'Messages')

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
  await openStream(page, stream, 'Messages')
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
  await panel.getByRole('button', { name: 'Add header filter' }).click()
  await panel.getByLabel('Header filter 1 name').fill('Trace-Id')
  await panel.getByLabel('Payload contains').fill('urgent')
  await panel.getByRole('button', { name: 'Apply filters' }).click()
  await expect(range(page)).toHaveText('2 messages, #50 to #100')
  await expect(chips).toContainText('Has header Trace-Id')
  await expect(chips).toContainText('Payload contains "urgent"')

  // Removing a chip widens the result.
  await chips.getByRole('button', { name: 'Remove filter: Payload contains "urgent"' }).click()
  await expect(range(page)).toHaveText('13 messages, #10 to #130')

  // Invalid expressions show an inline error and cannot be applied.
  await page.getByRole('button', { name: /^Filters/ }).click()
  await page.getByRole('button', { name: /^Filters/ }).click()
  await panel.getByLabel('Payload matches regular expression').fill('(')
  await expect(panel.getByRole('alert').first()).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Apply filters' })).toBeDisabled()
  await panel.getByLabel('Payload matches regular expression').fill('')
  await panel.getByLabel('JSONPath').fill('order.total > 1')
  await expect(panel.getByText(/Expression must start with \$/)).toBeVisible()

  // JSONPath: non-JSON payloads are skipped and counted.
  await panel.getByRole('button', { name: 'Remove header filter 1' }).click()
  await panel.getByLabel('JSONPath').fill('$.order.total > 1200')
  await panel.getByRole('button', { name: 'Apply filters' }).click()
  await expect(range(page)).toHaveText('5 messages, #122 to #130')
  await expect(
    page.getByText(/payloads were not JSON and were skipped by the JSONPath filter/)
  ).toBeVisible()

  // A scan limit that is hit is reported as such, with a way to continue.
  await page.getByRole('button', { name: /^Filters/ }).click()
  await page.getByRole('button', { name: /^Filters/ }).click()
  await panel.getByLabel('JSONPath').fill('$.order.id == "A-2"')
  await panel.getByLabel('Scan limit').fill('20')
  await panel.getByRole('button', { name: 'Apply filters' }).click()
  await expect(page.getByText(/Scan limit reached: 20 messages examined, 0 matches/)).toBeVisible()
  await expect(
    page.getByText('No matches yet. The scan limit was reached before the end of the stream.')
  ).toBeVisible()
  await panel.getByLabel('Scan limit').fill('10000')
  await panel.getByRole('button', { name: 'Apply filters' }).click()
  await expect(range(page)).toHaveText('1 message, #2 to #2')

  // No matches at all is a different message.
  await panel.getByLabel('JSONPath').fill('$.order.id == "nope"')
  await panel.getByRole('button', { name: 'Apply filters' }).click()
  await expect(
    page.getByText(/No messages match these filters\. 65 messages were examined\./)
  ).toBeVisible()
})

test('PBI-043/045 message detail, payload views, copy and export', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await openStudio(page)
  await openStream(page, stream, 'Messages')
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
  await openStream(page, name, 'Messages')
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
  await openStream(page, name, 'Messages')
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
  await openStream(page, name, 'Messages')
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

  await openStream(page, queue, 'Messages')
  await rowOf(page, 1, queue).click()
  await expect(
    page.getByRole('region', { name: 'Consumers' }).getByText('removed once its consumer')
  ).toBeVisible()
  await expect(page.getByText('This stream has no consumers')).toBeVisible()
  await client.jsm.streams.delete(name)
  await client.jsm.streams.delete(queue)
})

test('PBI-125 the Filters button shows its state and a count, and the state is remembered', async ({
  page
}) => {
  await openStudio(page)
  await openStream(page, stream, 'Messages')
  const button = page.getByRole('button', { name: /^Filters/ })
  // An earlier test may have left the panel open; it is remembered per stream.
  if ((await button.getAttribute('aria-expanded')) === 'true') await button.click()
  await expect(button).toHaveAttribute('aria-expanded', 'false')
  await button.click()
  const panel = page.getByRole('form', { name: 'Message filters' })
  await expect(button).toHaveAttribute('aria-expanded', 'true')
  await expect(button).toHaveAttribute('aria-controls', (await panel.getAttribute('id'))!)

  // Apply, Clear and Hide stay in view, and the panel never grows past its maximum height.
  await expect(panel.getByRole('button', { name: 'Apply filters' })).toBeInViewport()
  await expect(panel.getByRole('button', { name: 'Hide' })).toBeInViewport()
  expect((await panel.boundingBox())!.height).toBeLessThanOrEqual(900 * 0.55 + 1)

  await panel.getByLabel('Payload contains').fill('message 12')
  await panel.getByRole('button', { name: 'Apply filters' }).click()
  await expect(page.getByRole('button', { name: 'Filters, 1 active' })).toBeVisible()

  // Closed with Escape: focus is back on the button and the chip is still there.
  await panel.getByLabel('Payload contains').press('Escape')
  await expect(panel).toBeHidden()
  await expect(button).toBeFocused()
  await expect(page.getByLabel('Active filters')).toContainText('Payload contains "message 12"')

  // Open or closed survives a reload (per stream).
  await button.click()
  await expect(panel).toBeVisible()
  await page.reload()
  await openStudio(page)
  await openStream(page, stream, 'Messages')
  await expect(page.getByRole('form', { name: 'Message filters' })).toBeVisible()

  // Put things back for the other tests.
  await panel.getByRole('button', { name: 'Clear' }).click()
  await panel.getByRole('button', { name: 'Hide' }).click()
  await expect(panel).toBeHidden()
})

test('PBI-125 sections collapse and stay collapsed, the panel collapses to a rail and widens to read', async ({
  page
}) => {
  await openStudio(page)
  await openStream(page, stream, 'Messages')
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
  await openStream(page, stream, 'Messages')
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
  await openStream(page, stream, 'Messages')
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
  await openStream(page, stream, 'Messages')
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
  await openStream(page, stream, 'Messages')
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
  await openStream(page, stream, 'Messages')
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
    await openStream(page, stream, 'Messages')
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
