import { randomUUID } from 'node:crypto'
import { jetstreamManager, type JetStreamManager } from '@nats-io/jetstream'
import { KvWatchInclude, type KvEntry, type KvStatus } from '@nats-io/kv'
import type { ObjectInfo, ObjectStoreStatus } from '@nats-io/obj'
import {
  DEFAULT_HEALTH_THRESHOLDS,
  GATEWAY_METHODS,
  type AccountInfoView,
  type AccountStatsDto,
  type AlertEvent,
  type AlertRule,
  type AppInfo,
  type AuditEntry,
  type AuditQuery,
  type CliImportResult,
  type ClusterView,
  type ConnectionConfig,
  type ConnectionInput,
  type ConnectionState,
  type ConnectionSummary,
  type ConnectSecrets,
  type ConsumerConfigDto,
  type ConsumerInfoDto,
  type GatewayMethodName,
  type GatewayMethods,
  type GatewayStreams,
  type GlobalEvent,
  type HealthSummary,
  type HealthThresholds,
  type KvBucketDto,
  type KvBucketInput,
  type KvEntryDto,
  type MessageDto,
  type MessagePage,
  type MessageQuery,
  type MetricsSeries,
  type MetricsTarget,
  type ObjBucketDto,
  type ObjBucketInput,
  type ObjectInfoDto,
  type PublishRequest,
  type PublishResult,
  type PurgeRequest,
  type RequestRequest,
  type RequestResult,
  type ScanEvent,
  type SearchIndex,
  type ServerInfoView,
  type StreamChannel,
  type StreamConfigDto,
  type StreamInfoDto,
  type SubjectCount,
  type SubjectsPage,
  type SubjectsQuery,
  type TailMessage,
  type TestConnectionResult
} from '@shared/api'
import { clampTestTimeoutMs } from '@shared/connection'
import { toBase64 } from '@shared/encoding'
import { compileFilters } from '@shared/filters'
import { evaluateConsumerHealth } from '@shared/health'
import { versionAtLeast } from '@shared/semver'
import { validateSubject } from '@shared/subject'
import { AlertEngine } from './alerts'
import { AuditLog, DEFAULT_AUDIT_RETENTION_DAYS } from './audit'
import { ConnectionStore } from './connectionStore'
import { currentUser } from './context'
import {
  decodePayload,
  headersToList,
  listToHeaders,
  PREVIEW_BYTES,
  storedHeaders,
  storedToDto,
  truncatedBase64
} from './convert'
import { gatewayError, toGatewayError } from './errors'
import { MessageReader, pickReadMode, type StreamBounds } from './messageReader'
import {
  buildConnectOptions,
  classifyConnectError,
  connectWithin,
  ManagedConnection
} from './natsConnection'
import { DEFAULT_SAMPLER_OPTIONS, MetricsSampler, type SamplerOptions } from './sampler'
import type { SecretStore } from './secrets'
import { SettingsStore } from './settings'
import { readClusterInfo } from './sysInfo'

export interface StudioServiceOptions {
  dataDir: string
  secretStore: SecretStore
  cliContextDir: string
  mode: 'desktop' | 'web'
  appVersion: string
  natsClientVersion: string
  sampler?: Partial<SamplerOptions>
  /** Web mode: users may not add, change or remove connections. */
  lockConnections?: boolean
  /** Web mode: treat every connection as read-only, whatever its own setting says. */
  forceReadOnly?: boolean
  /** Web mode: sign-out is available. */
  canSignOut?: boolean
}

type Emit<K extends StreamChannel> = (event: GatewayStreams[K]['event']) => void

const MAX_MESSAGE_BYTES = 1024 * 1024
const MAX_PAGE = 1000
const TAIL_FLUSH_MS = 100
const TAIL_MAX_BATCH = 2000
const TAIL_PAYLOAD_BYTES = 32 * 1024
const DOWNLOAD_CHUNK = 256 * 1024
const METHOD_SET = new Set<string>(GATEWAY_METHODS)

interface Upload {
  connId: string
  bucket: string
  name: string
  controller: ReadableStreamDefaultController<Uint8Array>
  done: Promise<ObjectInfo>
  bytes: number
}

/**
 * Implements the gateway on top of real NATS connections.
 * It knows nothing about Electron or HTTP: the desktop main process and the web server both wrap it.
 */
export class StudioService implements GatewayMethods {
  readonly store: ConnectionStore
  readonly settings: SettingsStore
  readonly audit: AuditLog
  readonly alerts: AlertEngine

  private readonly conns = new Map<string, ManagedConnection>()
  private readonly samplers = new Map<string, MetricsSampler>()
  private readonly states = new Map<string, ConnectionState>()
  private readonly connecting = new Map<string, Promise<ConnectionState>>()
  private readonly listeners = new Set<(event: GlobalEvent) => void>()
  private readonly openStreams = new Map<number, { connId?: string; close: () => void }>()
  private readonly uploads = new Map<string, Upload>()
  private readonly subjectCache = new Map<string, { at: number; entries: SubjectCount[] }>()
  private nextStreamId = 1

  constructor(private readonly opts: StudioServiceOptions) {
    this.store = new ConnectionStore(opts.dataDir, opts.secretStore, opts.cliContextDir)
    this.settings = new SettingsStore(opts.dataDir)
    this.audit = new AuditLog(opts.dataDir)
    this.alerts = new AlertEngine(this.settings, (alert) =>
      this.emitGlobal({ type: 'alert', alert })
    )
    this.audit.prune(
      this.settings.get<number>('audit.retentionDays') ?? DEFAULT_AUDIT_RETENTION_DAYS
    )
  }

  // ───────────────────────── transport entry points ─────────────────────────

  /** Calls a gateway method by name. This is the only way transports reach the service. */
  async invoke(method: string, args: unknown[]): Promise<unknown> {
    if (!METHOD_SET.has(method))
      throw gatewayError('internal', `Unknown gateway method "${method}"`)
    try {
      const fn = this[method as GatewayMethodName] as (...a: unknown[]) => Promise<unknown>
      return await fn.apply(this, args)
    } catch (err) {
      throw toGatewayError(err)
    }
  }

  /** Starts a streaming operation and returns the function that stops it. */
  open<K extends StreamChannel>(
    channel: K,
    args: GatewayStreams[K]['args'],
    emit: Emit<K>
  ): () => void {
    const id = this.nextStreamId++
    let closed = false
    let stop: () => void = () => {}
    const close = (): void => {
      if (closed) return
      closed = true
      this.openStreams.delete(id)
      stop()
    }
    // A stream never delivers events before open() has returned, so callers can always finish
    // setting up (for example storing the close function) before the first event arrives.
    let opening = true
    const deliver = emit as (e: unknown) => void
    const guarded = ((event: unknown) => {
      if (closed) return
      if (opening) {
        queueMicrotask(() => {
          if (!closed) deliver(event)
        })
      } else {
        deliver(event)
      }
    }) as Emit<K>

    switch (channel) {
      case 'events': {
        const listener = guarded as (e: GlobalEvent) => void
        this.listeners.add(listener)
        stop = () => this.listeners.delete(listener)
        break
      }
      case 'tail':
        stop = this.openTail(args as GatewayStreams['tail']['args'], guarded as Emit<'tail'>)
        break
      case 'scan':
        stop = this.openScan(args as GatewayStreams['scan']['args'], guarded as Emit<'scan'>)
        break
      case 'kvWatch':
        stop = this.openKvWatch(
          args as GatewayStreams['kvWatch']['args'],
          guarded as Emit<'kvWatch'>
        )
        break
      case 'objDownload':
        stop = this.openObjDownload(
          args as GatewayStreams['objDownload']['args'],
          guarded as Emit<'objDownload'>
        )
        break
      default:
        throw gatewayError('internal', `Unknown stream channel "${String(channel)}"`)
    }
    opening = false
    this.openStreams.set(id, { connId: (args as { connId?: string }).connId, close })
    return close
  }

