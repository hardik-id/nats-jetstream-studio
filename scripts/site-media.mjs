// Takes the pictures the website and the README use, from the real UI (web mode) with demo data.
//
//   npm run build:web && npm run site:media
//
// Starts its own nats-server (free port, temp dir), seeds demo data and traffic, starts web mode on
// a free port, drives it with Playwright and writes into site/public/media/ (WebP screenshots in
// dark and light, a manifest.json, a home recording and a Trace recording) plus docs/images/demo.gif,
// docs/images/trace.gif and docs/images/social-preview.png. Only the processes started here are stopped, also on Ctrl+C.
//
// ffmpeg (FFMPEG env var, else PATH) is needed for the recordings (MP4, still, GIF) only; without it
// the screenshots and the social card are still made and the recording step is skipped with a note.
// dist/ is not built here: if it is missing the script stops and says to run "npm run build:web".
import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from '@playwright/test'
import { ensureNatsServer } from './nats-binary.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const mediaDir = join(root, 'site', 'public', 'media')
const imagesDir = join(root, 'docs', 'images')
const SIZE = { width: 1440, height: 860 } // screenshots
const VIDEO = { width: 1100, height: 660 } // recording
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (
  !existsSync(join(root, 'dist', 'server', 'index.cjs')) ||
  !existsSync(join(root, 'dist', 'web'))
)
  throw new Error('dist/ is missing. Run "npm run build:web" first.')

// ---- processes: only the ones started here are tracked and stopped -------------------------
const children = new Set()
function start(cmd, args, env = {}) {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  p.log = ''
  p.stdout.on('data', (d) => (p.log += d))
  p.stderr.on('data', (d) => (p.log += d))
  children.add(p)
  p.on('exit', () => children.delete(p))
  return p
}
async function stopChildren() {
  for (const p of children) p.kill('SIGTERM')
  for (let i = 0; i < 30 && children.size; i++) await sleep(100)
  for (const p of children) p.kill('SIGKILL')
}
for (const sig of ['SIGINT', 'SIGTERM'])
  process.on(sig, () => {
    stopChildren().finally(() => process.exit(130))
  })

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

