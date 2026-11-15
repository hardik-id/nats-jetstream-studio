import { readFileSync } from 'node:fs'
import {
  connect,
  credsAuthenticator,
  nkeyAuthenticator,
  errors as natsErrors,
  type Authenticator,
  type NatsConnection,
  type NodeConnectionOptions
} from '@nats-io/transport-node'
import {
  jetstream,
  jetstreamManager,
  type JetStreamClient,
  type JetStreamManager,
  type JetStreamOptions
} from '@nats-io/jetstream'
import { Kvm } from '@nats-io/kv'
import { Objm } from '@nats-io/obj'
import type {
  ConnectionConfig,
  ConnectionState,
  ConnectSecrets,
  TestFailureKind
} from '@shared/api'
import { gatewayError, toGatewayError } from './errors'

export const CLIENT_NAME = 'NATS JetStream Studio'

export interface ConnectionHooks {
  onState(state: ConnectionState): void
  onNotice(level: 'error' | 'warning', message: string): void
}

/**
 * Decides how long the client waits between reconnect attempts.
 *
 * The client asks for a delay every time it wakes up, not once per attempt, and only dials when
 * that delay has passed since the last attempt. So the delay must depend on how long the
 * connection has been down, not on how often it was asked: half the downtime, between 250ms and
 * 8s. That gives attempts at roughly 0, 0.25, 0.5, 1, 2, 4, 8 and then every 8 seconds.
 */
export class ReconnectBackoff {
  private downSince = 0

  delay(now = Date.now()): number {
    if (this.downSince === 0) this.downSince = now
    return Math.min(Math.max((now - this.downSince) / 2, 250), 8000)
  }

  /** Call when the connection is (back) up so the next outage starts with quick retries. */
  reset(): void {
    this.downSince = 0
  }
}

/** Translates studio connection settings into client options. Throws a GatewayError when a secret is missing. */
export function buildConnectOptions(
  cfg: Pick<
    ConnectionConfig,
    'servers' | 'auth' | 'user' | 'credsFile' | 'nkeyFile' | 'tls' | 'inboxPrefix'
  >,
  secrets: ConnectSecrets,
  timeoutMs = 5000,
  backoff = new ReconnectBackoff()
): NodeConnectionOptions {
  const opts: NodeConnectionOptions = {
    servers: cfg.servers,
    name: CLIENT_NAME,
    timeout: timeoutMs,
    reconnect: true,
    maxReconnectAttempts: -1,
    pingInterval: 20_000,
    reconnectDelayHandler: () => backoff.delay()
  }
  if (cfg.inboxPrefix) opts.inboxPrefix = cfg.inboxPrefix

  switch (cfg.auth) {
    case 'userpass':
      if (secrets.password === undefined)
        throw gatewayError('secret_required', 'Password is required to connect')
      opts.user = cfg.user
      opts.pass = secrets.password
      break
    case 'token':
      if (!secrets.token) throw gatewayError('secret_required', 'Token is required to connect')
      opts.token = secrets.token
      break
    case 'nkey': {
      let seed = secrets.nkeySeed
      if (!seed && cfg.nkeyFile) seed = readTextFile(cfg.nkeyFile, 'NKey seed file')
      if (!seed) throw gatewayError('secret_required', 'NKey seed is required to connect')
      opts.authenticator = nkeyAuthenticator(new TextEncoder().encode(seed.trim()))
      break
    }
    case 'creds':
      if (!cfg.credsFile) throw gatewayError('validation', 'Credentials file is not set')
      opts.authenticator = credsFileAuthenticator(cfg.credsFile)
      break
  }

  const wantsTls = cfg.servers.some((s) => s.startsWith('tls://'))
  if (cfg.tls || wantsTls) {
    opts.tls = {
      caFile: cfg.tls?.caFile,
      certFile: cfg.tls?.certFile,
      keyFile: cfg.tls?.keyFile,
      handshakeFirst: cfg.tls?.handshakeFirst
    }
  }
  return opts
}

/**
 * The client's creds parser only accepts "\n" line ends and a newline after the last line. The
 * NATS CLI also reads files with Windows line ends or without that final newline, so both are
 * normalised here: a file that works with `nats --creds` must work in the studio too.
 */
function normalizeCreds(text: string): Uint8Array {
  return new TextEncoder().encode(text.replace(/\r\n?/g, '\n') + '\n')
}

