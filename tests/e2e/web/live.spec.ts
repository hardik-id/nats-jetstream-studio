import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { headers } from '@nats-io/transport-node'
import { expect, test } from '@playwright/test'
import { go, nats, openStudio, toast, unique } from './helpers'

test('PBI-060 live tail: start, receive, pause, resume, clear, detail', async ({ page }) => {
  const prefix = unique('tail').toLowerCase()
  const { nc } = await nats()
  await openStudio(page)
  await go(page, 'Live tail')

  // An invalid subject cannot be started.
  await page.getByLabel('Subject', { exact: true }).fill('bad..subject')
  await expect(page.getByText('Subject cannot have empty tokens')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start' })).toBeDisabled()

  await page.getByLabel('Subject', { exact: true }).fill(`${prefix}.>`)
  await page.getByRole('button', { name: 'Start' }).click()
  await expect(page.getByText(`Waiting for messages on ${prefix}.>`)).toBeVisible()
  await expect(
    page.getByRole('tablist', { name: 'Open tabs' }).getByRole('tab', { name: `Tail ${prefix}.>` })
  ).toBeVisible()

  const hdrs = headers()
  hdrs.set('Trace-Id', 'live-1')
  nc.publish(`${prefix}.orders.created`, JSON.stringify({ id: 1, hello: 'tail' }), {
    headers: hdrs
  })
  nc.publish(`${prefix}.orders.shipped`, 'plain text')
  nc.publish(`other.${prefix}`, 'must not show up')
  const table = page.getByRole('table', { name: 'Live messages' })
  await expect(table.getByRole('row')).toHaveCount(3)
  await expect(table.getByRole('row').nth(1)).toContainText(`${prefix}.orders.created`)
  await expect(table.getByRole('row').nth(1)).toContainText('{"id":1,"hello":"tail"}')
  await expect(page.getByTestId('tail-received')).toHaveText('2')
  await expect(page.getByTestId('tail-dropped')).toHaveText('0')

  // Clicking a message opens the detail viewer.
  await table.getByRole('row').nth(1).click()
  const detail = page.getByRole('complementary', { name: 'Message detail' })
  // Headers start closed in the detail panel (PBI-125).
  const headersToggle = detail.getByRole('button', { name: /^Headers/ })
  if ((await headersToggle.getAttribute('aria-expanded')) !== 'true') await headersToggle.click()
  await expect(detail.getByRole('row', { name: /Trace-Id/ })).toContainText('live-1')
  await expect(detail.getByTestId('payload-body')).toContainText('"tail"')
  await detail.getByRole('button', { name: 'Close message detail' }).click()

  // Pause freezes the list while messages keep arriving; resume shows them.
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  nc.publish(`${prefix}.while.paused`, 'x')
  nc.publish(`${prefix}.while.paused`, 'y')
  await expect(
    page.getByText(/Paused\. The list is frozen; 2 newer messages are waiting\./)
  ).toBeVisible()
  await expect(table.getByRole('row')).toHaveCount(3)
  await page.getByRole('button', { name: 'Resume' }).first().click()
  await expect(table.getByRole('row')).toHaveCount(5)

  // Find in list, then clear.
  await page.getByLabel('Find in list').fill('shipped')
  await expect(table.getByRole('row')).toHaveCount(2)
  await page.getByLabel('Find in list').fill('')
  await page.getByRole('button', { name: 'Clear', exact: true }).click()
  await expect(page.getByTestId('tail-received')).toHaveText('0')
  await expect(page.getByText(`Waiting for messages on ${prefix}.>`)).toBeVisible()

  // Rate is shown while messages flow.
  for (let i = 0; i < 40; i++) nc.publish(`${prefix}.burst`, String(i))
  await expect(page.getByTestId('tail-received')).toHaveText('40')
  await expect(page.getByTestId('tail-rate')).toHaveText(/\d+(\.\d+)?\/s/)

  // Stop ends the subscription; a second tail can run in its own tab.
  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible()
  // Give the gateway a moment to drop its subscription before publishing again.
  await page.waitForTimeout(300)
  nc.publish(`${prefix}.after.stop`, 'x')
  await nc.flush()
  await page.waitForTimeout(400)
  await expect(page.getByTestId('tail-received')).toHaveText('40')
  await page.getByRole('button', { name: 'New tail' }).click()
  await expect(
    page.getByRole('tablist', { name: 'Open tabs' }).getByRole('tab', { name: /tail/i })
  ).toHaveCount(2)
  await nc.close()
})

test('PBI-060 the buffer is capped and drops are counted; production asks before ">"', async ({
  page
}) => {
  const prefix = unique('cap').toLowerCase()
  const { nc } = await nats()
  await openStudio(page)
  await go(page, 'Live tail')
  await page.getByLabel('Keep newest').selectOption('1000')
  await page.getByLabel('Subject', { exact: true }).fill(`${prefix}.>`)
  await page.getByRole('button', { name: 'Start' }).click()
  await expect(page.getByText(`Waiting for messages on ${prefix}.>`)).toBeVisible()
  for (let i = 0; i < 2500; i++) nc.publish(`${prefix}.n`, String(i))
  await nc.flush()
  await expect(page.getByTestId('tail-received')).toHaveText('2,500')
  await expect(page.getByTestId('tail-dropped')).toHaveText('1,500')
  // The newest message is the last row.
  await expect(
    page.getByRole('table', { name: 'Live messages' }).getByRole('row').last()
  ).toContainText('2499')
  await page.getByRole('button', { name: 'Stop' }).click()

  await openStudio(page, 'Production')
  await go(page, 'Live tail', 'Production')
  await page.getByLabel('Subject', { exact: true }).last().fill('>')
  await page.getByRole('button', { name: 'Start' }).last().click()
  const confirm = page.getByRole('dialog', { name: 'Subscribe to every subject on production?' })
  await expect(confirm).toContainText('Production')
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByText('Enter a subject and press Start').last()).toBeVisible()
  await nc.close()
})