function findFfmpeg() {
  for (const c of [process.env.FFMPEG, 'ffmpeg'].filter(Boolean))
    if (spawnSync(c, ['-version'], { stdio: 'ignore' }).status === 0) return c
  return null
}
function ffmpeg(bin, cwd, args) {
  // Relative file names with cwd set work for native and Windows (WSL) binaries alike.
  const r = spawnSync(bin, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    cwd,
    encoding: 'utf8'
  })
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`)
}

const manifest = []
const demo = {} // facts about the seeded data the scenes need, set in main()
const kb = (f) => `${Math.round(statSync(f).size / 1024)} KB`

// ---- the scenes ---------------------------------------------------------------------------
const NAME = 'Local dev'
const group = (page, name = NAME) =>
  page.getByRole('navigation', { name: 'Connections' }).getByRole('group', { name, exact: true })
const nav = (page, section, name = NAME) =>
  group(page, name).getByRole('button', { name: section, exact: true }).click()

async function dismissToasts(page) {
  await page
    .addStyleTag({ content: '[role="status"] { display: none !important }' })
    .catch(() => {})
}
async function openStudio(page, url) {
  await page.goto(url)
  const g = group(page)
  const streams = g.getByRole('button', { name: 'Streams', exact: true })
  await g.waitFor()
  if (!(await streams.isVisible()))
    await g
      .getByRole('button', { name: new RegExp(NAME) })
      .first()
      .click()
  await streams.waitFor()
  await dismissToasts(page)
}
/** Messages is a screen of its own: choose the stream in its picker (see openMessages in the e2e helpers). */
async function openMessages(page, stream) {
  await nav(page, 'Messages')
  const picker = page.getByRole('combobox', { name: 'Stream', exact: true })
  await picker.click()
  await picker.fill(stream)
  await page
    .getByRole('listbox', { name: 'Streams' })
    .getByRole('option')
    .filter({ has: page.getByText(stream, { exact: true }) })
    .click()
  await page.getByRole('table', { name: `Messages in ${stream}` }).waitFor()
}
/** The rows of the open stream's messages; `subject` keeps only rows of that subject. */
const messageRows = (page, stream, subject) => {
  const rows = page.getByRole('table', { name: `Messages in ${stream}` }).getByRole('row')
  return subject ? rows.filter({ hasText: subject }) : rows
}
/** From an open message: "Follow this value" on its Trace-Id header opens the Trace screen. */
async function followTraceId(page) {
  const detail = page.getByRole('complementary', { name: 'Message detail' })
  const toggle = detail.getByRole('button', { name: /^Headers \(/ })
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await detail.getByRole('button', { name: /^Follow trace-id .* across streams$/i }).click()
  await page.getByRole('table', { name: 'Trace timeline' }).waitFor()
}
// The collapsed state is kept by the server, so each use is paired with expandSidebar.
const collapseSidebar = (page) => page.getByRole('button', { name: 'Collapse sidebar' }).click()
const expandSidebar = (page) => page.getByRole('button', { name: 'Expand sidebar' }).click()
const pickView = (page, view) => page.getByRole('combobox', { name: 'View' }).selectOption(view)
/** The Trace screen, filled in by hand with the Trace-Id header of a demo request, and run. */
async function runTrace(page, traceId) {
  await nav(page, 'Trace')
  await page.getByRole('textbox', { name: 'Header name 1' }).fill('Trace-Id')
  await page.getByRole('textbox', { name: 'Value 1' }).fill(traceId)
  await page.getByRole('button', { name: 'Run trace' }).click()
  await page.getByRole('table', { name: 'Trace timeline' }).waitFor()
}
async function openStream(page, stream, tab) {
  await nav(page, 'Streams')
  await page
    .getByRole('table', { name: 'Streams' })
    .getByRole('button', { name: stream, exact: true })
    .click()
  const t = page
    .getByRole('tabpanel', { name: stream })
    .getByRole('tab', { name: tab, exact: true })
  await t.waitFor()
  await t.click()
}

/** Each scene leaves the UI in the state to photograph. */
const scenes = [
  {
    name: 'connections',
    group: 'features',
    alt: 'Sidebar with three connections, each with its own environment label and colour, and the overview of the selected server',
    async run(page) {
      await nav(page, 'Overview')
      await sleep(3500)
    }
  },
  {
    name: 'message-browser',
    group: 'features',
    alt: 'Messages of the ORDERS stream filtered by a condition chip made from a JSON value, with the detail panel showing a JSON payload',
    async run(page) {
      await openMessages(page, 'ORDERS')
      await sleep(1500)
      await messageRows(page, 'ORDERS').nth(2).getByRole('cell').nth(2).click()
      await sleep(1500)
      // One condition made from a JSON value of the open message, shown as a chip.
      const add = page.getByRole('button', { name: /^Filter to .* equals / }).first()
      if (await add.count()) {
        await add.click()
        await sleep(1500)
      }
    }
  },
  {
    name: 'trace',
    group: 'features',
    alt: 'Graph view of one shop request: subjects and consumers as nodes across three streams, arrows between them with the time each step took, and dots travelling along the arrows',
    async run(page) {
      await runTrace(page, demo.traceId)
      await pickView(page, 'graph')
      await page.getByRole('application', { name: 'Trace graph' }).waitFor()
      await sleep(4000)
    }
  },
  {
    name: 'subjects',
    group: 'features',
    alt: 'Subjects screen: a tree of subjects with stored and live message counts, and a details pane with labelled actions',
    async run(page) {
      await nav(page, 'Subjects')
      const tree = page.getByRole('treegrid', { name: 'Subjects' })
      await tree.getByRole('row').nth(1).waitFor()
      await sleep(2500)
      await page.getByRole('button', { name: 'Expand all' }).click()
      await sleep(800)
      await tree.getByRole('row').nth(3).click()
      await sleep(1500)
    }
  },
  {
    name: 'streams',
    group: 'features',
    alt: 'List of JetStream streams with message counts, sizes, storage type and retention',
    async run(page) {
      await nav(page, 'Streams')
      await page
        .getByRole('table', { name: 'Streams' })
        .getByRole('button', { name: 'ORDERS', exact: true })
        .waitFor()
      await sleep(2000)
    }
  },
  {
    name: 'consumers',
    group: 'features',
    alt: 'Consumers of the ORDERS stream with lag, ack pending, redeliveries and health flags',
    async run(page) {
      await openStream(page, 'ORDERS', 'Consumers')
      await page.getByRole('button', { name: 'Collapse sidebar' }).click()
      await sleep(3500)
    },
    // The collapsed state is kept by the server, so the next scene would start with the rail.
    async after(page) {
      await page.getByRole('button', { name: 'Expand sidebar' }).click()
      await sleep(300)
    }
  },
  {
    name: 'live-tail-and-publish',
    group: 'features',
    alt: 'Live tail of orders.> showing messages as they arrive, with received and rate counters',
    async run(page) {
      await nav(page, 'Live tail')
      await page.getByLabel('Subject', { exact: true }).fill('orders.>')
      await page.getByRole('button', { name: 'Start' }).click()
      await sleep(4000)
    }
  },
  {
    name: 'kv-and-object-store',
    group: 'features',
    alt: 'Keys of the app-config key-value bucket with their values and revisions',
    async run(page) {
      await nav(page, 'KV buckets')
      await page.getByRole('button', { name: 'app-config', exact: true }).click()
      await page.getByText('cache.ttl', { exact: true }).first().click()
      await sleep(1500)
    }
  },
  {
    name: 'monitoring-and-alerts',
    group: 'features',
    alt: 'Stream overview with live charts of messages per second, messages stored and bytes stored',
    async run(page) {
      await openStream(page, 'ORDERS', 'Overview')
      await sleep(25000)
    }
  },
  {
    name: 'productivity',
    group: 'features',
    alt: 'Command palette searching streams, consumers and buckets for "orders"',
    async run(page) {
      await nav(page, 'Streams')
      await sleep(1000)
      await page.keyboard.press('Control+k')
      await page.getByRole('dialog', { name: 'Search' }).getByRole('combobox').fill('orders')
      await sleep(600)
    }
  },
  {
    name: 'connection-form',
    group: 'docs',
    alt: 'The add connection form with server address, authentication type and environment label',
    async run(page) {
      await page.getByRole('button', { name: 'Add connection' }).first().click()
      const dialog = page.getByRole('dialog', { name: 'Add connection' })
      await dialog.getByLabel('Name', { exact: true }).fill('Staging cluster')
      await dialog.getByLabel('Environment').fill('staging')
      await sleep(600)
    }
  },
  {
    name: 'first-stream',
    group: 'docs',
    alt: 'The ORDERS stream open with its configuration and state',
    async run(page) {
      await openStream(page, 'ORDERS', 'Overview')
      await sleep(1000)
    }
  }
]

// ---- WebP: Chromium's own encoder, so no extra dependency and no ffmpeg ----------------------
async function toWebp(helper, png, quality = 0.86) {
  const b64 = await helper.evaluate(
    async ([data, q]) => {
      const blob = await (await fetch(`data:image/png;base64,${data}`)).blob()
      const bmp = await createImageBitmap(blob)
      const canvas = new OffscreenCanvas(bmp.width, bmp.height)
      canvas.getContext('2d').drawImage(bmp, 0, 0)
      const out = await canvas.convertToBlob({ type: 'image/webp', quality: q })
      const buf = new Uint8Array(await out.arrayBuffer())
      let s = ''
      for (let i = 0; i < buf.length; i += 0x8000)
        s += String.fromCharCode(...buf.subarray(i, i + 0x8000))
      return btoa(s)
    },
    [png.toString('base64'), quality]
  )
  return Buffer.from(b64, 'base64')
}

async function main() {
  const work = mkdtempSync(join(tmpdir(), 'studio-media-'))
  const natsPort = await freePort()
  const webPort = await freePort()
  let stopTraffic, handles, browser
  try {
    const bin = await ensureNatsServer()
    const conf = join(work, 'nats.conf')
    writeFileSync(
      conf,
      `server_name: demo
