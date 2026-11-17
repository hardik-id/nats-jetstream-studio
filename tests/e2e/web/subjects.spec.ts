import { expect, test, type Page } from '@playwright/test'
import { go, nats, openStudio, unique } from './helpers'

/** The demo server has many subjects and the tree is virtualised: search narrows it to a stream. */
async function narrow(page: Page, text: string) {
  await page.getByLabel('Search subjects').fill(text)
  // The query is applied after a short pause; wait for it before acting on the result.
  await expect(page.getByRole('toolbar').getByRole('status')).toHaveText(/^\d+ match(es)?$/)
  return page.getByRole('treegrid', { name: 'Subjects' })
}

const levels = (page: Page, name: string) =>
  page.getByRole('group', { name: 'Levels' }).getByRole('button', { name, exact: true })

const detail = (page: Page) => page.getByTestId('subject-detail')

test('PBI-127 subjects: fresh state at 1000x700, one click shows every labelled action', async ({
  page
}) => {
  // This runs first in the file, so the saved view of the connection is still empty.
  await page.setViewportSize({ width: 1000, height: 700 })
  await openStudio(page)
  await go(page, 'Subjects')
  const tree = page.getByRole('treegrid', { name: 'Subjects' })
  await expect(tree.getByRole('row').nth(1)).toBeVisible()
  await tree.getByRole('row').nth(1).click()
  const pane = page.getByTestId('subject-detail')
  await expect(pane).toBeVisible()
  for (const name of [
    'Browse stored messages',
    'Start live tail',
    'Publish message',
    'Copy subject'
  ])
    await expect(pane.getByRole('button', { name })).toBeInViewport({ ratio: 1 })
})

test('PBI-127 subjects: select, Expand all, search, scope, browse, tail, publish', async ({
  page
}) => {
  const stream = unique('SUBJ')
  const { jsm, js, nc } = await nats()
  await jsm.streams.add({ name: stream, subjects: [`${stream}.>`] })
  for (let i = 0; i < 3; i++) await js.publish(`${stream}.eu.created`, 'x')
  await js.publish(`${stream}.eu.shipped`, 'x')
  await js.publish(`${stream}.us.created`, 'x')

  await openStudio(page)
  await go(page, 'Subjects')
  const tree = await narrow(page, `${stream}.`)
  const row = (name: string) => tree.getByRole('row', { name, exact: true })

  // Selecting a row fills the detail pane; a branch defaults to everything below it.
  await expect(row(stream)).toContainText('5')
  await row(`${stream}.eu`).click()
  await expect(row(`${stream}.eu`)).toHaveAttribute('aria-selected', 'true')
  await expect(detail(page).getByRole('heading', { level: 3 })).toHaveText(`${stream}.eu`)
  await expect(page.getByTestId('subject-filter')).toHaveText(`${stream}.eu.>`)

  // Expand all and Collapse all.
  // Expand all opens what the search shows: the ancestors of the matches.
  await narrow(page, `${stream}.*.created`)
  await page.getByRole('button', { name: 'Collapse all' }).click()
  await expect(row(`${stream}.eu`)).toHaveCount(0)
  await page.getByRole('button', { name: 'Expand all' }).click()
  await expect(row(`${stream}.eu.created`)).toContainText('3')
  await expect(row(`${stream}.us.created`)).toBeVisible()

  // Search keeps ancestors and marks the match.
  await narrow(page, `${stream}.eu.ship`)
  await expect(row(`${stream}.eu.shipped`).locator('mark')).toHaveText('ship')
  await expect(row(`${stream}.us`)).toHaveCount(0)
  await expect(page.getByText('1 match')).toBeVisible()

  // Browse from the pane: the filter of the scope is applied in the stream's Messages tab.
  await narrow(page, `${stream}.eu`)
  await row(`${stream}.eu`).click()
  await detail(page).getByRole('button', { name: 'Browse stored messages' }).click()
  await expect(page.getByRole('tab', { name: 'Messages' })).toBeVisible()
  await expect(page.getByLabel('Subject filter')).toHaveValue(`${stream}.eu.>`)
  await expect(page.getByTestId('message-range')).toContainText('4 messages')

  // A wildcard scope: one level below.
  await go(page, 'Subjects')
  await narrow(page, `${stream}.eu`)
  await row(`${stream}.eu`).click()
  await detail(page)
    .getByLabel(/^One level below/)
    .check()
  await expect(page.getByTestId('subject-filter')).toHaveText(`${stream}.eu.*`)
  await detail(page).getByRole('button', { name: 'Browse stored messages' }).click()
  await expect(page.getByLabel('Subject filter')).toHaveValue(`${stream}.eu.*`)
  await expect(page.getByTestId('message-range')).toContainText('4 messages')

  // Live tail starts on the filter; Publish is not offered for a wildcard.
  await go(page, 'Subjects')
  await narrow(page, `${stream}.eu`)
  await row(`${stream}.eu`).click()
  await expect(detail(page).getByRole('button', { name: 'Publish message' })).toBeDisabled()
  await detail(page).getByRole('button', { name: 'Start live tail' }).click()
  await expect(page.getByText(`Waiting for messages on ${stream}.eu.*`)).toBeVisible()
  await page.getByRole('button', { name: 'Stop' }).click()

  // Publish on a leaf is prefilled with the exact subject.
  await go(page, 'Subjects')
  await narrow(page, `${stream}.eu.created`)
  await row(`${stream}.eu.created`).click()
  await expect(page.getByTestId('subject-filter')).toHaveText(`${stream}.eu.created`)
  await detail(page).getByRole('button', { name: 'Publish message' }).click()
  await expect(page.getByRole('textbox', { name: 'Subject', exact: true })).toHaveValue(
    `${stream}.eu.created`
  )

  // The row menu does the same with the filter in its labels.
  await go(page, 'Subjects')
  await narrow(page, `${stream}.eu`)
  await row(`${stream}.eu`).click()
  await detail(page)
    .getByLabel(/^One level below/)
    .check()
  await row(`${stream}.eu`)
    .getByRole('button', { name: `Actions for ${stream}.eu` })
    .click()
  await expect(page.getByRole('menu')).toBeVisible()
  // The selected row's menu uses the scope chosen in the pane (one level below).
  await page.getByRole('menuitem', { name: `Browse stored messages on ${stream}.eu.*` }).click()
  await expect(page.getByLabel('Subject filter')).toHaveValue(`${stream}.eu.*`)

  // Enter selects the row and stays in the tree: nothing is opened.
  await go(page, 'Subjects')
  await narrow(page, `${stream}.us`)
  await row(`${stream}.us`).focus()
  await page.keyboard.press('Enter')
  await expect(row(`${stream}.us`)).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('subject-filter')).toHaveText(`${stream}.us.>`)
  await expect(page.getByRole('tab', { name: 'Subjects' })).toHaveAttribute('aria-selected', 'true')

  await jsm.streams.delete(stream)
  await nc.close()
})

