import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { freePort, startNatsServer } from '../helpers/natsServer'

const CONFIG = `
accounts {
  SYS { users: [ { user: sys, password: sys } ] }
  APP {
    jetstream: enabled
    users: [
      { user: app, password: app }
      { user: viewer, password: viewer, permissions: { publish: { allow: ["$JS.API.>", "_INBOX.>", "$SYS.REQ.USER.INFO"] }, subscribe: { allow: [">"] } } }
    ]
  }
}
system_account: SYS
`

/** Starts nats-server, fills it with demo data and starts the web-mode studio against it. */
export default async function globalSetup(): Promise<() => Promise<void>> {
  for (const file of ['dist/server/index.cjs', 'dist/web/index.html', 'out/main/index.js']) {
    if (!existsSync(file))
      throw new Error(
        `${file} is missing. Run "npm run build && npm run build:web" first (npm run test:e2e does this).`
      )
  }
  const nats = await startNatsServer(CONFIG)
  const work = mkdtempSync(join(tmpdir(), 'studio-e2e-'))

  // Demo data: streams, consumers, KV and object buckets, plus live traffic and responders.
  const { seed, startTraffic } = (await import('../../scripts/seed.mjs')) as {
    seed: (opts: object) => Promise<{ nc: { close(): Promise<void> } }>
    startTraffic: (handles: object, opts: object) => () => Promise<void>
  }
  const handles = await seed({ url: nats.url, quiet: true, history: 400 })
  const stopTraffic = startTraffic(handles, { rate: 5 })

  // Web mode with connections provided by an administrator file, as a deployment would do.
  const provision = join(work, 'provision.json')
  writeFileSync(
    provision,
    JSON.stringify({
      connections: [
        {
          name: 'Local dev',
          servers: [nats.url],
          auth: 'userpass',
          user: 'app',
          password: 'app',
          envLabel: 'dev',
          color: '#059669'
        },
        {
          name: 'System',
          servers: [nats.url],
          auth: 'userpass',
          user: 'sys',
          password: 'sys',
          envLabel: 'dev',
          color: '#7c3aed'
        },
        {
          name: 'Production',
          servers: [nats.url],
          auth: 'userpass',
          user: 'app',
          password: 'app',
          envLabel: 'prod',
          color: '#dc2626'
        }
      ]
    })
  )
  const port = await freePort()
  const server: ChildProcess = spawn(process.execPath, ['dist/server/index.cjs'], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      STUDIO_AUTH: 'none',
      STUDIO_DATA_DIR: join(work, 'web-data'),
      STUDIO_PROVISION_FILE: provision,
      STUDIO_CONTEXT_DIR: join(work, 'no-contexts'),
      STUDIO_SAMPLE_INTERVAL_MS: '1000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let log = ''
  server.stdout?.on('data', (d) => (log += String(d)))
  server.stderr?.on('data', (d) => (log += String(d)))
  const deadline = Date.now() + 15_000
  while (!/listening on/.test(log)) {
    if (server.exitCode !== null || Date.now() > deadline)
      throw new Error(`The studio server did not start:\n${log}`)
    await new Promise((r) => setTimeout(r, 50))
  }

  // A NATS CLI context folder for the desktop test, the way a user's machine would have one.
  const xdg = join(work, 'xdg')
  mkdirSync(join(xdg, 'nats', 'context'), { recursive: true })
  writeFileSync(
    join(xdg, 'nats', 'context', 'e2e-local.json'),
    JSON.stringify({
      description: 'From the NATS CLI',
      url: nats.url,
      user: 'app',
      password: 'app'
    })
  )

  process.env.STUDIO_URL = `http://127.0.0.1:${port}`
  process.env.NATS_E2E_URL = nats.url
  process.env.STUDIO_E2E_XDG = xdg
  process.env.STUDIO_E2E_WORK = work

  return async () => {
    await stopTraffic()
    await handles.nc.close()
    server.kill('SIGTERM')
    await nats.stop()
    rmSync(work, { recursive: true, force: true })
  }
}
