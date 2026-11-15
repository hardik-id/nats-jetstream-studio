import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface TestServer {
  port: number
  url: string
  storeDir: string
  stop(): Promise<void>
  /** Stops the process but keeps its data, so `restart` brings the same streams back. */
  kill(): Promise<void>
  restart(): Promise<void>
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number }
      srv.close(() => resolve(port))
    })
  })
}

export function natsServerBinary(): string {
  const candidates = [
    process.env.NATS_SERVER_BIN,
    join(process.cwd(), '.tools', 'nats-server'),
    join(process.cwd(), '.tools', 'nats-server.exe')
  ]
  const found = candidates.find((c) => c && existsSync(c))
  if (!found)
    throw new Error('nats-server binary not found. Run "node scripts/nats-binary.mjs" first.')
  return found
}

/** The accounts every core test can rely on. */
export const DEFAULT_CONFIG = `
accounts {
  SYS { users: [ { user: sys, password: sys } ] }
  APP {
    jetstream: enabled
    users: [
      { user: app, password: app }
      {
        user: limited, password: limited
        permissions: {
          publish: { allow: ["orders.>", "_INBOX.>"] }
          subscribe: { allow: ["orders.>", "_INBOX.>"] }
        }
      }
    ]
  }
  NOJS { users: [ { user: nojs, password: nojs } ] }
}
system_account: SYS
`

/** Starts a real nats-server on a free port. `config` is appended to the generated config file. */
export async function startNatsServer(
  config = DEFAULT_CONFIG,
  opts: { jetstream?: boolean; port?: number; jetstreamExtra?: string } = {}
): Promise<TestServer> {
  const port = opts.port ?? (await freePort())
  const dir = mkdtempSync(join(tmpdir(), 'studio-nats-'))
  const conf = join(dir, 'server.conf')
  const jetstream =
    opts.jetstream === false
      ? ''
      : `jetstream { store_dir: "${join(dir, 'js').replace(/\\/g, '/')}", max_mem: 256M, max_file: 1G ${opts.jetstreamExtra ?? ''} }`
  writeFileSync(
    conf,
    `listen: "127.0.0.1:${port}"\nserver_name: "studio-test-${port}"\n${jetstream}\n${config}\n`
  )

  let child: ChildProcess | undefined
  const start = async (): Promise<void> => {
    child = spawn(natsServerBinary(), ['-c', conf], { stdio: ['ignore', 'ignore', 'pipe'] })
    let log = ''
    child.stderr?.on('data', (d) => (log += String(d)))
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`nats-server did not start:\n${log}`)),
        10_000
      )
      const check = (): void => {
        if (/Server is ready/.test(log)) {
          clearTimeout(timer)
          resolve()
        } else if (child!.exitCode !== null) {
          clearTimeout(timer)
          reject(new Error(`nats-server exited:\n${log}`))
        } else {
          setTimeout(check, 20)
        }
      }
      check()
    })
  }
  const kill = async (): Promise<void> => {
    const proc = child
    child = undefined
    if (!proc || proc.exitCode !== null) return
    await new Promise<void>((resolve) => {
      proc.once('exit', () => resolve())
      proc.kill('SIGKILL')
    })
  }
  await start()

  return {
    port,
    url: `nats://127.0.0.1:${port}`,
    storeDir: dir,
    kill,
    restart: async () => {
      await kill()
      await start()
    },
    stop: async () => {
      await kill()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}
