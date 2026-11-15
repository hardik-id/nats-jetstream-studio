import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, type NatsConnection } from '@nats-io/transport-node'
import {
  jetstream,
  jetstreamManager,
  type JetStreamClient,
  type JetStreamManager
} from '@nats-io/jetstream'
import { inject } from 'vitest'
import { KeyFileSecretStore } from '@core/secrets'
import { StudioService, type StudioServiceOptions } from '@core/service'
import {
  GATEWAY_METHODS,
  type ConnectionInput,
  type GatewayStreams,
  type StreamChannel
} from '@shared/api'

export interface Harness {
  service: StudioService
  dataDir: string
  natsUrl: string
  /** Saves and opens a connection to the shared test server. Returns its id. */
  connect(overrides?: Partial<ConnectionInput>): Promise<string>
  /** A plain client for arranging and checking server state behind the studio's back. */
  client(
    user?: string,
    pass?: string
  ): Promise<{ nc: NatsConnection; jsm: JetStreamManager; js: JetStreamClient }>
  /** A plain core-NATS client, for accounts without JetStream such as the system account. */
  coreClient(user: string, pass: string): Promise<NatsConnection>
  dispose(): Promise<void>
}

export async function createHarness(opts: Partial<StudioServiceOptions> = {}): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), 'studio-data-'))
  const natsUrl = inject('natsUrl')
  const real = new StudioService({
    dataDir,
    secretStore: new KeyFileSecretStore(join(dataDir, 'secret.key')),
    cliContextDir: join(dataDir, 'no-cli-contexts'),
    mode: 'desktop',
    appVersion: '0.0.0-test',
    natsClientVersion: 'test',
    ...opts
  })
  // Route gateway methods through invoke(), exactly as the IPC and WebSocket transports do, so
  // tests see the same allow-list and error conversion as the UI.
  const methods = new Set<string>(GATEWAY_METHODS)
  const service = new Proxy(real, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && methods.has(prop))
        return (...args: unknown[]) => target.invoke(prop, args)
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
  const clients: NatsConnection[] = []
  return {
    service,
    dataDir,
    natsUrl,
    async connect(overrides = {}) {
      const saved = await service.saveConnection({
        name: `test-${Math.random().toString(36).slice(2, 8)}`,
        servers: [natsUrl],
        auth: 'userpass',
        user: 'app',
        password: 'app',
        ...overrides
      })
      await service.connect(saved.id)
      return saved.id
    },
    async client(user = 'app', pass = 'app') {
      const nc = await connect({ servers: natsUrl, user, pass })
      clients.push(nc)
      return { nc, jsm: await jetstreamManager(nc), js: jetstream(nc) }
    },
    async coreClient(user, pass) {
      const nc = await connect({ servers: natsUrl, user, pass })
      clients.push(nc)
      return nc
    },
    async dispose() {
      await service.dispose()
      await Promise.all(clients.map((c) => c.close()))
      rmSync(dataDir, { recursive: true, force: true })
    }
  }
}

/** A stream name that no other test uses. */
export function uniqueName(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10).toUpperCase()}`
}

/** Collects events from a gateway stream until `until` returns true or the timeout passes. */
export function collect<K extends StreamChannel>(
  service: StudioService,
  channel: K,
  args: GatewayStreams[K]['args'],
  until: (events: GatewayStreams[K]['event'][]) => boolean,
  timeoutMs = 10_000
): Promise<{ events: GatewayStreams[K]['event'][]; close: () => void }> {
  return new Promise((resolve, reject) => {
    const events: GatewayStreams[K]['event'][] = []
    let close: () => void = () => {}
    const timer = setTimeout(() => {
      close()
      reject(
        new Error(
          `Timed out waiting on "${channel}" stream. Got: ${JSON.stringify(events).slice(0, 500)}`
        )
      )
    }, timeoutMs)
    close = service.open(channel, args, (event) => {
      events.push(event)
      if (until(events)) {
        clearTimeout(timer)
        resolve({ events, close })
      }
    })
  })
}

export async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
  what = 'condition'
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`Timed out waiting for ${what}`)
}
