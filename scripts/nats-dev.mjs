// Starts a local nats-server for development: JetStream on, a system account and an app account.
//   npm run nats            -> nats://127.0.0.1:4222  (app/app, sys/sys)
//   PORT=4333 npm run nats
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureNatsServer } from './nats-binary.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const port = Number(process.env.PORT ?? 4222)
const dataDir = join(root, '.tools', `data-${port}`)
mkdirSync(dataDir, { recursive: true })
const conf = join(dataDir, 'server.conf')
writeFileSync(
  conf,
  `listen: "127.0.0.1:${port}"
server_name: "studio-dev"
jetstream { store_dir: "${join(dataDir, 'js').replace(/\\/g, '/')}", max_mem: 512M, max_file: 4G }
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
)

const bin = await ensureNatsServer()
console.log(`nats-server on nats://127.0.0.1:${port}  (users: app/app, viewer/viewer, sys/sys)`)
const child = spawn(bin, ['-c', conf], { stdio: 'inherit' })
const stop = () => child.kill('SIGINT')
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
child.on('exit', (code) => process.exit(code ?? 0))