/**
 * Logs in with the JWT and seed of a credentials file, reading the file again for every login.
 * The client asks for credentials each time it connects, and that includes every reconnect, so a
 * file that was rotated while the studio was running is picked up by the next reconnect instead
 * of the old JWT being presented for as long as the connection lives.
 *
 * The file must be readable when the connection is opened. Later, while it is missing, unreadable
 * or half-written (a rotation in progress), the last content that worked is presented instead: an
 * error thrown from here would surface inside the client's reconnect loop.
 */
function credsFileAuthenticator(path: string): Authenticator {
  let lastGood = normalizeCreds(readTextFile(path, 'Credentials file'))
  return (nonce) => {
    try {
      // One read per login, so the JWT and the seed always come from the same version of the file.
      const current = normalizeCreds(readFileSync(path, 'utf8'))
      const auth = credsAuthenticator(current)(nonce)
      lastGood = current
      return auth
    } catch {
      return credsAuthenticator(lastGood)(nonce)
    }
  }
}

function readTextFile(path: string, label: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch (err) {
    throw gatewayError('validation', `${label} cannot be read: ${(err as Error).message}`)
  }
}

/**
 * Connects once, for a check, and gives up when `deadlineMs` has passed however many servers
 * there are to dial. The client's own timeout applies to each server in turn, so by itself three
 * servers that never answer would take three times as long.
 */