test('PBI-127 subjects: several streams hold a subject, the pane offers a stream choice', async ({
  page
}) => {
  const stream = unique('ORIG')
  const copy = `${stream}_COPY`
  const { jsm, js, nc } = await nats()
  await jsm.streams.add({ name: stream, subjects: [`${stream}.>`] })
  await js.publish(`${stream}.a`, 'x')
  await js.publish(`${stream}.a`, 'x')
  await jsm.streams.add({ name: copy, sources: [{ name: stream }] })
  await expect
    .poll(async () => (await jsm.streams.info(copy)).state.messages, { timeout: 15000 })
    .toBe(2)

  await openStudio(page)
  await go(page, 'Subjects')
  const tree = await narrow(page, `${stream}.a`)
  await tree.getByRole('row', { name: `${stream}.a`, exact: true }).click()
  const chooser = detail(page).getByRole('button', { name: /^Stream to browse:/ })
  await expect(chooser).toBeVisible()
  await chooser.click()
  await page.getByRole('menuitem', { name: copy }).click()
  await detail(page).getByRole('button', { name: 'Browse stored messages' }).click()
  await expect(page.getByRole('tab', { name: 'Messages' })).toBeVisible()
  await expect(page.getByLabel('Subject filter')).toHaveValue(`${stream}.a`)
  await expect(page.getByTestId('message-range')).toContainText('2 messages')

  await jsm.streams.delete(copy)
  await jsm.streams.delete(stream)
  await nc.close()
})

test('PBI-127 subjects: a read-only connection cannot publish from the pane or the row menu', async ({
  page
}) => {
  await openStudio(page, 'Production')
  await go(page, 'Subjects', 'Production')
  const tree = await narrow(page, 'orders.us.paid')
  const leaf = tree.getByRole('row', { name: 'orders.us.paid', exact: true })
  await leaf.click()
  await expect(page.getByTestId('subject-filter')).toHaveText('orders.us.paid')
  const publish = detail(page).getByRole('button', { name: 'Publish message' })
  await expect(publish).toBeDisabled()
  await expect(publish).toHaveAttribute('title', /read-only/)
  await expect(detail(page).getByRole('button', { name: 'Start live tail' })).toBeEnabled()
  await leaf.getByRole('button', { name: /^Actions for / }).click()
  await expect(page.getByRole('menuitem', { name: /^Publish message to / })).toBeDisabled()
  await expect(page.getByRole('menuitem', { name: /^Start live tail on / })).toBeEnabled()
})

