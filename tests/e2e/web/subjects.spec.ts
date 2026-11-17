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

test('PBI-127 subjects: select, Expand all, search, row menu, browse, tail, publish', async ({
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

  // Selecting a row fills the detail pane.
  await expect(row(stream)).toContainText('5')
  await row(`${stream}.eu`).click()
  await expect(row(`${stream}.eu`)).toHaveAttribute('aria-selected', 'true')
  await expect(
    page.getByRole('complementary', { name: 'Subject details' }).getByRole('heading')
  ).toHaveText(`${stream}.eu`)

  // Expand all and Collapse all.
  await narrow(page, `${stream}.`)
  await page.getByRole('button', { name: 'Collapse all' }).click()
  await expect(row(`${stream}.eu`)).toHaveCount(0)
  await page.getByRole('button', { name: 'Expand all' }).click()
  await expect(row(`${stream}.eu.created`)).toContainText('3')
  await expect(row(`${stream}.us.created`)).toBeVisible()

  // Search keeps ancestors and marks the match.
  await page.getByLabel('Search subjects').fill(`${stream}.eu.ship`)
  await expect(row(`${stream}.eu.shipped`)).toBeVisible()
  await expect(row(`${stream}.eu.shipped`).locator('mark')).toHaveText('ship')
  await expect(row(`${stream}.us`)).toHaveCount(0)
  await expect(page.getByText('1 match')).toBeVisible()

  // Row menu: browse stored messages with the subject filter.
  await narrow(page, `${stream}.eu`)
  const menuButton = row(`${stream}.eu`).getByRole('button', { name: `Actions for ${stream}.eu` })
  await menuButton.click()
  await expect(page.getByRole('menu')).toBeVisible()
  await page.getByRole('menuitem', { name: `Browse stored messages on ${stream}.eu.>` }).click()
  await expect(page.getByRole('tab', { name: 'Messages' })).toBeVisible()
  await expect(page.getByLabel('Subject filter')).toHaveValue(`${stream}.eu.>`)
  await expect(page.getByTestId('message-range')).toContainText('4 messages')

  // Live tail on the subject.
  await go(page, 'Subjects')
  await narrow(page, `${stream}.eu`)
  await row(`${stream}.eu`)
    .getByRole('button', { name: `Actions for ${stream}.eu` })
    .click()
  await page.getByRole('menuitem', { name: `Live tail on ${stream}.eu.>` }).click()
  await expect(page.getByText(`Waiting for messages on ${stream}.eu.>`)).toBeVisible()
  await page.getByRole('button', { name: 'Stop' }).click()

  // Publish, prefilled with the subject.
  await go(page, 'Subjects')
  await narrow(page, `${stream}.eu`)
  await row(`${stream}.eu`)
    .getByRole('button', { name: `Actions for ${stream}.eu` })
    .click()
  await page.getByRole('menuitem', { name: `Publish to ${stream}.eu` }).click()
  await expect(page.getByRole('textbox', { name: 'Subject', exact: true })).toHaveValue(
    `${stream}.eu`
  )

  await jsm.streams.delete(stream)
  await nc.close()
})

test('PBI-127 subjects: a read-only connection cannot publish from the row menu', async ({
  page
}) => {
  await openStudio(page, 'Production')
  await go(page, 'Subjects', 'Production')
  const tree = await narrow(page, 'orders')
  const first = tree
    .getByRole('row')
    .filter({ has: page.getByRole('button', { name: /^Actions for / }) })
    .first()
  await expect(first).toBeVisible()
  await first.getByRole('button', { name: /^Actions for / }).click()
  await expect(page.getByRole('menuitem', { name: /^Publish to / })).toBeDisabled()
  await expect(page.getByRole('menuitem', { name: /^Live tail on / })).toBeEnabled()
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
  const tree = await narrow(page, `${stream}.`)
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
  await page.keyboard.press('Enter')
  await expect(row(`${stream}.a`)).toHaveAttribute('aria-selected', 'true')
  // Shift+F10 opens the row menu; Escape returns to the row.
  await page.keyboard.press('Shift+F10')
  await expect(page.getByRole('menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(row(`${stream}.a`)).toBeFocused()

  // The pane collapses to a rail and opens again.
  await page.getByRole('button', { name: 'Collapse panel' }).click()
  await expect(
    page.getByRole('complementary', { name: 'Subject details (collapsed)' })
  ).toBeVisible()
  await page.getByRole('button', { name: 'Show subject details' }).click()
  await expect(page.getByRole('complementary', { name: 'Subject details' })).toBeVisible()

  await jsm.streams.delete(stream)
  await nc.close()
})