port: ${natsPort}
host: 127.0.0.1
jetstream { store_dir: "${join(work, 'js').replace(/\\/g, '/')}" }
accounts {
  SYS { users: [ { user: sys, password: sys } ] }
  APP { jetstream: enabled, users: [ { user: app, password: app } ] }
}
system_account: SYS
`
    )
    const nats = start(bin, ['-c', conf])
    const natsUrl = `nats://127.0.0.1:${natsPort}`
    for (let i = 0; i < 100 && !/Server is ready/.test(nats.log); i++) await sleep(100)
    if (!/Server is ready/.test(nats.log))
      throw new Error(`nats-server did not start:\n${nats.log}`)

    const { seed, startTraffic } = await import(
      pathToFileURL(join(root, 'scripts', 'seed.mjs')).href
    )
    handles = await seed({ url: natsUrl, quiet: true, history: 400, shop: true })
    stopTraffic = startTraffic(handles, { rate: 5, shop: true, shopRate: 2 })
    // The Trace-Id of one finished shop request (from the history), for the Trace pictures.
    const sample = await handles.jsm.streams.getMessage('SHOP_PAYMENTS', { seq: 12 })
    demo.traceId = sample.header.get('Trace-Id')

    const conn = (name, envLabel, color) => ({
      name,
      servers: [natsUrl],
      auth: 'userpass',
      user: 'app',
      password: 'app',
      envLabel,
      color
    })
    const provision = join(work, 'provision.json')
    writeFileSync(
      provision,
      JSON.stringify({
        connections: [
          conn(NAME, 'dev', '#059669'),
          conn('Staging', 'staging', '#d97706'),
          conn('Production', 'prod', '#dc2626')
        ]
      })
    )
    const server = start(process.execPath, [join(root, 'dist', 'server', 'index.cjs')], {
      PORT: String(webPort),
      HOST: '127.0.0.1',
      STUDIO_AUTH: 'none',
      STUDIO_DATA_DIR: join(work, 'web-data'),
      STUDIO_PROVISION_FILE: provision,
      STUDIO_CONTEXT_DIR: join(work, 'no-ctx'),
      STUDIO_SAMPLE_INTERVAL_MS: '1000'
    })
    for (let i = 0; i < 100 && !/listening on/.test(server.log); i++) await sleep(100)
    if (!/listening on/.test(server.log)) throw new Error(`web mode did not start:\n${server.log}`)
    const studioUrl = `http://127.0.0.1:${webPort}`

    browser = await chromium.launch()
    const helper = await browser.newPage()
    mkdirSync(mediaDir, { recursive: true })
    mkdirSync(imagesDir, { recursive: true })
    const shots = {}

    // One fresh page per scene so no state leaks between them.
    for (const scheme of ['dark', 'light']) {
      for (const scene of scenes) {
        const ctx = await browser.newContext({ viewport: SIZE, colorScheme: scheme })
        const page = await ctx.newPage()
        await openStudio(page, studioUrl)
        await scene.run(page)
        await dismissToasts(page)
        await page.mouse.move(SIZE.width - 1, SIZE.height - 1)
        const png = await page.screenshot()
        await scene.after?.(page)
        const file = `${scene.group}-${scene.name}-${scheme}.webp`
        await writeFile(join(mediaDir, file), await toWebp(helper, png))
        shots[`${scene.name}-${scheme}`] = png
        manifest.push({
          file,
          kind: 'screenshot',
          group: scene.group,
          name: scene.name,
          theme: scheme,
          width: SIZE.width,
          height: SIZE.height,
          alt: scene.alt
        })
        console.log(`  ${file} ${kb(join(mediaDir, file))}`)
        await ctx.close()
      }
    }

    // Social preview card.
    const card = await browser.newPage({ viewport: { width: 1280, height: 640 } })
    await card.setContent(socialHtml(shots['consumers-dark'].toString('base64')))
    await card.waitForTimeout(400)
    await card.screenshot({ path: join(imagesDir, 'social-preview.png') })
    await card.close()
    console.log(`  docs/images/social-preview.png ${kb(join(imagesDir, 'social-preview.png'))}`)

    const ff = findFfmpeg()
    if (!ff)
      console.warn(
        'ffmpeg not found: skipping the recordings (MP4, still, GIF). Install ffmpeg or set FFMPEG=/path/to/ffmpeg.'
      )
    else for (const rec of recordings) await record(rec, browser, studioUrl, work, ff, helper)

    await helper.close()
    manifest.sort((a, b) => a.file.localeCompare(b.file))
    await writeFile(
      join(mediaDir, 'manifest.json'),
      JSON.stringify({ files: manifest }, null, 2) + '\n'
    )
    console.log(`Wrote ${manifest.length} files and manifest.json to ${mediaDir}`)
  } finally {
    if (browser) await browser.close().catch(() => {})
    if (stopTraffic) await stopTraffic().catch(() => {})
    if (handles) await handles.nc.close().catch(() => {})
    await stopChildren()
    if (process.env.SITE_MEDIA_KEEP_TEMP !== '1') rmSync(work, { recursive: true, force: true })
  }
}

