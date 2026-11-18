import { headers } from '@nats-io/transport-node'
import { expect, test } from '@playwright/test'
import { go, nats, openMessages, openStudio, unique, type Nats } from './helpers'

let client: Nats
let tag: string
let orders: string
let pay: string
let ship: string

test.beforeAll(async () => {
  client = await nats()
  tag = unique('req').toLowerCase()
  orders = unique('TRORD')
  pay = unique('TRPAY')
  ship = unique('TRSHIP')
  for (const s of [orders, pay, ship])
    await client.jsm.streams.add({ name: s, subjects: [`${s}.>`], allow_direct: true })
  await client.jsm.consumers.add(pay, { durable_name: 'billing', ack_policy: 'explicit' as never })
  const hdr = (id: string) => {
    const h = headers()
    h.set('trace-id', id)
    return { headers: h }
  }
  // Another request first, then the one to follow: three hops in three streams, in this order.
  await client.js.publish(`${orders}.new`, '{"n":0}', hdr(`other-${tag}`))
  await client.js.publish(`${orders}.new`, '{"n":1}', hdr(tag))
  await new Promise((r) => setTimeout(r, 60))
  await client.js.publish(`${pay}.charge`, '{"n":2}', hdr(tag))
  await new Promise((r) => setTimeout(r, 60))
  await client.js.publish(`${ship}.pack`, '{"n":3}', hdr(tag))
})
test.afterAll(async () => {
  for (const s of [orders, pay, ship]) await client.jsm.streams.delete(s).catch(() => {})
  await client.nc.close()
})