export async function connectWithin(
  opts: NodeConnectionOptions,
  deadlineMs: number
): Promise<NatsConnection> {
  const attempt = connect({
    ...opts,
    timeout: deadlineMs,
    // No reconnecting once connected. The attempts are deliberately left unlimited: before the
    // first connection the client tries each server once and drops it when it fails, but with a
    // limit it also drops the server after the failed one without ever dialling it, so a test
    // could report "refused" although the next server in the list was fine.
    reconnect: false,
    maxReconnectAttempts: -1
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<'expired'>((resolve) => {
    timer = setTimeout(() => resolve('expired'), deadlineMs)
  })
  try {
    const first = await Promise.race([attempt, expired])
    if (first !== 'expired') return first
  } finally {
    clearTimeout(timer)
  }
  // The client cannot be told to stop dialling. If it still gets through to a later server, hang
  // up at once; if it fails, that failure has already been reported as a timeout.
  attempt.then((late) => late.close()).catch(() => {})
  throw new natsErrors.TimeoutError()
}

/** Works out why a connection attempt failed, in terms a user can act on. */
export function classifyConnectError(err: unknown): { kind: TestFailureKind; message: string } {
  const chain: (Error & { code?: string })[] = []
  let current = err as (Error & { code?: string; cause?: unknown }) | undefined
  while (current && chain.length < 6) {
    chain.push(current)
    current = current.cause as typeof current
  }
  const text = chain.map((e) => `${e.name ?? ''} ${e.code ?? ''} ${e.message ?? ''}`).join(' | ')
  const last = chain[chain.length - 1]?.message || String(err)

  if (
    chain.some(
      (e) =>
        e instanceof natsErrors.AuthorizationError ||
        e instanceof natsErrors.UserAuthenticationExpiredError
    ) ||
    /authorization violation|authentication (expired|revoked|timeout)|account authentication/i.test(
      text
    )
  ) {
    return { kind: 'auth', message: 'Authentication failed: the server rejected these credentials' }
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text)) {
    return { kind: 'dns', message: `Server name could not be resolved (${last})` }
  }
  if (
    /certificate|self[- ]signed|CERT_|UNABLE_TO_VERIFY|ERR_TLS|ERR_SSL|EPROTO|ssl3|tls|handshake|wrong version number/i.test(
      text
    )
  ) {
    return { kind: 'tls', message: `TLS error: ${last}` }
  }
  if (chain.some((e) => e instanceof natsErrors.TimeoutError) || /timeout|ETIMEDOUT/i.test(text)) {
    return { kind: 'timeout', message: 'Timed out waiting for the server' }
  }
  if (/ECONNREFUSED|connection refused/i.test(text)) {
    return { kind: 'refused', message: 'Connection refused: nothing is listening on that address' }
  }
  return { kind: 'other', message: last }
}

/** One live connection to a NATS server plus the JetStream handles built on it. */
export class ManagedConnection {
  state: ConnectionState
  private jsmPromise: Promise<JetStreamManager> | undefined
  private jsClient: JetStreamClient | undefined
  private readonly reconnectListeners = new Set<() => void>()
  private readonly errorListeners = new Set<(err: Error) => void>()
  private closedByUser = false

  private constructor(
    readonly cfg: ConnectionConfig,
    readonly nc: NatsConnection,
    private readonly hooks: ConnectionHooks,
    private readonly backoff: ReconnectBackoff
  ) {
    this.state = {
      id: cfg.id,
      status: 'connected',
      server: nc.getServer(),
      serverName: nc.info?.server_name,
      version: nc.info?.version,
      reconnects: 0,
      since: Date.now()
    }
    void this.watchStatus()
    void this.watchClosed()
  }

  static async open(
    cfg: ConnectionConfig,
    secrets: ConnectSecrets,
    hooks: ConnectionHooks,
    timeoutMs?: number
  ): Promise<ManagedConnection> {
    const backoff = new ReconnectBackoff()
    const nc = await connect(buildConnectOptions(cfg, secrets, timeoutMs, backoff))
    backoff.reset()
    const conn = new ManagedConnection(cfg, nc, hooks, backoff)
    hooks.onState(conn.state)
    return conn
  }

  get serverVersion(): string | undefined {
    return this.nc.info?.version
  }

  get jsOptions(): JetStreamOptions {
    const opts: JetStreamOptions = { timeout: 10_000 }
    if (this.cfg.apiPrefix) opts.apiPrefix = this.cfg.apiPrefix
    else if (this.cfg.jsDomain) opts.domain = this.cfg.jsDomain
    return opts
  }

  jsm(): Promise<JetStreamManager> {
    if (!this.jsmPromise) {
      this.jsmPromise = jetstreamManager(this.nc, { ...this.jsOptions, checkAPI: false }).catch(
        (err) => {
          this.jsmPromise = undefined
          throw err
        }
      )
    }
    return this.jsmPromise
  }

  js(): JetStreamClient {
    if (!this.jsClient) this.jsClient = jetstream(this.nc, this.jsOptions)
    return this.jsClient
  }

  kvm(): Kvm {
    return new Kvm(this.js())
  }

  objm(): Objm {
    return new Objm(this.js())
  }

  /** Called after every successful reconnect. Returns a function that removes the listener. */
  onReconnect(listener: () => void): () => void {
    this.reconnectListeners.add(listener)
    return () => this.reconnectListeners.delete(listener)
  }

  /** Called for errors the server reports asynchronously, such as permission violations. */
  onAsyncError(listener: (err: Error) => void): () => void {
    this.errorListeners.add(listener)
    return () => this.errorListeners.delete(listener)
  }

  async close(): Promise<void> {
    this.closedByUser = true
    try {
      await this.nc.close()
    } catch {
      // Already closed.
    }
  }

  private setState(patch: Partial<ConnectionState>): void {
    this.state = { ...this.state, ...patch }
    this.hooks.onState(this.state)
  }

  private async watchStatus(): Promise<void> {
    try {
      for await (const status of this.nc.status()) {
        switch (status.type) {
          case 'disconnect':
          case 'reconnecting':
          case 'staleConnection':
            if (this.state.status !== 'reconnecting')
              this.setState({ status: 'reconnecting', error: undefined })
            break
          case 'reconnect':
            this.backoff.reset()
            this.setState({
              status: 'connected',
              error: undefined,
              server: this.nc.getServer(),
              serverName: this.nc.info?.server_name,
              version: this.nc.info?.version,
              reconnects: this.state.reconnects + 1,
              since: Date.now()
            })
            for (const listener of this.reconnectListeners) listener()
            break
          case 'error': {
            for (const listener of this.errorListeners) listener(status.error)
            const ge = toGatewayError(status.error)
            if (ge.kind === 'permission') this.hooks.onNotice('error', ge.message)
            break
          }
          case 'ldm':
            this.hooks.onNotice(
              'warning',
              `Server ${status.server} is shutting down; the client will move to another server`
            )
            break
        }
      }
    } catch {
      // The iterator ends when the connection closes.
    }
  }

  private async watchClosed(): Promise<void> {
    const err = await this.nc.closed()
    if (this.closedByUser) {
      this.setState({ status: 'disconnected', error: undefined })
      return
    }
    // The client gave up, which it only does for errors that retrying cannot fix.
    const reason = err
      ? classifyConnectError(err).message
      : 'The connection was closed by the server'
    this.setState({ status: 'error', error: reason })
  }
}