test('PBI-127 subjects: keyboard navigation and the collapsible pane', async ({ page }) => {
  const stream = unique('KEYS')
  const { jsm, js, nc } = await nats()
  await jsm.streams.add({ name: stream, subjects: [`${stream}.>`] })
  await js.publish(`${stream}.a.one`, 'x')
  await js.publish(`${stream}.a.two`, 'x')
  await js.publish(`${stream}.b.one`, 'x')

  await openStudio(page)
  await go(page, 'Subjects')
  const tree = await narrow(page, `${stream}.*.*`)
  const row = (name: string) => tree.getByRole('row', { name, exact: true })
  await levels(page, 'All').click()
  await expect(row(`${stream}.a.one`)).toBeVisible()

  // One tab stop: the row that was last used.
  await row(stream).focus()
  await page.keyboard.press('ArrowDown')
  await expect(row(`${stream}.a`)).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(row(`${stream}.a`)).toHaveAttribute('aria-expanded', 'false')
  await page.keyboard.press('ArrowRight')
  await expect(row(`${stream}.a`)).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('ArrowRight')
  await expect(row(`${stream}.a.one`)).toBeFocused()
  await page.keyboard.press('End')
  await expect(row(`${stream}.b.one`)).toBeFocused()
  await page.keyboard.press('Home')
  await expect(row(stream)).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Space')
  await expect(row(`${stream}.a`)).toHaveAttribute('aria-selected', 'true')
  // Shift+F10 opens the row menu; Escape returns to the row.
  await page.keyboard.press('Shift+F10')
  await expect(page.getByRole('menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(row(`${stream}.a`)).toBeFocused()

  // The pane collapses to a rail and opens again.
  await page.getByRole('button', { name: 'Collapse details' }).click()
  await expect(
    page.getByRole('complementary', { name: 'Subject details (collapsed)' })
  ).toBeVisible()
  await page.getByRole('button', { name: 'Show subject details' }).click()
  await expect(page.getByRole('complementary', { name: 'Subject details' })).toBeVisible()

  await jsm.streams.delete(stream)
  await nc.close()
})

/** Six streams of 5,000 subjects each: 30,000 subjects, one level with 5,000 siblings per root. */
async function bigData(): Promise<{ prefix: string; cleanup: () => Promise<void> }> {
  const prefix = unique('bg').toLowerCase()
  const { jsm, nc } = await nats()
  const names: string[] = []
  for (let n = 0; n < 6; n++) {
    const name = `${prefix.toUpperCase()}_${n}`
    names.push(name)
    await jsm.streams.add({ name, subjects: [`${prefix}${n}.>`] })
    for (let i = 0; i < 5000; i++) nc.publish(`${prefix}${n}.s${i}`, 'x')
  }
  await nc.flush()
  await expect
    .poll(
      async () => {
        let total = 0
        for (const name of names) total += (await jsm.streams.info(name)).state.messages
        return total
      },
      { timeout: 60000 }
    )
    .toBe(30000)
  return {
    prefix,
    cleanup: async () => {
      for (const name of names) await jsm.streams.delete(name)
      await nc.close()
    }
  }
}

for (const size of [
  { width: 1280, height: 720 },
  { width: 1000, height: 700 }
]) {
  test(`PBI-127 subjects: 30,000 subjects at ${size.width}x${size.height}, actions visible`, async ({
    page
  }) => {
    test.setTimeout(120_000)
    const { prefix, cleanup } = await bigData()
    try {
      await page.setViewportSize(size)
      await openStudio(page)
      await go(page, 'Subjects')
      const tree = page.getByRole('treegrid', { name: 'Subjects' })
      await expect(tree.getByRole('row', { name: `${prefix}0`, exact: true })).toBeVisible({
        timeout: 30_000
      })
      const rowCount = async (): Promise<number> => Number(await tree.getAttribute('aria-rowcount'))
      await page.getByRole('group', { name: 'Levels' }).getByRole('button', { name: '2' }).click()
      await expect.poll(rowCount, { timeout: 30_000 }).toBeGreaterThan(30000)
      const before = await rowCount()
      // Expand all never closes anything, even when the cap is already passed.
      await page.getByRole('button', { name: 'Expand all' }).click()
      expect(await rowCount()).toBeGreaterThanOrEqual(before)
      // The DOM holds a window of rows only.
      expect(await tree.getByRole('row').count()).toBeLessThan(100)

      // The search box stays readable once the match count shows.
      await page.getByLabel('Search subjects').fill(`${prefix}3`)
      await expect(page.getByRole('toolbar').getByRole('status')).toHaveText(/\d+ match/)
      const input = await page.getByLabel('Search subjects').boundingBox()
      expect(input!.width).toBeGreaterThanOrEqual(180)

      // Select a subject: every labelled action is on screen without scrolling.
      await page.getByLabel('Search subjects').fill(`${prefix}1.s10`)
      const leaf = tree.getByRole('row', { name: `${prefix}1.s10`, exact: true })
      await leaf.click()
      const rail = page.getByRole('button', { name: 'Show subject details' })
      if (await rail.isVisible()) await rail.click()
      const pane = page.getByTestId('subject-detail')
      await expect(pane.getByRole('heading', { level: 3 })).toHaveText(`${prefix}1.s10`)
      for (const name of [
        'Browse stored messages',
        'Start live tail',
        'Publish message',
        'Copy subject'
      ])
        await expect(pane.getByRole('button', { name })).toBeInViewport({ ratio: 1 })
    } finally {
      await cleanup()
    }
  })
}