/**
 * The recordings. `steps` drives the page and calls `still()` when the picture for the poster is on
 * screen. The GIF settings trade size for smoothness: more fps makes the travelling dots smoother.
 */
const recordings = [
  {
    name: 'home',
    gif: { file: 'demo.gif', fps: 15, width: 1100, colors: 128 },
    alt: 'Tour of the studio: overview, streams, a message of a shop request with its Trace-Id header, then Trace following that request across three streams in the timeline, lanes and graph views',
    async steps(page, still) {
      await nav(page, 'Overview')
      await sleep(2200)
      await nav(page, 'Streams')
      await sleep(2200)
      await openMessages(page, 'SHOP_ORDERS')
      await sleep(1500)
      // A request that has finished (the newest ones are still on their way), with its detail open.
      await messageRows(page, 'SHOP_ORDERS', 'shop.orders.created').nth(10).click()
      const detail = page.getByRole('complementary', { name: 'Message detail' })
      await detail.getByRole('button', { name: /^Headers \(/ }).waitFor()
      await sleep(2200)
      await followTraceId(page)
      await sleep(2800)
      // Narrower sidebar for the wide views, so the graph is drawn larger.
      await collapseSidebar(page)
      await pickView(page, 'lanes')
      await sleep(2800)
      await pickView(page, 'graph')
      await page.getByRole('application', { name: 'Trace graph' }).waitFor()
      await sleep(1000)
      still()
      await sleep(4500)
      await expandSidebar(page)
    }
  },
  {
    name: 'trace',
    gif: { file: 'trace.gif', fps: 15, width: 1100, colors: 128 },
    alt: 'Following one shop request across three streams: run a trace on its Trace-Id header, then the timeline, lanes and graph views with dots travelling between subjects and consumers',
    async steps(page, still) {
      await nav(page, 'Trace')
      await sleep(1200)
      await collapseSidebar(page)
      await page.getByRole('textbox', { name: 'Header name 1' }).fill('Trace-Id')
      await page.getByRole('textbox', { name: 'Value 1' }).fill(demo.traceId)
      await sleep(1000)
      await page.getByRole('button', { name: 'Run trace' }).click()
      await page.getByRole('table', { name: 'Trace timeline' }).waitFor()
      await sleep(2300)
      await pickView(page, 'lanes')
      await sleep(2300)
      await pickView(page, 'graph')
      const graph = page.getByRole('application', { name: 'Trace graph' })
      await graph.waitFor()
      await sleep(1200)
      still()
      await sleep(5500)
      await expandSidebar(page)
    }
  }
]

async function record(rec, browser, studioUrl, work, ff, helper) {
  const videoDir = join(work, `video-${rec.name}`)
  const ctx = await browser.newContext({
    viewport: VIDEO,
    colorScheme: 'dark',
    recordVideo: { dir: videoDir, size: VIDEO }
  })
  const page = await ctx.newPage()
  const t0 = Date.now() // the video starts with the page
  let stillAt = 0
  await openStudio(page, studioUrl)
  await rec.steps(page, () => (stillAt = (Date.now() - t0) / 1000))
  await page.close()
  await ctx.close()
  const webm = readdirSync(videoDir).find((f) => f.endsWith('.webm'))
  if (!webm) throw new Error('Playwright wrote no video')
  const input = `${rec.name}.webm`
  await copyFile(join(videoDir, webm), join(work, input))

  // The same three encodes for each recording: MP4 for the site, a poster frame, a GIF for the README.
  const { fps, width, colors, file } = rec.gif
  ffmpeg(ff, work, [
    '-i',
    input,
    '-an',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-crf',
    '30',
    '-preset',
    'slow',
    '-movflags',
    '+faststart',
    `${rec.name}.mp4`
  ])
  ffmpeg(ff, work, [
    '-i',
    `${rec.name}.mp4`, // the MP4 is smoother than the raw recording, which makes a much smaller GIF
    '-vf',
    `fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5`,
    file
  ])
  ffmpeg(ff, work, ['-ss', String(stillAt), '-i', input, '-frames:v', '1', `${rec.name}-still.png`])
  await copyFile(join(work, `${rec.name}.mp4`), join(mediaDir, `${rec.name}.mp4`))
  await copyFile(join(work, file), join(imagesDir, file))
  await writeFile(
    join(mediaDir, `${rec.name}-still.webp`),
    await toWebp(helper, await readFile(join(work, `${rec.name}-still.png`)))
  )
  manifest.push(
    {
      file: `${rec.name}.mp4`,
      kind: 'video',
      width: VIDEO.width,
      height: VIDEO.height,
      alt: rec.alt,
      poster: `${rec.name}-still.webp`
    },
    {
      file: `${rec.name}-still.webp`,
      kind: 'still',
      width: VIDEO.width,
      height: VIDEO.height,
      alt: rec.alt
    }
  )
  for (const f of [`${rec.name}.mp4`, `${rec.name}-still.webp`])
    console.log(`  ${f} ${kb(join(mediaDir, f))}`)
  console.log(`  docs/images/${file} ${kb(join(imagesDir, file))}`)
}

function socialHtml(shotB64) {
  return `<!doctype html><html><body style="margin:0;width:1280px;height:640px;background:#0b0f19;font-family:Inter,system-ui,sans-serif;color:#e8ecf4;overflow:hidden;position:relative">
<div style="position:absolute;left:64px;top:84px;width:560px">
<div style="font-size:20px;letter-spacing:.14em;text-transform:uppercase;color:#6ee7b7;font-weight:600">NATS &middot; JetStream</div>
<div style="font-size:54px;line-height:1.05;font-weight:700;margin-top:18px">NATS JetStream Studio</div>
<div style="font-size:26px;line-height:1.35;color:#aab3c5;margin-top:24px">A desktop and web GUI to browse streams, consumers, subjects and messages.</div>
<div style="margin-top:36px;font-size:20px;color:#7c8799">Windows &middot; macOS &middot; Linux &middot; Web</div>
</div>
<img src="data:image/png;base64,${shotB64}" style="position:absolute;left:640px;top:140px;width:600px;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.6);border:1px solid #243049">
</body></html>`
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e)
    process.exit(1)
  }
)