test('PBI-138 follow a request across three streams from an open message', async ({ page }) => {
  await openStudio(page)
  await openMessages(page, orders)

  // Open the message of the request, and follow its trace id from the headers.
  const row = page
    .getByRole('table', { name: `Messages in ${orders}` })
    .getByRole('row')
    .filter({ hasText: '"n":1' })
  await row.click()
  const detail = page.getByRole('complementary', { name: 'Message detail' })
  const headersToggle = detail.getByRole('button', { name: /^Headers \(1\)/ })
  if ((await headersToggle.getAttribute('aria-expanded')) !== 'true') await headersToggle.click()
  await detail.getByRole('button', { name: `Follow trace-id ${tag} across streams` }).click()

  // A new Trace tab with the rule filled in; it runs at once and lists the hops in time order.
  await expect(page.getByRole('tab', { name: new RegExp(`^Trace ${tag}`) })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Header name 1' })).toHaveValue('trace-id')
  await expect(page.getByRole('textbox', { name: 'Value 1' })).toHaveValue(tag)
  await expect(page.getByRole('combobox', { name: 'Window' })).toHaveValue('around:15m')
  const timeline = page.getByRole('table', { name: 'Trace timeline' })
  const hops = timeline.getByRole('row').filter({ hasText: /\.(new|charge|pack)/ })
  await expect(hops).toHaveCount(3)
  await expect(hops.nth(0)).toContainText(`${orders}.new`)
  await expect(hops.nth(1)).toContainText(`${pay}.charge`)
  await expect(hops.nth(2)).toContainText(`${ship}.pack`)
  await expect(hops.nth(1)).toContainText(/\+\d+(\.\d)? (ms|s)/)
  // The consumer of the payments stream shows as a badge on its hop.
  await expect(hops.nth(1)).toContainText('billing')
  await expect(page.getByText(/3 messages · 3 subjects · 3 streams/)).toBeVisible()

  // Keyboard: the arrows only move the selection, Enter opens the detail, which then follows.
  await timeline.focus()
  await page.keyboard.press('ArrowDown')
  await expect(hops.nth(0)).toHaveAttribute('aria-selected', 'true')
  const panel = page.getByRole('complementary', { name: 'Message detail' })
  await expect(panel).toHaveCount(0)
  await page.keyboard.press('Enter')
  await expect(panel).toContainText(`${orders}.new`)
  await page.keyboard.press('ArrowDown')
  await expect(hops.nth(1)).toHaveAttribute('aria-selected', 'true')
  await expect(panel).toContainText(`${pay}.charge`)

  // Open that message on the Messages screen.
  await panel.getByRole('button', { name: 'Open in Messages' }).click()
  await expect(page.getByRole('combobox', { name: 'Stream', exact: true })).toHaveValue(pay)
  await expect(page.getByRole('table', { name: `Messages in ${pay}` })).toBeVisible()
  await expect(
    page
      .getByRole('table', { name: `Messages in ${pay}` })
      .getByRole('row')
      .filter({ hasText: `${pay}.charge` })
  ).toBeVisible()
})

test('PBI-138 run a trace from the left panel (text, then header)', async ({ page }) => {
  await openStudio(page)
  await go(page, 'Trace')
  await expect(page.getByText('Follow a request across streams')).toBeVisible()
  await page.getByRole('combobox', { name: 'Match type 1' }).selectOption('text')
  await page.getByRole('textbox', { name: 'Text 1' }).fill(tag)
  await page.getByRole('button', { name: 'Run trace' }).click()
  // The payloads do not carry the id (it is in the headers), so nothing is found, and it says so.
  await expect(page.getByText('No message matches')).toBeVisible()

  await page.getByRole('combobox', { name: 'Match type 1' }).selectOption('header')
  await page.getByRole('textbox', { name: 'Header name 1' }).fill('trace-id')
  await page.getByRole('textbox', { name: 'Value 1' }).fill(tag)
  await page.getByRole('button', { name: 'Run trace' }).click()
  const hops = page
    .getByRole('table', { name: 'Trace timeline' })
    .getByRole('row')
    .filter({ hasText: /\.(new|charge|pack)/ })
  await expect(hops).toHaveCount(3)
})

test('PBI-138 Lanes view: lanes and dots for a three-stream trace, open a message from a dot', async ({
  page
}) => {
  await openStudio(page)
  await go(page, 'Trace')
  await page.getByRole('textbox', { name: 'Header name 1' }).fill('trace-id')
  await page.getByRole('textbox', { name: 'Value 1' }).fill(tag)
  await page.getByRole('button', { name: 'Run trace' }).click()
  await expect(page.getByRole('table', { name: 'Trace timeline' })).toBeVisible()

  await page.getByRole('combobox', { name: 'View' }).selectOption('lanes')
  const lanes = page.getByRole('listbox', { name: 'Trace lanes' })
  await expect(lanes).toBeVisible()
  // One lane per subject, in the order the request went; one dot per message.
  const labels = page.getByTestId('lane-label')
  await expect(labels).toHaveText([`${orders}.new`, `${pay}.charge`, `${ship}.pack`])
  const dots = lanes.getByRole('option')
  await expect(dots).toHaveCount(3)
  await expect(dots.nth(1)).toHaveAccessibleName(
    new RegExp(
      `^${pay}\\.charge, ${pay}, \\d\\d:\\d\\d:\\d\\d\\.\\d{3}, \\+\\d+(\\.\\d)? (ms|s) after the previous message`
    )
  )

  // By stream the lanes are the streams.
  await page.getByRole('combobox', { name: 'Lane by' }).selectOption('stream')
  await expect(labels).toHaveText([orders, pay, ship])
  await page.getByRole('combobox', { name: 'Scale' }).selectOption('time')
  await expect(dots).toHaveCount(3)

  // Hovering shows the message; a click on a dot opens it in the detail pane.
  await dots.nth(2).hover()
  await expect(page.getByTestId('lane-tooltip')).toContainText(`${ship}.pack`)
  await dots.nth(1).click()
  const panel = page.getByRole('complementary', { name: 'Message detail' })
  await expect(panel).toContainText(`${pay}.charge`)
  await expect(dots.nth(1)).toHaveAttribute('aria-selected', 'true')

  // The keyboard moves the selection; the open detail follows it.
  await lanes.focus()
  await page.keyboard.press('ArrowRight')
  await expect(dots.nth(2)).toHaveAttribute('aria-selected', 'true')
  await expect(panel).toContainText(`${ship}.pack`)

  // Back to the Timeline: the same message stays selected.
  await page.getByRole('combobox', { name: 'View' }).selectOption('timeline')
  await expect(
    page
      .getByRole('table', { name: 'Trace timeline' })
      .getByRole('row')
      .filter({ hasText: `${ship}.pack` })
  ).toHaveAttribute('aria-selected', 'true')
})