test('PBI-062 publish, JetStream publish with ack, request/reply, templates and history', async ({
  page
}) => {
  const stream = unique('PUB')
  const { jsm, nc } = await nats()
  await jsm.streams.add({ name: stream, subjects: [`${stream}.>`] })
  const responder = nc.subscribe(`${stream}-svc`, {
    callback: (_e, m) => {
      m.respond(JSON.stringify({ echoed: m.string(), via: m.headers?.get('X-Ask') ?? null }))
    }
  })
  await openStudio(page)
  await go(page, 'Publish')
  const form = page.locator('form').filter({ has: page.getByLabel('Send as') })

  // JetStream publish shows the acknowledgement.
  await form.getByLabel('Subject', { exact: true }).fill(`${stream}.created`)
  await form.getByLabel('Send as').selectOption('jetstream')
  await form.getByRole('button', { name: 'Add header' }).click()
  await form.getByLabel('Header 1 name').fill('Nats-Msg-Id')
  await form.getByLabel('Header 1 value').fill('once')
  await form.getByLabel('Payload').fill('{"a": 1, "b": [1,2]}')
  await expect(form.getByText('Valid JSON')).toBeVisible()
  await form.getByRole('button', { name: 'Format' }).click()
  await expect(form.getByLabel('Payload')).toHaveValue(
    '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}'
  )
  await form.getByRole('button', { name: 'Publish', exact: true }).click()
  await expect(page.getByText(`Stored in stream ${stream} as sequence 1.`)).toBeVisible()
  const stored = await jsm.streams.getMessage(stream, { seq: 1 })
  expect(stored?.json()).toEqual({ a: 1, b: [1, 2] })
  expect(stored?.header.get('Nats-Msg-Id')).toBe('once')

  // The same message ID again is reported as a duplicate. Ctrl+Enter sends.
  await form.getByLabel('Payload').press('Control+Enter')
  await expect(page.getByText('Duplicate: the stream already had this message ID')).toBeVisible()

  // Invalid JSON is flagged but can still be sent as text.
  await form.getByLabel('Payload').fill('{"broken": ')
  await expect(form.getByText(/Not valid JSON/)).toBeVisible()

  // Core publish does not claim delivery.
  await form.getByLabel('Send as').selectOption('core')
  await form.getByLabel('Payload').fill('hello core')
  await form.getByRole('button', { name: 'Publish', exact: true }).click()
  await expect(
    page.getByText(/Published 10 B to .*\. Core NATS does not confirm delivery\./)
  ).toBeVisible()

  // Request shows the reply and its round-trip time.
  await form.getByLabel('Subject', { exact: true }).fill(`${stream}-svc`)
  await form.getByLabel('Send as').selectOption('request')
  await form.getByLabel('Header 1 name').fill('X-Ask')
  await form.getByLabel('Header 1 value').fill('nicely')
  await form.getByLabel('Payload').fill('ping')
  await form.getByRole('button', { name: 'Send request' }).click()
  await expect(page.getByText(/Reply in [\d.]+ ms/)).toBeVisible()
  await expect(page.getByTestId('payload-body').last()).toContainText('"echoed"')
  await expect(page.getByTestId('payload-body').last()).toContainText('"nicely"')

  // No responders and timeouts are reported as such.
  await form.getByLabel('Subject', { exact: true }).fill(`${stream}-nobody`)
  await form.getByRole('button', { name: 'Send request' }).click()
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: `No responders: nothing is listening on "${stream}-nobody"` })
  ).toBeVisible()

  // Templates and history.
  await form.getByLabel('Subject', { exact: true }).fill(`${stream}-svc`)
  await form.getByRole('button', { name: 'Save as template' }).click()
  await page
    .getByRole('dialog', { name: 'Save as template' })
    .getByLabel('Template name')
    .fill('Ping the service')
  await page
    .getByRole('dialog', { name: 'Save as template' })
    .getByRole('button', { name: 'Save' })
    .click()
  await form.getByLabel('Subject', { exact: true }).fill('something.else')
  await form.getByLabel('Payload').fill('other')
  await page
    .locator('section')
    .filter({ hasText: 'Templates' })
    .getByRole('button', { name: /^Ping the service/ })
    .click()
  await expect(form.getByLabel('Subject', { exact: true })).toHaveValue(`${stream}-svc`)
  await expect(form.getByLabel('Payload')).toHaveValue('ping')
  await expect(form.getByLabel('Send as')).toHaveValue('request')
  const history = page.locator('section').filter({ hasText: 'Recently sent' })
  await expect(
    history
      .getByRole('button')
      .filter({ hasText: `${stream}.created` })
      .first()
  ).toBeVisible()
  await page.getByRole('button', { name: 'Delete template Ping the service' }).click()

  responder.unsubscribe()
  await jsm.streams.delete(stream)
  await nc.close()
})
test('PBI-119 a long reply is fully visible: the editor and the reply each scroll in their box', async ({
  page
}) => {
  const subject = `${unique('BIG').toLowerCase()}.svc`
  const { nc } = await nats()
  const responder = nc.subscribe(subject, {
    callback: (_e, m) => {
      const lines = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`)
      m.respond(lines.join('\n'))
    }
  })
  for (const size of [
    { width: 1280, height: 720 },
    { width: 1440, height: 900 }
  ]) {
    await page.setViewportSize(size)
    await openStudio(page)
    await go(page, 'Publish')
    const form = page.locator('form').filter({ has: page.getByLabel('Send as') })
    await form.getByLabel('Subject', { exact: true }).fill(subject)
    await form.getByLabel('Send as').selectOption('request')
    await form.getByLabel('Payload').fill('go')
    await form.getByRole('button', { name: 'Send request' }).click()
    await expect(page.getByText(/Reply in [\d.]+ ms/)).toBeVisible()
    const body = page.getByTestId('payload-body').last()
    await expect(body).toContainText('line 80')
    // The reply box ends inside the window, and its last line is reachable by scrolling it.
    const box = await body.boundingBox()
    expect(box!.y + box!.height).toBeLessThanOrEqual(size.height)
    expect(box!.height).toBeGreaterThan(150)
    await body.evaluate((el) => (el.scrollTop = el.scrollHeight))
    expect(await body.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
    await expect(body).toBeInViewport({ ratio: 1 })
  }
  responder.unsubscribe()
  await nc.close()
})

test('PBI-061 subject tree: hierarchy, counts, search and actions', async ({ page }) => {
  const stream = unique('TREE')
  const { jsm, js, nc } = await nats()
  await jsm.streams.add({ name: stream, subjects: [`${stream}.>`] })
  for (let i = 0; i < 4; i++) await js.publish(`${stream}.eu.created`, 'x')
  for (let i = 0; i < 2; i++) await js.publish(`${stream}.eu.shipped`, 'x')
  await js.publish(`${stream}.us.created`, 'x')

  await openStudio(page)
  await go(page, 'Subjects')
  const tree = page.getByRole('treegrid', { name: 'Subjects' })
  const row = (name: string) => tree.getByRole('row', { name, exact: true })
  // The demo server has many subjects; search narrows the virtualised tree to this stream.
  await page.getByLabel('Search subjects').fill(`${stream}.`)
  await expect(row(stream)).toContainText('7')
  await expect(row(stream)).toContainText(stream)
  await expect(page.getByText(/matches$/)).toBeVisible()
  await page.getByRole('group', { name: 'Levels' }).getByRole('button', { name: '1' }).click()
  await expect(row(`${stream}.eu`)).toHaveCount(0)
  await page.getByRole('group', { name: 'Levels' }).getByRole('button', { name: '2' }).click()
  await expect(row(`${stream}.eu`)).toContainText('6')
  await expect(row(`${stream}.eu.created`)).toHaveCount(0)
  await row(`${stream}.eu`)
    .getByRole('button', { name: `Expand ${stream}.eu` })
    .click()
  await expect(row(`${stream}.eu.created`)).toContainText('4')

  // Search keeps the ancestors of a match and drops the rest.
  await page.getByLabel('Search subjects').fill(`${stream}.us.cre`)
  await expect(row(`${stream}.us.created`)).toBeVisible()
  await expect(row(`${stream}.us`)).toBeVisible()
  await expect(row(`${stream}.eu`)).toHaveCount(0)
  await page.getByLabel('Search subjects').fill(`${stream}.eu`)

  // Browse stored messages for a branch, from the row menu.
  await row(`${stream}.eu`)
    .getByRole('button', { name: `Actions for ${stream}.eu` })
    .click()
  await page.getByRole('menuitem', { name: `Browse stored messages on ${stream}.eu.>` }).click()
  await expect(page.getByLabel('Subject filter')).toHaveValue(`${stream}.eu.>`)
  await expect(page.getByTestId('message-range')).toContainText('6 messages')

  // Subjects seen only in a live tail show up marked live.
  const live = unique('livesubj').toLowerCase()
  await go(page, 'Live tail')
  await page.getByRole('textbox', { name: 'Subject', exact: true }).fill(`${live}.>`)
  await page.getByRole('button', { name: 'Start' }).click()
  await expect(page.getByText(`Waiting for messages on ${live}.>`)).toBeVisible()
  nc.publish(`${live}.ping`, 'x')
  await expect(page.getByTestId('tail-received')).toHaveText('1')
  await page.getByRole('button', { name: 'Stop' }).click()
  await go(page, 'Subjects')
  await page.getByLabel('Search subjects').fill(live)
  await expect(row(live)).toContainText('live')
  await jsm.streams.delete(stream)
  await nc.close()
})

test('PBI-070 KV: buckets, keys, values, history, edit, delete, purge, watch', async ({ page }) => {
  const bucket = unique('kv').toLowerCase()
  const { nc } = await nats()
  await openStudio(page)
  await go(page, 'KV buckets')
  const buckets = page.getByRole('table', { name: 'KV buckets' })
  await expect(buckets.getByRole('button', { name: 'app-config', exact: true })).toBeVisible()
  await expect(buckets.getByRole('row').filter({ hasText: 'app-config' })).toContainText(
    'Service configuration'
  )

  await page.getByRole('button', { name: 'New bucket' }).click()
  const create = page.getByRole('dialog', { name: 'New KV bucket' })
  await create.getByLabel('Name').fill('bad name!')
  await expect(create.getByText('Use letters, digits, "_" and "-" only')).toBeVisible()
  await create.getByLabel('Name').fill(bucket)
  await create.getByLabel('History per key').fill('5')
  await create.getByRole('button', { name: 'Create bucket' }).click()
  await expect(toast(page, `Created bucket ${bucket}`)).toBeVisible()
  await expect(page.getByText('This bucket has no keys')).toBeVisible()

  // Put keys, see values and history.
  for (const [key, value] of [
    ['app.mode', 'blue'],
    ['app.limit', '{"rps": 100}']
  ] as const) {
    await page.getByRole('button', { name: 'New key' }).click()
    const put = page.getByRole('dialog', { name: `New key in ${bucket}` })
    await put.getByLabel('Key').fill(key)
    await put.getByLabel('Value').fill(value)
    await put.getByRole('button', { name: 'Save' }).click()
    await expect(toast(page, `Saved ${key} as revision`)).toBeVisible()
  }
  const keys = page.getByRole('table', { name: 'Keys' })
  await expect(keys.getByRole('row')).toHaveCount(3)
  await keys.getByRole('row').filter({ hasText: 'app.limit' }).click()
  await expect(page.getByTestId('payload-body')).toContainText('"rps"')
  await expect(page.getByText(/Revision 2/)).toBeVisible()

  await page.getByRole('button', { name: 'Edit value' }).click()
  const edit = page.getByRole('dialog', { name: 'Edit app.limit' })
  await expect(edit.getByLabel('Value')).toHaveValue('{"rps": 100}')
  await edit.getByLabel('Value').fill('{"rps": 250}')
  await edit.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText(/Revision 3/)).toBeVisible()
  await expect(page.getByTestId('payload-body')).toContainText('250')
  // An older revision can be looked at.
  await page.getByRole('button', { name: /rev 2/ }).click()
  await expect(page.getByTestId('payload-body')).toContainText('100')
  await page.getByRole('button', { name: 'Show the latest revision' }).click()

  // Search keys.
  await page.getByLabel('Search keys').fill('mode')
  await expect(keys.getByRole('row')).toHaveCount(2)
  await page.getByLabel('Search keys').fill('')

  // Watch live changes made by someone else.
  await page.getByRole('button', { name: 'Watch changes' }).click()
  await expect(page.getByText('Waiting for changes to this bucket...')).toBeVisible()
  const { Kvm } = await import('@nats-io/kv')
  const kv = await new Kvm(nc).open(bucket)
  await kv.put('from.outside', 'hi')
  const changes = page.locator('section').filter({ hasText: 'Live changes' })
  await expect(changes.getByRole('button', { name: 'from.outside' })).toBeVisible()
  await expect(keys.getByRole('row').filter({ hasText: 'from.outside' })).toBeVisible()

  // Delete keeps history; purge removes it.
  await keys.getByRole('row').filter({ hasText: 'app.mode' }).click()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await page
    .getByRole('dialog', { name: 'Delete key app.mode' })
    .getByRole('button', { name: 'Delete key' })
    .click()
  await expect(toast(page, 'Deleted key app.mode')).toBeVisible()
  await expect(keys.getByRole('row').filter({ hasText: 'app.mode' })).toHaveCount(0)
  expect(await kv.get('app.mode').then((e) => e?.operation)).toBe('DEL')

  await keys.getByRole('row').filter({ hasText: 'app.limit' }).click()
  await page.getByRole('button', { name: 'Purge', exact: true }).click()
  await page
    .getByRole('dialog', { name: 'Purge key app.limit' })
    .getByRole('button', { name: 'Purge key' })
    .click()
  await expect(toast(page, 'Purged key app.limit')).toBeVisible()

  // Delete the bucket with its name typed.
  await go(page, 'KV buckets')
  await buckets.getByRole('button', { name: `Delete bucket ${bucket}` }).click()
  const del = page.getByRole('dialog', { name: `Delete KV bucket ${bucket}` })
  await del.getByLabel(/to confirm/).fill(bucket)
  await del.getByRole('button', { name: 'Delete bucket' }).click()
  await expect(buckets.getByRole('button', { name: bucket, exact: true })).toHaveCount(0)
  await nc.close()
})

test('PBI-071 Object Store: list, preview, upload, download, delete', async ({
  page
}, testInfo) => {
  const bucket = unique('obj').toLowerCase()
  await openStudio(page)
  await go(page, 'Object stores')
  const buckets = page.getByRole('table', { name: 'Object store buckets' })
  const artifacts = buckets.getByRole('row').filter({ hasText: 'artifacts' })
  await expect(artifacts).toContainText('Build artifacts and reports')
  await expect(artifacts.getByRole('cell').nth(2)).toHaveText('3')

  // Existing objects: metadata and preview.
  await buckets.getByRole('button', { name: 'artifacts', exact: true }).click()
  const objects = page.getByRole('table', { name: 'Objects' })
  await expect(objects.getByRole('row')).toHaveCount(4)
  await objects.getByRole('row').filter({ hasText: 'reports/summary.json' }).click()
  const detail = page.getByRole('complementary', { name: 'Object detail' })
  await expect(detail).toContainText('JSON report')
  await expect(detail).toContainText('SHA-256=')
  await expect(detail.getByTestId('payload-body')).toContainText('"orders"')
  await objects.getByRole('row').filter({ hasText: 'data/blob.bin' }).click()
  await expect(detail).toContainText('293 KiB')
  await expect(detail.getByRole('tab', { name: 'Hex' })).toHaveAttribute('aria-selected', 'true')

  // Download gives back exactly the stored bytes.
  const download = page.waitForEvent('download')
  await detail.getByRole('button', { name: 'Download' }).click()
  const file = await download
  expect(file.suggestedFilename()).toBe('blob.bin')
  expect(readFileSync(await file.path()).length).toBe(300_000)
  await expect(toast(page, /Downloaded data\/blob\.bin/)).toBeVisible()

  // A new bucket: upload a file in chunks, then download it and compare.
  await go(page, 'Object stores')
  await page.getByRole('button', { name: 'New bucket' }).click()
  const create = page.getByRole('dialog', { name: 'New object store bucket' })
  await create.getByLabel('Name').fill(bucket)
  await create.getByRole('button', { name: 'Create bucket' }).click()
  await expect(page.getByText('This bucket is empty')).toBeVisible()

  const data = randomBytes(900_000)
  const path = join(testInfo.outputDir, 'upload.bin')
  testInfo.outputPath('.')
  writeFileSync(testInfo.outputPath('upload.bin'), data)
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Upload file' }).click()
  await (await chooser).setFiles(path)
  await expect(toast(page, 'Uploaded upload.bin')).toBeVisible({ timeout: 30_000 })
  await expect(objects.getByRole('row').filter({ hasText: 'upload.bin' })).toContainText('879 KiB')

  const back = page.waitForEvent('download')
  await page
    .getByRole('complementary', { name: 'Object detail' })
    .getByRole('button', { name: 'Download' })
    .click()
  const got = readFileSync(await (await back).path())
  expect(createHash('sha256').update(got).digest('hex')).toBe(
    createHash('sha256').update(data).digest('hex')
  )

  // Delete the object, then the bucket.
  await page
    .getByRole('complementary', { name: 'Object detail' })
    .getByRole('button', { name: 'Delete object' })
    .click()
  await page
    .getByRole('dialog', { name: 'Delete object upload.bin' })
    .getByRole('button', { name: 'Delete object' })
    .click()
  await expect(page.getByText('This bucket is empty')).toBeVisible()
  await go(page, 'Object stores')
  await buckets.getByRole('button', { name: `Delete bucket ${bucket}` }).click()
  const del = page.getByRole('dialog', { name: `Delete object store ${bucket}` })
  await del.getByLabel(/to confirm/).fill(bucket)
  await del.getByRole('button', { name: 'Delete bucket' }).click()
  await expect(buckets.getByRole('button', { name: bucket, exact: true })).toHaveCount(0)
})

test('PBI-071 an image object is previewed as an image', async ({ page }) => {
  const bucket = unique('img').toLowerCase()
  const { nc } = await nats()
  const { Objm } = await import('@nats-io/obj')
  const store = await new Objm(nc).create(bucket)
  // The smallest valid PNG: one transparent pixel.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
  )
  await store.putBlob({ name: 'pixel.png' }, new Uint8Array(png))

  await openStudio(page)
  await go(page, 'Object stores')
  await page
    .getByRole('table', { name: 'Object store buckets' })
    .getByRole('button', { name: bucket, exact: true })
    .click()
  await page
    .getByRole('table', { name: 'Objects' })
    .getByRole('row')
    .filter({ hasText: 'pixel.png' })
    .click()
  const image = page.getByRole('img', { name: 'Preview of pixel.png' })
  await expect(image).toBeVisible()
  expect(await image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1)
  await store.destroy()
  await nc.close()
})

test('PBI-060 the window stays responsive at 5,000 messages per second', async ({ page }) => {
  const prefix = unique('load').toLowerCase()
  const { nc } = await nats()
  await openStudio(page)
  await go(page, 'Live tail')
  await page.getByLabel('Subject', { exact: true }).fill(`${prefix}.>`)
  await page.getByRole('button', { name: 'Start' }).click()
  await expect(page.getByText(`Waiting for messages on ${prefix}.>`)).toBeVisible()

  // Record the longest gap between animation frames while messages pour in.
  await page.evaluate(() => {
    const w = window as unknown as { __gap: number; __stop: boolean }
    w.__gap = 0
    w.__stop = false
    let last = performance.now()
    const tick = (now: number): void => {
      w.__gap = Math.max(w.__gap, now - last)
      last = now
      if (!w.__stop) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  const TOTAL = 20_000
  for (let sent = 0; sent < TOTAL;) {
    for (let i = 0; i < 500; i++, sent++)
      nc.publish(`${prefix}.n`, `{"n":${sent},"note":"load test message"}`)
    await nc.flush()
    await new Promise((r) => setTimeout(r, 100))
  }
  await expect(page.getByTestId('tail-received')).toHaveText('20,000', { timeout: 20_000 })
  const worstFrame = await page.evaluate(() => {
    const w = window as unknown as { __gap: number; __stop: boolean }
    w.__stop = true
    return w.__gap
  })
  // Nothing dropped below the buffer limit, and no frame took longer than a quarter of a second.
  await expect(page.getByTestId('tail-dropped')).toHaveText('10,000')
  expect(worstFrame).toBeLessThan(250)

  // The UI still reacts while the stream is busy: pause works straight away.
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  await expect(page.getByText(/Paused\. The list is frozen/)).toBeVisible()
  await page.getByRole('button', { name: 'Stop' }).click()
  await nc.close()
})