  async dispose(): Promise<void> {
    for (const s of [...this.openStreams.values()]) s.close()
    for (const sampler of this.samplers.values()) sampler.stop()
    this.samplers.clear()
    await Promise.all([...this.conns.values()].map((c) => c.close()))
    this.conns.clear()
  }

  private emitGlobal(event: GlobalEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  // ───────────────────────── helpers ─────────────────────────

  private conn(connId: string): ManagedConnection {
    const conn = this.conns.get(connId)
    if (!conn || conn.nc.isClosed())
      throw gatewayError('not_connected', 'Not connected to this server')
    if (conn.state.status === 'reconnecting') {
      throw gatewayError('not_connected', 'The connection was lost. Reconnecting to the server...')
    }
    return conn
  }

  private config(connId: string): ConnectionConfig {
    const cfg = this.store.get(connId)
    if (!cfg) throw gatewayError('not_found', 'This connection no longer exists')
    return this.opts.forceReadOnly ? { ...cfg, readOnly: true } : cfg
  }

  private requireUnlocked(): void {
    if (this.opts.lockConnections) {
      throw gatewayError(
        'validation',
        'Connections on this server are managed by its administrator and cannot be changed here.'
      )
    }
  }

  /**
   * Creates or updates connections from an administrator's file (web mode). Connections are
   * matched by name, so restarting with the same file does not create duplicates.
   */
  provision(inputs: ConnectionInput[]): void {
    const existing = this.store.list().filter((c) => c.source === 'studio')
    for (const input of inputs) {
      const match = existing.find((c) => c.name === input.name?.trim())
      this.store.save({ ...input, id: match?.id })
    }
  }

  /**
   * Runs an action that changes server state. This is the one place that enforces read-only mode
   * (PBI-016) and writes the audit log (PBI-092), whatever the UI did or did not disable.
   */
  private async mutate<T>(
    connId: string,
    action: string,
    target: string,
    fn: (conn: ManagedConnection) => Promise<T>,
    detail?: string
  ): Promise<T> {
    const cfg = this.config(connId)
    const entry: Omit<AuditEntry, 'time' | 'result'> = {
      connId,
      connName: cfg.name,
      action,
      target,
      detail
    }
    if (cfg.readOnly) {
      this.audit.record({ ...entry, result: 'blocked' })
      throw gatewayError(
        'read_only',
        `"${cfg.name}" is read-only. Turn off read-only mode on the connection to make changes.`
      )
    }
    try {
      const result = await fn(this.conn(connId))
      this.audit.record({ ...entry, result: 'ok' })
      return result
    } catch (err) {
      const ge = toGatewayError(err)
      this.audit.record({
        ...entry,
        result: 'error',
        detail: [detail, ge.message].filter(Boolean).join(' | ')
      })
      throw ge
    }
  }

  private healthThresholds(connId: string): HealthThresholds {
    return {
      ...DEFAULT_HEALTH_THRESHOLDS,
      ...(this.settings.get<Partial<HealthThresholds>>(`conn:${connId}:health`) ?? {})
    }
  }

  private withHealth(
    connId: string,
    info: ConsumerInfoDto,
    thresholds = this.healthThresholds(connId)
  ): ConsumerInfoDto {
    const samples =
      this.samplers
        .get(connId)
        ?.consumerSamples(info.stream_name, info.name, thresholds.lagSamples + 1) ?? []
    return { ...info, health: evaluateConsumerHealth(info, samples, thresholds, Date.now()) }
  }

  // ───────────────────────── app ─────────────────────────

  async appInfo(): Promise<AppInfo> {
    return {
      version: this.opts.appVersion,
      natsClientVersion: this.opts.natsClientVersion,
      mode: this.opts.mode,
      secretStorage: this.opts.secretStore.secure,
      platform: process.platform,
      cliContextDir: this.store.cliDir,
      user: currentUser(),
      connectionsLocked: Boolean(this.opts.lockConnections),
      canSignOut: Boolean(this.opts.canSignOut)
    }
  }

  // ───────────────────────── connections ─────────────────────────

  private stateOf(id: string): ConnectionState {
    return this.states.get(id) ?? { id, status: 'disconnected', reconnects: 0 }
  }

  private setState(state: ConnectionState): void {
    this.states.set(state.id, state)
    this.emitGlobal({ type: 'connection', state })
  }

  async listConnections(): Promise<ConnectionSummary[]> {
    return this.store.list().map((cfg) => ({
      ...cfg,
      readOnly: this.opts.forceReadOnly ? true : cfg.readOnly,
      state: this.stateOf(cfg.id)
    }))
  }

  async saveConnection(input: ConnectionInput): Promise<ConnectionSummary> {
    this.requireUnlocked()
    const before = input.id ? this.store.get(input.id) : undefined
    const cfg = this.store.save(input)
    if (before && this.conns.has(cfg.id)) {
      const wire = (c: ConnectionConfig): string =>
        JSON.stringify([
          c.servers,
          c.auth,
          c.user,
          c.credsFile,
          c.nkeyFile,
          c.tls,
          c.jsDomain,
          c.apiPrefix,
          c.inboxPrefix
        ])
      const secretChanged = Boolean(input.password || input.token || input.nkeySeed)
      // Settings that affect the wire only take effect on a new connection.
      if (wire(before) !== wire(cfg) || secretChanged) await this.disconnect(cfg.id)
    }
    this.emitGlobal({ type: 'connections_changed' })
    return { ...cfg, state: this.stateOf(cfg.id) }
  }

  async duplicateConnection(id: string): Promise<ConnectionSummary> {
    this.requireUnlocked()
    const cfg = this.store.duplicate(id)
    this.emitGlobal({ type: 'connections_changed' })
    return { ...cfg, state: this.stateOf(cfg.id) }
  }

  async deleteConnection(id: string): Promise<void> {
    this.requireUnlocked()
    await this.disconnect(id)
    this.store.delete(id)
    this.settings.removeConnection(id)
    this.states.delete(id)
    this.emitGlobal({ type: 'connections_changed' })
  }

  async refreshCliContexts(): Promise<CliImportResult> {
    const result = this.store.refreshCli()
    this.emitGlobal({ type: 'connections_changed' })
    return result
  }

  async testConnection(input: ConnectionInput): Promise<TestConnectionResult> {
    const stored = input.id ? this.store.resolveSecrets(input.id) : {}
    const existing = input.id ? this.store.get(input.id) : undefined
    const secrets: ConnectSecrets = {
      password: input.password || stored.password,
      token: input.token || stored.token,
      nkeySeed: input.nkeySeed || stored.nkeySeed
    }
    // A stored value that is not a sensible number must not hang or instantly fail every test.
    const timeoutMs = clampTestTimeoutMs(this.settings.get('testTimeoutMs'))
    let nc
    try {
      const cfg =
        existing?.source === 'cli'
          ? existing
          : { ...input, servers: this.normalizedServers(input.servers) }
      // One deadline for connecting, however many servers the connection lists.
      nc = await connectWithin(buildConnectOptions(cfg, secrets, timeoutMs), timeoutMs)
    } catch (err) {
      const ge = toGatewayError(err)
      if (ge.kind === 'secret_required' || ge.kind === 'validation')
        return { ok: false, kind: 'other', message: ge.message }
      return { ok: false, ...classifyConnectError(err) }
    }
    try {
      const rttMs = await nc.rtt()
      let jetstream = false
      let jetstreamNote: string | undefined
      try {
        const jsOpts = input.apiPrefix
          ? { apiPrefix: input.apiPrefix }
          : input.jsDomain
            ? { domain: input.jsDomain }
            : {}
        const jsm = await jetstreamManager(nc, { ...jsOpts, timeout: timeoutMs, checkAPI: false })
        await jsm.getAccountInfo()
        jetstream = true
      } catch (err) {
        jetstreamNote = toGatewayError(err).message
      }
      return {
        ok: true,
        serverName: nc.info?.server_name ?? '',
        version: nc.info?.version ?? '',
        cluster: nc.info?.cluster,
        rttMs,
        jetstream,
        jetstreamNote
      }
    } finally {
      await nc.close().catch(() => {})
    }
  }

  private normalizedServers(servers: string[]): string[] {
    return servers
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (/^[a-z]+:\/\//i.test(s) ? s : `nats://${s}`))
  }

  async connect(id: string, secrets?: ConnectSecrets): Promise<ConnectionState> {
    const live = this.conns.get(id)
    if (live && !live.nc.isClosed()) return live.state
    const pending = this.connecting.get(id)
    if (pending) return pending

    const attempt = (async (): Promise<ConnectionState> => {
      const cfg = this.config(id)
      const resolved = { ...this.store.resolveSecrets(id), ...stripEmpty(secrets) }
      this.setState({ id, status: 'connecting', reconnects: 0 })
      try {
        const conn = await ManagedConnection.open(cfg, resolved, {
          onState: (state) => this.setState(state),
          onNotice: (level, message) =>
            this.emitGlobal({ type: 'notice', connId: id, level, message })
        })
        this.conns.set(id, conn)
        const sampler = new MetricsSampler(
          conn,
          { ...DEFAULT_SAMPLER_OPTIONS, ...this.opts.sampler },
          (s, now) => this.alerts.evaluate(id, s.latestStreams, s.latestConsumers, now)
        )
        this.samplers.set(id, sampler)
        sampler.start()
        return conn.state
      } catch (err) {
        const ge = toGatewayError(err)
        if (ge.kind === 'secret_required') {
          this.setState({ id, status: 'disconnected', reconnects: 0 })
          throw ge
        }
        const message = ge.kind === 'validation' ? ge.message : classifyConnectError(err).message
        this.setState({ id, status: 'error', error: message, reconnects: 0 })
        throw gatewayError(ge.kind === 'validation' ? 'validation' : 'nats', message)
      }
    })()
    this.connecting.set(id, attempt)
    try {
      return await attempt
    } finally {
      this.connecting.delete(id)
    }
  }

  async disconnect(id: string): Promise<void> {
    // Stop everything that belongs to this connection before closing it.
    for (const s of [...this.openStreams.values()]) if (s.connId === id) s.close()
    for (const [uploadId, upload] of this.uploads) {
      if (upload.connId === id) {
        upload.controller.error(new Error('Disconnected'))
        upload.done.catch(() => {})
        this.uploads.delete(uploadId)
      }
    }
    this.samplers.get(id)?.stop()
    this.samplers.delete(id)
    const conn = this.conns.get(id)
    this.conns.delete(id)
    if (conn) await conn.close()
    if (this.store.get(id)) this.setState({ id, status: 'disconnected', reconnects: 0 })
  }

  // ───────────────────────── overview ─────────────────────────

  async serverInfo(connId: string): Promise<ServerInfoView> {
    const conn = this.conn(connId)
    const info = conn.nc.info
    if (!info) throw gatewayError('not_connected', 'The server has not sent its info yet')
    const rttMs = await conn.nc.rtt()

    let user: string | undefined
    let account: string | undefined
    try {
      const reply = await conn.nc.request('$SYS.REQ.USER.INFO', '', { timeout: 2000 })
      const data = reply.json<{ data?: { user?: string; account?: string } }>().data
      user = data?.user
      account = data?.account
    } catch {
      // Older servers and restricted users do not answer; the fields are simply left out.
    }

    let jsDomain: string | undefined = conn.cfg.jsDomain
    if (info.jetstream && !jsDomain) {
      try {
        jsDomain = ((await (await conn.jsm()).getAccountInfo()) as unknown as AccountStatsDto)
          .domain
      } catch {
        // JetStream may be off for this account.
      }
    }

    return {
      serverName: info.server_name,
      serverId: info.server_id,
      version: info.version,
      cluster: info.cluster,
      connectedUrl: conn.nc.getServer(),
      host: info.host,
      port: info.port,
      maxPayload: info.max_payload,
      tls: Boolean(info.tls_required || (info.tls_available && conn.cfg.tls)),
      jetstream: Boolean(info.jetstream),
      jsDomain,
      clientId: info.client_id,
      clientIp: info.client_ip,
      user,
      account,
      rttMs
    }
  }

  async accountInfo(connId: string): Promise<AccountInfoView> {
    const conn = this.conn(connId)
    try {
      const stats = await (await conn.jsm()).getAccountInfo()
      return { enabled: true, stats: stats as unknown as AccountStatsDto }
    } catch (err) {
      const ge = toGatewayError(err)
      if (ge.kind === 'permission') throw ge
      if (ge.kind === 'jetstream' || ge.kind === 'no_responders' || ge.kind === 'timeout') {
        return {
          enabled: false,
          reason:
            ge.natsCode === 10039 || ge.kind !== 'timeout'
              ? 'JetStream is not enabled for this account.'
              : 'JetStream did not answer. It may be disabled, or the domain or API prefix on this connection may be wrong.'
        }
      }
      throw ge
    }
  }

  async clusterInfo(connId: string): Promise<ClusterView> {
    return readClusterInfo(this.conn(connId).nc)
  }

  // ───────────────────────── streams ─────────────────────────

  async listStreams(connId: string): Promise<StreamInfoDto[]> {
    const jsm = await this.conn(connId).jsm()
    const out: StreamInfoDto[] = []
    for await (const info of jsm.streams.list()) out.push(info as unknown as StreamInfoDto)
    return out
  }

  async streamInfo(connId: string, stream: string): Promise<StreamInfoDto> {
    const jsm = await this.conn(connId).jsm()
    return (await jsm.streams.info(stream)) as unknown as StreamInfoDto
  }

  async createStream(connId: string, config: StreamConfigDto): Promise<StreamInfoDto> {
    if (!config?.name?.trim()) throw gatewayError('validation', 'Stream name is required')
    return this.mutate(connId, 'stream.create', config.name, async (conn) => {
      const jsm = await conn.jsm()
      // The client rewrites parts of the object it is given, so hand it a copy.
      return (await jsm.streams.add(structuredClone(config) as never)) as unknown as StreamInfoDto
    })
  }

  async updateStream(
    connId: string,
    stream: string,
    config: StreamConfigDto
  ): Promise<StreamInfoDto> {
    return this.mutate(connId, 'stream.update', stream, async (conn) => {
      const jsm = await conn.jsm()
      return (await jsm.streams.update(
        stream,
        structuredClone(config) as never
      )) as unknown as StreamInfoDto
    })
  }

  async deleteStream(connId: string, stream: string): Promise<void> {
    await this.mutate(connId, 'stream.delete', stream, async (conn) => {
      await (await conn.jsm()).streams.delete(stream)
    })
  }

  async purgeStream(
    connId: string,
    stream: string,
    request: PurgeRequest
  ): Promise<{ purged: number }> {
    const opts: Record<string, unknown> = {}
    if (request.filter) {
      const invalid = validateSubject(request.filter)
      if (invalid) throw gatewayError('validation', invalid)
      opts.filter = request.filter
    }
    if (request.seq !== undefined && request.keep !== undefined) {
      throw gatewayError('validation', 'Choose either "up to sequence" or "keep last", not both')
    }
    if (request.seq !== undefined) opts.seq = request.seq
    if (request.keep !== undefined) opts.keep = request.keep
    return this.mutate(
      connId,
      'stream.purge',
      stream,
      async (conn) => {
        const result = await (await conn.jsm()).streams.purge(stream, opts as never)
        return { purged: result.purged }
      },
      Object.keys(opts).length ? JSON.stringify(opts) : 'all messages'
    )
  }

  async streamSubjects(
    connId: string,
    stream: string,
    query: SubjectsQuery
  ): Promise<SubjectsPage> {
    const filter = query.filter?.trim() || '>'
    const invalid = validateSubject(filter)
    if (invalid) throw gatewayError('validation', invalid)

    const cacheKey = `${connId}|${stream}|${filter}`
    let cached = this.subjectCache.get(cacheKey)
    if (!cached || Date.now() - cached.at > 15_000) {
      const jsm = await this.conn(connId).jsm()
      const info = await jsm.streams.info(stream, { subjects_filter: filter })
      const subjects = (info.state.subjects ?? {}) as Record<string, number>
      cached = {
        at: Date.now(),
        entries: Object.entries(subjects).map(([subject, count]) => ({ subject, count }))
      }
      this.subjectCache.set(cacheKey, cached)
      // Subject lists can be large; keep only the few most recent ones.
      while (this.subjectCache.size > 4)
        this.subjectCache.delete(this.subjectCache.keys().next().value!)
    }
    const sorted = [...cached.entries]
    if (query.sort === 'subject') sorted.sort((a, b) => a.subject.localeCompare(b.subject))
    else sorted.sort((a, b) => b.count - a.count || a.subject.localeCompare(b.subject))
    const offset = Math.max(0, query.offset ?? 0)
    const limit = Math.min(Math.max(1, query.limit ?? 1000), 10_000)
    return { subjects: sorted.slice(offset, offset + limit), total: sorted.length, offset }
  }

  // ───────────────────────── messages ─────────────────────────

  private async reader(
    conn: ManagedConnection,
    stream: string
  ): Promise<{ reader: MessageReader; bounds: StreamBounds }> {
    const jsm = await conn.jsm()
    const info = await jsm.streams.info(stream)
    return {
      reader: new MessageReader(
        jsm,
        stream,
        pickReadMode(info.config.allow_direct, conn.serverVersion)
      ),
      bounds: {
        firstSeq: info.state.first_seq,
        lastSeq: info.state.last_seq,
        messages: info.state.messages
      }
    }
  }

  /** Turns "first", "last", a sequence or a time into the sequence to start walking from. */
  private async resolveStart(
    reader: MessageReader,
    bounds: StreamBounds,
    query: MessageQuery
  ): Promise<{ seq: number; notice?: string }> {
    const { start } = query
    switch (start.kind) {
      case 'first':
        return { seq: bounds.firstSeq }
      case 'last':
        return { seq: bounds.lastSeq }
      case 'seq': {
        if (!Number.isFinite(start.seq))
          throw gatewayError('validation', 'Sequence must be a number')
        if (start.seq < bounds.firstSeq) {
          return {
            seq: bounds.firstSeq,
            notice: `Sequence ${start.seq} is before the first message. Showing from ${bounds.firstSeq}.`
          }
        }
        if (start.seq > bounds.lastSeq) {
          return {
            seq: bounds.lastSeq,
            notice: `Sequence ${start.seq} is after the last message. Showing from ${bounds.lastSeq}.`
          }
        }
        return { seq: start.seq }
      }
      case 'time': {
        const time = new Date(start.time)
        if (Number.isNaN(time.getTime()))
          throw gatewayError('validation', 'Start time is not a valid date')
        const seq = await reader.seqForTime(time, bounds)
        if (seq > bounds.lastSeq) {
          return {
            seq: bounds.lastSeq,
            notice: 'No messages at or after that time. Showing the latest message.'
          }
        }
        return { seq }
      }
    }
  }

  private walk(
    reader: MessageReader,
    bounds: StreamBounds,
    query: MessageQuery,
    seq: number
  ): AsyncGenerator<import('@nats-io/jetstream').StoredMsg> {
    const subject = query.subject?.trim() || undefined
    return query.direction === 'asc'
      ? reader.forward(seq, undefined, subject, query.limit)
      : reader.backward(seq + 1, bounds.firstSeq, subject, query.limit)
  }

  async getMessages(connId: string, stream: string, query: MessageQuery): Promise<MessagePage> {
    if (query.subject) {
      const invalid = validateSubject(query.subject.trim())
      if (invalid) throw gatewayError('validation', invalid)
    }
    const limit = Math.min(Math.max(1, Math.floor(query.limit)), MAX_PAGE)
    const { reader, bounds } = await this.reader(this.conn(connId), stream)
    const page: MessagePage = {
      messages: [],
      exhausted: true,
      startSeq: 0,
      firstSeq: bounds.firstSeq,
      lastSeq: bounds.lastSeq
    }
    if (bounds.messages === 0) return page

    const start = await this.resolveStart(reader, bounds, query)
    page.startSeq = start.seq
    page.notice = start.notice
    page.exhausted = true
    const direct = reader.mode !== 'api'
    for await (const msg of this.walk(reader, bounds, { ...query, limit }, start.seq)) {
      if (page.messages.length >= limit) {
        // One more message exists, so the walk did not reach the end.
        page.exhausted = false
        break
      }
      page.messages.push(storedToDto(msg, query.payloadBytes ?? PREVIEW_BYTES, direct))
    }
    return page
  }

  async getMessage(
    connId: string,
    stream: string,
    seq: number,
    payloadBytes = MAX_MESSAGE_BYTES
  ): Promise<MessageDto> {
    const jsm = await this.conn(connId).jsm()
    const msg = await jsm.streams.getMessage(stream, { seq })
    if (!msg)
      throw gatewayError(
        'not_found',
        `Message ${seq} is no longer in the stream (deleted or expired)`,
        { natsCode: 10037 }
      )
    return storedToDto(msg, payloadBytes)
  }

  async deleteMessage(connId: string, stream: string, seq: number, erase: boolean): Promise<void> {
    await this.mutate(
      connId,
      'message.delete',
      `${stream} #${seq}`,
      async (conn) => {
        try {
          await (await conn.jsm()).streams.deleteMessage(stream, seq, erase)
        } catch (err) {
          const ge = toGatewayError(err)
          // Depending on the erase mode the server words a missing message differently.
          if (/no message found|sequence \d+ not found|store EOF/i.test(ge.message)) {
            throw gatewayError(
              'not_found',
              `Message ${seq} is not in the stream (already deleted or expired)`,
              { natsCode: ge.natsCode }
            )
          }
          throw ge
        }
      },
      erase ? 'secure erase' : 'no erase'
    )
  }

  private openScan(args: GatewayStreams['scan']['args'], emit: Emit<'scan'>): () => void {
    let cancelled = false
    const { connId, stream, request } = args

    const run = async (): Promise<void> => {
      let scanned = 0
      let matched = 0
      let skippedNonJson = 0
      let resumeSeq: number | null = null
      const done = (
        reason: Extract<ScanEvent, { type: 'done' }>['reason'],
        error?: unknown
      ): void =>
        emit({
          type: 'done',
          reason,
          scanned,
          matched,
          skippedNonJson,
          resumeSeq,
          error: error ? toGatewayError(error).toJSON() : undefined
        })

      try {
        if (request.subject) {
          const invalid = validateSubject(request.subject.trim())
          if (invalid) throw gatewayError('validation', invalid)
        }
        let test
        try {
          test = compileFilters(request.filters)
        } catch (err) {
          throw gatewayError('validation', (err as Error).message)
        }
        const limit = Math.min(Math.max(1, Math.floor(request.limit)), MAX_PAGE)
        const scanLimit = Math.max(1, Math.floor(request.scanLimit))
        const { reader, bounds } = await this.reader(this.conn(connId), stream)
        if (bounds.messages === 0) return done('end')
        const start = await this.resolveStart(reader, bounds, request)
        const direct = reader.mode !== 'api'

        let pending: MessageDto[] = []
        let lastFlush = Date.now()
        const flush = (seq: number): void => {
          if (pending.length) emit({ type: 'matches', messages: pending })
          pending = []
          emit({ type: 'progress', scanned, matched, seq })
          lastFlush = Date.now()
        }

        for await (const msg of this.walk(reader, bounds, { ...request, limit: 200 }, start.seq)) {
          if (cancelled) return done('cancelled')
          scanned++
          resumeSeq = request.direction === 'asc' ? msg.seq + 1 : msg.seq - 1
          const verdict = test(storedHeaders(msg, direct), msg.data)
          if (verdict.nonJson) skippedNonJson++
          if (verdict.match) {
            matched++
            pending.push(storedToDto(msg, request.payloadBytes ?? PREVIEW_BYTES, direct))
          }
          if (matched >= limit) {
            flush(msg.seq)
            return done('page')
          }
          if (scanned >= scanLimit) {
            flush(msg.seq)
            return done('limit')
          }
          if (Date.now() - lastFlush > 150) flush(msg.seq)
        }
        flush(0)
        resumeSeq = null
        done('end')
      } catch (err) {
        done('error', err)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }

  // ───────────────────────── consumers ─────────────────────────

  async listConsumers(connId: string, stream: string): Promise<ConsumerInfoDto[]> {
    const jsm = await this.conn(connId).jsm()
    const thresholds = this.healthThresholds(connId)
    const out: ConsumerInfoDto[] = []
    for await (const info of jsm.consumers.list(stream)) {
      out.push(this.withHealth(connId, info as unknown as ConsumerInfoDto, thresholds))
    }
    return out
  }

  async listAllConsumers(connId: string): Promise<ConsumerInfoDto[]> {
    const jsm = await this.conn(connId).jsm()
    const thresholds = this.healthThresholds(connId)
    const streams: string[] = []
    for await (const info of jsm.streams.list()) {
      if (info.state.consumer_count > 0) streams.push(info.config.name)
    }
    const out: ConsumerInfoDto[] = []
    await mapLimit(streams, 6, async (stream) => {
      for await (const info of jsm.consumers.list(stream)) {
        out.push(this.withHealth(connId, info as unknown as ConsumerInfoDto, thresholds))
      }
    })
    out.sort((a, b) => a.stream_name.localeCompare(b.stream_name) || a.name.localeCompare(b.name))
    return out
  }

  async consumerInfo(connId: string, stream: string, consumer: string): Promise<ConsumerInfoDto> {
    const jsm = await this.conn(connId).jsm()
    return this.withHealth(
      connId,
      (await jsm.consumers.info(stream, consumer)) as unknown as ConsumerInfoDto
    )
  }

  async createConsumer(
    connId: string,
    stream: string,
    config: ConsumerConfigDto
  ): Promise<ConsumerInfoDto> {
    const name = config.name ?? config.durable_name ?? '(ephemeral)'
    return this.mutate(connId, 'consumer.create', `${stream} > ${name}`, async (conn) => {
      const jsm = await conn.jsm()
      return (await jsm.consumers.add(
        stream,
        structuredClone(config) as never
      )) as unknown as ConsumerInfoDto
    })
  }

  async updateConsumer(
    connId: string,
    stream: string,
    consumer: string,
    config: ConsumerConfigDto
  ): Promise<ConsumerInfoDto> {
    return this.mutate(connId, 'consumer.update', `${stream} > ${consumer}`, async (conn) => {
      const jsm = await conn.jsm()
      return (await jsm.consumers.update(
        stream,
        consumer,
        structuredClone(config) as never
      )) as unknown as ConsumerInfoDto
    })
  }

  async deleteConsumer(connId: string, stream: string, consumer: string): Promise<void> {
    await this.mutate(connId, 'consumer.delete', `${stream} > ${consumer}`, async (conn) => {
      await (await conn.jsm()).consumers.delete(stream, consumer)
    })
  }

  private requirePauseSupport(conn: ManagedConnection): void {
    if (!versionAtLeast(conn.serverVersion, '2.11.0')) {
      throw gatewayError(
        'unsupported',
        `Pausing consumers needs NATS Server 2.11 or newer. This server runs ${conn.serverVersion ?? 'an unknown version'}.`
      )
    }
  }

  async pauseConsumer(
    connId: string,
    stream: string,
    consumer: string,
    until: string
  ): Promise<ConsumerInfoDto> {
    const when = new Date(until)
    if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) {
      throw gatewayError('validation', 'Pause time must be in the future')
    }
    return this.mutate(
      connId,
      'consumer.pause',
      `${stream} > ${consumer}`,
      async (conn) => {
        this.requirePauseSupport(conn)
        const jsm = await conn.jsm()
        await jsm.consumers.pause(stream, consumer, when)
        return this.withHealth(
          connId,
          (await jsm.consumers.info(stream, consumer)) as unknown as ConsumerInfoDto
        )
      },
      `until ${when.toISOString()}`
    )
  }

  async resumeConsumer(connId: string, stream: string, consumer: string): Promise<ConsumerInfoDto> {
    return this.mutate(connId, 'consumer.resume', `${stream} > ${consumer}`, async (conn) => {
      this.requirePauseSupport(conn)
      const jsm = await conn.jsm()
      await jsm.consumers.resume(stream, consumer)
      return this.withHealth(
        connId,
        (await jsm.consumers.info(stream, consumer)) as unknown as ConsumerInfoDto
      )
    })
  }

  // ───────────────────────── live tail, publish, request ─────────────────────────

  private openTail(args: GatewayStreams['tail']['args'], emit: Emit<'tail'>): () => void {
    let conn: ManagedConnection
    try {
      const invalid = validateSubject(args.subject)
      if (invalid) throw gatewayError('validation', invalid)
      conn = this.conn(args.connId)
    } catch (err) {
      queueMicrotask(() => emit({ type: 'error', error: toGatewayError(err).toJSON() }))
      return () => {}
    }

    const payloadBytes = args.payloadBytes ?? TAIL_PAYLOAD_BYTES
    let buffer: TailMessage[] = []
    let dropped = 0
    let nextId = 1

    let failed = false
    const sub = conn.nc.subscribe(args.subject, {
      callback: (err, msg) => {
        if (err) {
          failed = true
          emit({ type: 'error', error: toGatewayError(err).toJSON() })
          return
        }
        // If the UI cannot keep up, drop the oldest messages of this batch and say how many.
        if (buffer.length >= TAIL_MAX_BATCH) {
          buffer.shift()
          dropped++
        }
        buffer.push({
          id: nextId++,
          subject: msg.subject,
          received: Date.now(),
          size: msg.data.length,
          headers: headersToList(msg.headers),
          reply: msg.reply || undefined,
          ...truncatedBase64(msg.data, payloadBytes)
        })
      }
    })
    const timer = setInterval(() => {
      if (buffer.length === 0 && dropped === 0) return
      emit({ type: 'messages', messages: buffer, dropped })
      buffer = []
      dropped = 0
    }, TAIL_FLUSH_MS)
    // Subscribing only queues the request. The server has it once it has answered a flush sent
    // after it, and only then is it true that nothing published from now on is missed.
    let ready = false
    let closed = false
    const announce = (): void => {
      conn.nc.flush().then(
        () => {
          // A subscription the server refused has reported its error by now.
          if (closed || ready || failed) return
          ready = true
          emit({ type: 'ready' })
        },
        () => {
          // The connection dropped first. The reconnect below asks again.
        }
      )
    }
    announce()
    const offReconnect = conn.onReconnect(() => {
      emit({ type: 'gap' })
      if (!ready) announce()
    })

    return () => {
      closed = true
      clearInterval(timer)
      offReconnect()
      try {
        sub.unsubscribe()
      } catch {
        // The connection may already be closed.
      }
    }
  }

  async publish(connId: string, request: PublishRequest): Promise<PublishResult> {
    const invalid = validateSubject(request.subject, false)
    if (invalid) throw gatewayError('validation', invalid)
    const data = decodePayload(request.payload)
    const hdrs = listToHeaders(request.headers)

    return this.mutate(
      connId,
      request.mode === 'jetstream' ? 'publish.jetstream' : 'publish',
      request.subject,
      async (conn) => {
        if (request.mode === 'jetstream') {
          try {
            const ack = await conn
              .js()
              .publish(request.subject, data, { headers: hdrs, timeout: 5000 })
            return { ack: { stream: ack.stream, seq: ack.seq, duplicate: ack.duplicate } }
          } catch (err) {
            const ge = toGatewayError(err)
            // Nothing answering a JetStream publish means no stream captures the subject. The client
            // words that as "JetStream not enabled", which would send the user looking in the wrong place.
            const unanswered =
              ge.kind === 'no_responders' || (ge.kind === 'jetstream' && ge.natsCode === undefined)
            if (unanswered || /no response from stream|503/i.test(ge.message)) {
              throw gatewayError(
                'no_responders',
                `No stream is listening on "${request.subject}", so nothing acknowledged the message`
              )
            }
            throw ge
          }
        }
        // A refused publish is reported asynchronously, so listen for it until the server has caught up.
        const asyncErrors: Error[] = []
        const off = conn.onAsyncError((err) => asyncErrors.push(err))
        try {
          conn.nc.publish(request.subject, data, { headers: hdrs })
          await conn.nc.flush()
          await new Promise((resolve) => setTimeout(resolve, 20))
        } finally {
          off()
        }
        const denied = asyncErrors
          .map(toGatewayError)
          .find((e) => e.kind === 'permission' && e.subject === request.subject)
        if (denied) throw denied
        return {}
      },
      `${data.length} bytes`
    )
  }

  async request(connId: string, request: RequestRequest): Promise<RequestResult> {
    const invalid = validateSubject(request.subject, false)
    if (invalid) throw gatewayError('validation', invalid)
    const data = decodePayload(request.payload)
    const timeout = Math.min(Math.max(100, request.timeoutMs || 2000), 120_000)

    return this.mutate(
      connId,
      'request',
      request.subject,
      async (conn) => {
        const started = performance.now()
        try {
          const reply = await conn.nc.request(request.subject, data, {
            timeout,
            headers: listToHeaders(request.headers)
          })
          return {
            subject: reply.subject,
            headers: headersToList(reply.headers),
            payload: toBase64(reply.data),
            size: reply.data.length,
            rttMs: Math.round((performance.now() - started) * 100) / 100
          }
        } catch (err) {
          const ge = toGatewayError(err)
          if (ge.kind === 'no_responders')
            throw gatewayError(
              'no_responders',
              `No responders: nothing is listening on "${request.subject}"`,
              { subject: request.subject }
            )
          if (ge.kind === 'timeout') throw gatewayError('timeout', `No reply within ${timeout} ms`)
          throw ge
        }
      },
      `${data.length} bytes`
    )
  }

  // ───────────────────────── KV ─────────────────────────

  private kvDto(status: KvStatus): KvBucketDto {
    return {
      bucket: status.bucket,
      description: status.description || undefined,
      values: status.values,
      size: status.size,
      history: status.history,
      ttl: status.ttl,
      storage: String(status.storage),
      replicas: status.replicas,
      streamName: status.streamInfo.config.name,
      compression: status.compression
    }
  }

  private kvEntryDto(entry: KvEntry, withValue: boolean): KvEntryDto {
    const dto: KvEntryDto = {
      bucket: entry.bucket,
      key: entry.key,
      revision: entry.revision,
      created: entry.created.toISOString(),
      operation: entry.operation,
      size: entry.length ?? entry.value.length
    }
    if (withValue) {
      const { payload, truncated } = truncatedBase64(entry.value, 4 * MAX_MESSAGE_BYTES)
      dto.value = payload
      dto.truncated = truncated
    }
    return dto
  }

  async listKvBuckets(connId: string): Promise<KvBucketDto[]> {
    const kvm = this.conn(connId).kvm()
    const out: KvBucketDto[] = []
    for await (const status of kvm.list()) out.push(this.kvDto(status))
    out.sort((a, b) => a.bucket.localeCompare(b.bucket))
    return out
  }

  async createKvBucket(connId: string, input: KvBucketInput): Promise<KvBucketDto> {
    if (!/^[A-Za-z0-9_-]+$/.test(input.bucket ?? '')) {
      throw gatewayError('validation', 'Bucket names may only contain letters, digits, "_" and "-"')
    }
    return this.mutate(connId, 'kv.bucket.create', input.bucket, async (conn) => {
      const opts: Record<string, unknown> = {}
      if (input.description) opts.description = input.description
      if (input.history) opts.history = input.history
      if (input.ttlMs) opts.ttl = input.ttlMs
      if (input.maxBytes) opts.max_bytes = input.maxBytes
      if (input.storage) opts.storage = input.storage
      if (input.replicas) opts.replicas = input.replicas
      const kv = await conn.kvm().create(input.bucket, opts as never)
      return this.kvDto(await kv.status())
    })
  }

  async deleteKvBucket(connId: string, bucket: string): Promise<void> {
    await this.mutate(connId, 'kv.bucket.delete', bucket, async (conn) => {
      const kv = await conn.kvm().open(bucket)
      await kv.destroy()
    })
  }

  async kvKeys(connId: string, bucket: string, filter?: string): Promise<string[]> {
    const kv = await this.conn(connId).kvm().open(bucket)
    const keys: string[] = []
    for await (const key of await kv.keys(filter?.trim() || undefined)) keys.push(key)
    keys.sort()
    return keys
  }

  async kvGet(
    connId: string,
    bucket: string,
    key: string,
    revision?: number
  ): Promise<KvEntryDto | null> {
    const kv = await this.conn(connId).kvm().open(bucket)
    const entry = await kv.get(key, revision !== undefined ? { revision } : undefined)
    return entry ? this.kvEntryDto(entry, true) : null
  }

  async kvHistory(connId: string, bucket: string, key: string): Promise<KvEntryDto[]> {
    const kv = await this.conn(connId).kvm().open(bucket)
    const out: KvEntryDto[] = []
    for await (const entry of await kv.history({ key })) out.push(this.kvEntryDto(entry, false))
    out.sort((a, b) => b.revision - a.revision)
    return out
  }

  async kvPut(
    connId: string,
    bucket: string,
    key: string,
    value: string
  ): Promise<{ revision: number }> {
    const data = decodePayload(value)
    return this.mutate(
      connId,
      'kv.put',
      `${bucket} > ${key}`,
      async (conn) => {
        const kv = await conn.kvm().open(bucket)
        return { revision: await kv.put(key, data) }
      },
      `${data.length} bytes`
    )
  }

  async kvDelete(connId: string, bucket: string, key: string): Promise<void> {
    await this.mutate(connId, 'kv.delete', `${bucket} > ${key}`, async (conn) => {
      await (await conn.kvm().open(bucket)).delete(key)
    })
  }

  async kvPurge(connId: string, bucket: string, key: string): Promise<void> {
    await this.mutate(connId, 'kv.purge', `${bucket} > ${key}`, async (conn) => {
      await (await conn.kvm().open(bucket)).purge(key)
    })
  }

  private openKvWatch(args: GatewayStreams['kvWatch']['args'], emit: Emit<'kvWatch'>): () => void {
    let stopped = false
    let stop: () => void = () => {}
    const run = async (): Promise<void> => {
      try {
        const kv = await this.conn(args.connId).kvm().open(args.bucket)
        const iter = await kv.watch({ include: KvWatchInclude.UpdatesOnly })
        stop = () => iter.stop()
        if (stopped) return iter.stop()
        for await (const entry of iter)
          emit({ type: 'entry', entry: this.kvEntryDto(entry, false) })
      } catch (err) {
        if (!stopped) emit({ type: 'error', error: toGatewayError(err).toJSON() })
      }
    }
    void run()
    return () => {
      stopped = true
      stop()
    }
  }

  // ───────────────────────── object store ─────────────────────────

  private objInfoDto(info: ObjectInfo): ObjectInfoDto {
    return {
      bucket: info.bucket,
      name: info.name,
      description: info.description || undefined,
      size: info.size,
      chunks: info.chunks,
      digest: info.digest,
      mtime: info.mtime,
      revision: info.revision,
      headers: headersToList(info.headers),
      metadata: info.metadata
    }
  }

  private objBucketDto(status: ObjectStoreStatus, objects: number): ObjBucketDto {
    return {
      bucket: status.bucket,
      description: status.description || undefined,
      size: status.size,
      objects,
      storage: String(status.storage),
      replicas: status.replicas,
      sealed: status.sealed,
      ttl: status.ttl
    }
  }

  async listObjBuckets(connId: string): Promise<ObjBucketDto[]> {
    const objm = this.conn(connId).objm()
    const statuses: ObjectStoreStatus[] = []
    for await (const status of objm.list()) statuses.push(status)
    const out: ObjBucketDto[] = []
    await mapLimit(statuses, 4, async (status) => {
      let objects = 0
      try {
        const os = await objm.open(status.bucket)
        objects = (await os.list()).filter((o) => !o.deleted).length
      } catch {
        // Counting is best effort.
      }
      out.push(this.objBucketDto(status, objects))
    })
    out.sort((a, b) => a.bucket.localeCompare(b.bucket))
    return out
  }

  async createObjBucket(connId: string, input: ObjBucketInput): Promise<ObjBucketDto> {
    if (!/^[A-Za-z0-9_-]+$/.test(input.bucket ?? '')) {
      throw gatewayError('validation', 'Bucket names may only contain letters, digits, "_" and "-"')
    }
    return this.mutate(connId, 'object.bucket.create', input.bucket, async (conn) => {
      const opts: Record<string, unknown> = {}
      if (input.description) opts.description = input.description
      if (input.storage) opts.storage = input.storage
      if (input.replicas) opts.replicas = input.replicas
      if (input.maxBytes) opts.max_bytes = input.maxBytes
      const os = await conn.objm().create(input.bucket, opts as never)
      return this.objBucketDto(await os.status(), 0)
    })
  }

  async deleteObjBucket(connId: string, bucket: string): Promise<void> {
    await this.mutate(connId, 'object.bucket.delete', bucket, async (conn) => {
      const os = await conn.objm().open(bucket)
      await os.destroy()
    })
  }

  async objList(connId: string, bucket: string): Promise<ObjectInfoDto[]> {
    const os = await this.conn(connId).objm().open(bucket)
    return (await os.list())
      .filter((o) => !o.deleted)
      .map((o) => this.objInfoDto(o))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async objPreview(
    connId: string,
    bucket: string,
    name: string,
    maxBytes: number
  ): Promise<{ data: string; size: number }> {
    const os = await this.conn(connId).objm().open(bucket)
    const info = await os.info(name)
    if (!info || info.deleted) throw gatewayError('not_found', `Object "${name}" does not exist`)
    if (info.size > maxBytes)
      throw gatewayError('validation', 'This object is too large to preview. Download it instead.')
    const blob = await os.getBlob(name)
    if (!blob) throw gatewayError('not_found', `Object "${name}" does not exist`)
    return { data: toBase64(blob), size: info.size }
  }

  async objUploadStart(
    connId: string,
    bucket: string,
    name: string,
    description?: string
  ): Promise<{ uploadId: string }> {
    if (!name?.trim()) throw gatewayError('validation', 'Object name is required')
    const cfg = this.config(connId)
    if (cfg.readOnly) {
      this.audit.record({
        connId,
        connName: cfg.name,
        action: 'object.put',
        target: `${bucket} > ${name}`,
        result: 'blocked'
      })
      throw gatewayError(
        'read_only',
        `"${cfg.name}" is read-only. Turn off read-only mode on the connection to make changes.`
      )
    }
    const os = await this.conn(connId).objm().open(bucket)
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c
      }
    })
    const done = os.put(
      { name: name.trim(), description: description?.trim() || undefined },
      stream
    )
    // The promise is awaited in objUploadFinish; without this an aborted upload would be an unhandled rejection.
    done.catch(() => {})
    const uploadId = randomUUID()
    this.uploads.set(uploadId, { connId, bucket, name: name.trim(), controller, done, bytes: 0 })
    return { uploadId }
  }

  async objUploadChunk(uploadId: string, data: string): Promise<void> {
    const upload = this.uploads.get(uploadId)
    if (!upload) throw gatewayError('not_found', 'This upload is no longer active')
    const bytes = decodePayload(data)
    upload.bytes += bytes.length
    upload.controller.enqueue(bytes)
  }

  async objUploadFinish(uploadId: string): Promise<ObjectInfoDto> {
    const upload = this.uploads.get(uploadId)
    if (!upload) throw gatewayError('not_found', 'This upload is no longer active')
    this.uploads.delete(uploadId)
    const cfg = this.config(upload.connId)
    const entry = {
      connId: upload.connId,
      connName: cfg.name,
      action: 'object.put',
      target: `${upload.bucket} > ${upload.name}`
    }
    try {
      upload.controller.close()
      const info = await upload.done
      this.audit.record({ ...entry, result: 'ok', detail: `${upload.bytes} bytes` })
      return this.objInfoDto(info)
    } catch (err) {
      const ge = toGatewayError(err)
      this.audit.record({ ...entry, result: 'error', detail: ge.message })
      throw ge
    }
  }

  async objUploadAbort(uploadId: string): Promise<void> {
    const upload = this.uploads.get(uploadId)
    if (!upload) return
    this.uploads.delete(uploadId)
    try {
      upload.controller.error(new Error('Upload cancelled'))
    } catch {
      // Already closed.
    }
  }

  async objDelete(connId: string, bucket: string, name: string): Promise<void> {
    await this.mutate(connId, 'object.delete', `${bucket} > ${name}`, async (conn) => {
      const os = await conn.objm().open(bucket)
      await os.delete(name)
    })
  }

  private openObjDownload(
    args: GatewayStreams['objDownload']['args'],
    emit: Emit<'objDownload'>
  ): () => void {
    let cancelled = false
    const run = async (): Promise<void> => {
      try {
        const os = await this.conn(args.connId).objm().open(args.bucket)
        const result = await os.get(args.name)
        if (!result) throw gatewayError('not_found', `Object "${args.name}" does not exist`)
        const reader = result.data.getReader()
        let bytes = 0
        for (;;) {
          if (cancelled) {
            await reader.cancel().catch(() => {})
            return
          }
          const { done, value } = await reader.read()
          if (done) break
          for (let offset = 0; offset < value.length; offset += DOWNLOAD_CHUNK) {
            emit({ type: 'chunk', data: toBase64(value.subarray(offset, offset + DOWNLOAD_CHUNK)) })
          }
          bytes += value.length
        }
        const failure = await result.error
        if (failure) throw failure
        emit({ type: 'done', bytes })
      } catch (err) {
        if (!cancelled) emit({ type: 'error', error: toGatewayError(err).toJSON() })
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }

  // ───────────────────────── monitoring ─────────────────────────

  async metrics(connId: string, target: MetricsTarget, rangeMs: number): Promise<MetricsSeries> {
    this.conn(connId)
    const sampler = this.samplers.get(connId)
    if (!sampler) throw gatewayError('not_connected', 'Not connected to this server')
    sampler.watch(target.stream)
    return target.kind === 'stream'
      ? sampler.streamSeries(target.stream, rangeMs)
      : sampler.consumerSeries(target.stream, target.consumer, rangeMs)
  }

  async watchStream(connId: string, stream: string): Promise<void> {
    this.samplers.get(connId)?.watch(stream)
  }

  async healthSummary(connId: string): Promise<HealthSummary> {
    this.conn(connId)
    const sampler = this.samplers.get(connId)
    const thresholds = this.healthThresholds(connId)
    const consumers = sampler?.latestConsumers ?? []
    const items: HealthSummary['items'] = []
    for (const info of consumers) {
      const flags = this.withHealth(connId, info, thresholds).health ?? []
      if (flags.length) items.push({ stream: info.stream_name, consumer: info.name, flags })
    }
    return { total: consumers.length, unhealthy: items.length, items }
  }

  async listAlertRules(connId: string): Promise<AlertRule[]> {
    return this.alerts.rules(connId)
  }

  async saveAlertRule(rule: AlertRule): Promise<AlertRule> {
    this.config(rule.connId)
    return this.alerts.save(rule)
  }

  async deleteAlertRule(connId: string, ruleId: string): Promise<void> {
    this.alerts.delete(connId, ruleId)
  }

  async alertHistory(): Promise<AlertEvent[]> {
    return this.alerts.history
  }

  // ───────────────────────── audit, search, settings ─────────────────────────

  async auditList(query: AuditQuery): Promise<AuditEntry[]> {
    return this.audit.list(query ?? {})
  }

  async auditExportCsv(query: AuditQuery): Promise<string> {
    return this.audit.toCsv(query ?? {})
  }

  async searchIndex(connId: string): Promise<SearchIndex> {
    const conn = this.conn(connId)
    const jsm: JetStreamManager = await conn.jsm()
    const names: string[] = []
    try {
      for await (const name of jsm.streams.names()) names.push(name)
    } catch {
      return { streams: [], consumers: [], kv: [], obj: [] }
    }
    names.sort()
    const streams = names.filter((n) => !n.startsWith('KV_') && !n.startsWith('OBJ_'))
    let consumers = (this.samplers.get(connId)?.latestConsumers ?? []).map((c) => ({
      stream: c.stream_name,
      name: c.name
    }))
    if (consumers.length === 0 && streams.length <= 100) {
      const found: { stream: string; name: string }[] = []
      await mapLimit(streams, 6, async (stream) => {
        for await (const info of jsm.consumers.list(stream)) found.push({ stream, name: info.name })
      })
      consumers = found
    }
    consumers = consumers.filter((c) => !c.stream.startsWith('KV_') && !c.stream.startsWith('OBJ_'))
    consumers.sort((a, b) => a.stream.localeCompare(b.stream) || a.name.localeCompare(b.name))
    return {
      streams,
      consumers,
      kv: names.filter((n) => n.startsWith('KV_')).map((n) => n.slice(3)),
      obj: names.filter((n) => n.startsWith('OBJ_')).map((n) => n.slice(4))
    }
  }

  async getSetting(key: string): Promise<unknown> {
    return this.settings.get(key) ?? null
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    if (typeof key !== 'string' || !key) throw gatewayError('validation', 'Setting key is required')
    this.settings.set(key, value)
  }
}

function stripEmpty(secrets: ConnectSecrets | undefined): ConnectSecrets {
  const out: ConnectSecrets = {}
  if (!secrets) return out
  for (const [k, v] of Object.entries(secrets)) {
    if (typeof v === 'string' && v !== '') out[k as keyof ConnectSecrets] = v
  }
  return out
}

/** Runs `fn` over `items` with at most `limit` running at once. */
async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]
      await fn(item)
    }
  })
  await Promise.all(workers)
}
