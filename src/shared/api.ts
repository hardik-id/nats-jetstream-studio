/**
 * The contract between the UI and whatever holds the NATS connections.
 *
 * The renderer only ever talks to `NatsGateway`. In the desktop app the implementation lives in the
 * Electron main process (reached over IPC); in web mode it lives in the Node server (reached over
 * WebSocket); in UI tests it is an in-memory fake.
 *
 * Everything here must be plain JSON: binary payloads are base64 strings, dates are ISO strings.
 */

// ───────────────────────────── Connections ─────────────────────────────

export type AuthMethod = 'none' | 'userpass' | 'token' | 'nkey' | 'creds'

export interface TlsConfig {
  caFile?: string
  certFile?: string
  keyFile?: string
  handshakeFirst?: boolean
}

/** Connection settings that are safe to show in the UI. Never contains a secret. */
export interface ConnectionConfig {
  id: string
  name: string
  /** `cli` connections come from the NATS CLI context folder and are never written back to it. */
  source: 'studio' | 'cli'
  description?: string
  servers: string[]
  auth: AuthMethod
  user?: string
  credsFile?: string
  /** Path to a file holding an NKey seed (NATS CLI contexts reference seeds this way). */
  nkeyFile?: string
  tls?: TlsConfig
  jsDomain?: string
  apiPrefix?: string
  inboxPrefix?: string
  color: string
  /** Free text; `prod` and `production` are treated as production. */
  envLabel: string
  readOnly: boolean
  /** Which secrets are stored for this connection (values are never sent to the UI). */
  storedSecrets: { password?: boolean; token?: boolean; nkeySeed?: boolean }
  /** False when the user chose to be asked for the secret on every connect. */
  saveSecrets: boolean
  warnings?: string[]
}

/** What the connection form submits. A secret left `undefined` keeps the stored value. */
export interface ConnectionInput {
  id?: string
  name: string
  description?: string
  servers: string[]
  auth: AuthMethod
  user?: string
  password?: string
  token?: string
  nkeySeed?: string
  nkeyFile?: string
  credsFile?: string
  tls?: TlsConfig
  jsDomain?: string
  apiPrefix?: string
  inboxPrefix?: string
  color?: string
  envLabel?: string
  readOnly?: boolean
  saveSecrets?: boolean
}

export interface ConnectSecrets {
  password?: string
  token?: string
  nkeySeed?: string
}

export type ConnectionStatus =
  'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error'

export interface ConnectionState {
  id: string
  status: ConnectionStatus
  error?: string
  /** URL of the server the client is currently connected to. */
  server?: string
  serverName?: string
  version?: string
  reconnects: number
  /** Epoch ms of the last successful (re)connect. */
  since?: number
}

export interface ConnectionSummary extends ConnectionConfig {
  state: ConnectionState
}

export type TestFailureKind = 'auth' | 'tls' | 'timeout' | 'dns' | 'refused' | 'other'

export type TestConnectionResult =
  | {
      ok: true
      serverName: string
      version: string
      cluster?: string
      rttMs: number
      jetstream: boolean
      jetstreamNote?: string
    }
  | { ok: false; kind: TestFailureKind; message: string }

export interface CliImportResult {
  imported: number
  warnings: string[]
  directory: string
}

// ───────────────────────────── Overview ─────────────────────────────

export interface ServerInfoView {
  serverName: string
  serverId: string
  version: string
  cluster?: string
  connectedUrl: string
  host: string
  port: number
  maxPayload: number
  tls: boolean
  jetstream: boolean
  jsDomain?: string
  clientId: number
  clientIp?: string
  user?: string
  account?: string
  rttMs: number
}

export interface AccountLimitsDto {
  max_memory: number
  max_storage: number
  max_streams: number
  max_consumers: number
  [key: string]: unknown
}

export interface AccountStatsDto {
  memory: number
  storage: number
  streams: number
  consumers: number
  limits: AccountLimitsDto
  api: { total: number; errors: number; level?: number }
  domain?: string
  tiers?: Record<
    string,
    {
      memory: number
      storage: number
      streams: number
      consumers: number
      limits: AccountLimitsDto
    }
  >
  [key: string]: unknown
}

export type AccountInfoView =
  { enabled: true; stats: AccountStatsDto } | { enabled: false; reason: string }

export interface ClusterServerView {
  name: string
  id: string
  host?: string
  version: string
  cluster?: string
  connections: number
  subscriptions: number
  cpu: number
  mem: number
  cores: number
  slowConsumers: number
  start?: string
  routes: { name: string; rid: number; pending: number }[]
  gateways: { name: string; inbound: number }[]
  leafnodes: number
  jetstream?: {
    streams: number
    consumers: number
    messages: number
    bytes: number
    memoryUsed: number
    storageUsed: number
    apiTotal: number
    apiErrors: number
  }
}

export interface ClusterView {
  available: boolean
  /** Shown when `available` is false, e.g. the account has no system access. */
  reason?: string
  servers: ClusterServerView[]
  meta?: { name?: string; leader?: string; clusterSize?: number; replicas: PeerInfoDto[] }
}

// ───────────────────────────── Streams ─────────────────────────────

export interface StreamSourceDto {
  name: string
  filter_subject?: string
  external?: { api: string; deliver?: string }
  [key: string]: unknown
}

export interface StreamConfigDto {
  name: string
  description?: string
  subjects?: string[]
  retention?: 'limits' | 'interest' | 'workqueue'
  storage?: 'file' | 'memory'
  num_replicas?: number
  max_consumers?: number
  max_msgs?: number
  max_bytes?: number
  /** Nanoseconds. */
  max_age?: number
  max_msg_size?: number
  max_msgs_per_subject?: number
  discard?: 'old' | 'new'
  /** Nanoseconds. */
  duplicate_window?: number
  compression?: 'none' | 's2'
  allow_direct?: boolean
  allow_rollup_hdrs?: boolean
  deny_delete?: boolean
  deny_purge?: boolean
  sealed?: boolean
  mirror?: StreamSourceDto
  sources?: StreamSourceDto[]
  metadata?: Record<string, string>
  [key: string]: unknown
}

export interface StreamStateDto {
  messages: number
  bytes: number
  first_seq: number
  first_ts: string
  last_seq: number
  last_ts: string
  consumer_count: number
  num_deleted?: number
  num_subjects?: number
  subjects?: Record<string, number>
  [key: string]: unknown
}

export interface PeerInfoDto {
  name: string
  current: boolean
  offline?: boolean
  /** Nanoseconds since this peer was last active. */
  active: number
  lag?: number
}

export interface ClusterInfoDto {
  name?: string
  leader?: string
  replicas?: PeerInfoDto[]
  [key: string]: unknown
}

export interface StreamSourceInfoDto {
  name: string
  lag: number
  /** Nanoseconds since last activity, -1 when never. */
  active: number
  error?: { description?: string }
  [key: string]: unknown
}

export interface StreamInfoDto {
  config: StreamConfigDto
  state: StreamStateDto
  created: string
  cluster?: ClusterInfoDto
  mirror?: StreamSourceInfoDto
  sources?: StreamSourceInfoDto[]
  [key: string]: unknown
}

export type PurgeRequest = { filter?: string; seq?: number; keep?: number }

export interface SubjectCount {
  subject: string
  count: number
}

export interface SubjectsPage {
  subjects: SubjectCount[]
  total: number
  offset: number
}

export interface SubjectsQuery {
  filter?: string
  sort?: 'count' | 'subject'
  offset?: number
  limit?: number
}

// ───────────────────────────── Messages ─────────────────────────────

export type Header = [key: string, value: string]

export interface MessageDto {
  seq: number
  subject: string
  /** ISO timestamp the server stored the message. */
  time: string
  /** Payload size in bytes (the full size, even when `payload` is truncated). */
  size: number
  headers: Header[]
  /** Base64. May hold only the first bytes of the payload, see `truncated`. */
  payload: string
  truncated: boolean
}

export type MessageStart =
  | { kind: 'first' }
  | { kind: 'last' }
  | { kind: 'seq'; seq: number }
  | { kind: 'time'; time: string }

export interface HeaderFilter {
  key: string
  /** When omitted the filter only checks that the header exists. */
  value?: string
}

/** Filters that the gateway applies while scanning (the server only filters by subject). */
export interface ContentFilters {
  headers?: HeaderFilter[]
  payloadContains?: string
  payloadRegex?: string
  jsonPath?: string
}

export interface MessageQuery {
  /** `asc` walks towards newer messages, `desc` towards older ones. */
  direction: 'asc' | 'desc'
  start: MessageStart
  limit: number
  /** NATS subject filter, wildcards allowed. Applied by the server. */
  subject?: string
  /** Bytes of payload to include per message. Defaults to a short preview. */
  payloadBytes?: number
}

export interface MessagePage {
  /** In walk order: ascending sequence for `asc`, descending for `desc`. */
  messages: MessageDto[]
  /** True when the walk reached the end of the stream in the requested direction. */
  exhausted: boolean
  /** The sequence the walk actually started from, after clamping and time lookup. */
  startSeq: number
  firstSeq: number
  lastSeq: number
  notice?: string
}

export interface ScanRequest extends MessageQuery {
  filters: ContentFilters
  /** Stop after examining this many messages. */
  scanLimit: number
}

export type ScanEvent =
  | { type: 'matches'; messages: MessageDto[] }
  | { type: 'progress'; scanned: number; matched: number; seq: number }
  | {
      type: 'done'
      /** `page`: enough matches found. `end`: no more messages. `limit`: scan limit reached. */
      reason: 'page' | 'end' | 'limit' | 'cancelled' | 'error'
      scanned: number
      matched: number
      skippedNonJson: number
      /** Sequence to resume from in the same direction, or null at the end of the stream. */
      resumeSeq: number | null
      error?: GatewayErrorData
    }

// ───────────────────────────── Consumers ─────────────────────────────

export interface ConsumerConfigDto {
  name?: string
  durable_name?: string
  description?: string
  deliver_policy?:
    'all' | 'last' | 'new' | 'by_start_sequence' | 'by_start_time' | 'last_per_subject'
  opt_start_seq?: number
  opt_start_time?: string
  ack_policy?: 'none' | 'all' | 'explicit'
  /** Nanoseconds. */
  ack_wait?: number
  max_deliver?: number
  /** Nanoseconds. */
  backoff?: number[]
  filter_subject?: string
  filter_subjects?: string[]
  replay_policy?: 'instant' | 'original'
  max_ack_pending?: number
  max_waiting?: number
  /** Nanoseconds. */
  inactive_threshold?: number
  deliver_subject?: string
  deliver_group?: string
  headers_only?: boolean
  num_replicas?: number
  mem_storage?: boolean
  pause_until?: string
  metadata?: Record<string, string>
  [key: string]: unknown
}

export interface SequenceInfoDto {
  consumer_seq: number
  stream_seq: number
  last_active?: string
}

export type HealthFlag =
  'lag_growing' | 'redeliveries' | 'stalled' | 'ack_pending_max' | 'no_leader'

export interface ConsumerInfoDto {
  stream_name: string
  name: string
  created: string
  config: ConsumerConfigDto
  delivered: SequenceInfoDto
  ack_floor: SequenceInfoDto
  num_ack_pending: number
  num_redelivered: number
  num_waiting: number
  num_pending: number
  cluster?: ClusterInfoDto
  push_bound?: boolean
  paused?: boolean
  /** Nanoseconds. */
  pause_remaining?: number
  /** Added by the gateway from sampled history (PBI-054). */
  health?: HealthFlag[]
  [key: string]: unknown
}

export interface HealthThresholds {
  /** Number of consecutive samples in which pending must grow. */
  lagSamples: number
  redelivered: number
  /** Seconds without activity while messages are pending. */
  stalledSeconds: number
}

export const DEFAULT_HEALTH_THRESHOLDS: HealthThresholds = {
  lagSamples: 6,
  redelivered: 100,
  stalledSeconds: 300
}

export interface HealthSummary {
  total: number
  unhealthy: number
  items: { stream: string; consumer: string; flags: HealthFlag[] }[]
}

// ───────────────────────────── Live tail, publish ─────────────────────────────

export interface TailMessage {
  /** Monotonic per tail, used as a list key. */
  id: number
  subject: string
  /** Epoch ms when the gateway received the message. */
  received: number
  size: number
  headers: Header[]
  reply?: string
  payload: string
  truncated: boolean
}

export type TailEvent =
  | { type: 'messages'; messages: TailMessage[]; dropped: number }
  | { type: 'gap' }
  | { type: 'error'; error: GatewayErrorData }

export interface TailRequest {
  connId: string
  subject: string
  payloadBytes?: number
}

export interface PublishRequest {
  subject: string
  headers?: Header[]
  /** Base64. */
  payload: string
  /** `jetstream` waits for the stream's acknowledgement. */
  mode: 'core' | 'jetstream'
}

export interface PublishResult {
  ack?: { stream: string; seq: number; duplicate: boolean }
}

export interface RequestRequest {
  subject: string
  headers?: Header[]
  payload: string
  timeoutMs: number
}

export interface RequestResult {
  subject: string
  headers: Header[]
  payload: string
  size: number
  rttMs: number
}

// ───────────────────────────── KV ─────────────────────────────

export interface KvBucketDto {
  bucket: string
  description?: string
  values: number
  size: number
  history: number
  /** Milliseconds, 0 for no expiry. */
  ttl: number
  storage: string
  replicas: number
  streamName: string
  compression?: boolean
}

export interface KvBucketInput {
  bucket: string
  description?: string
  history?: number
  ttlMs?: number
  maxBytes?: number
  storage?: 'file' | 'memory'
  replicas?: number
}

export interface KvEntryDto {
  bucket: string
  key: string
  revision: number
  created: string
  operation: 'PUT' | 'DEL' | 'PURGE'
  size: number
  /** Base64, absent in watch events and history listings unless requested. */
  value?: string
  truncated?: boolean
}

export type KvWatchEvent =
  { type: 'entry'; entry: KvEntryDto } | { type: 'error'; error: GatewayErrorData }

// ───────────────────────────── Object store ─────────────────────────────

export interface ObjBucketDto {
  bucket: string
  description?: string
  size: number
  objects: number
  storage: string
  replicas: number
  sealed: boolean
  /** Nanoseconds, 0 for no expiry. */
  ttl: number
}

export interface ObjBucketInput {
  bucket: string
  description?: string
  storage?: 'file' | 'memory'
  replicas?: number
  maxBytes?: number
}

export interface ObjectInfoDto {
  bucket: string
  name: string
  description?: string
  size: number
  chunks: number
  digest: string
  mtime: string
  revision: number
  headers: Header[]
  metadata?: Record<string, string>
}

export type ObjDownloadEvent =
  | { type: 'chunk'; data: string }
  | { type: 'done'; bytes: number }
  | { type: 'error'; error: GatewayErrorData }

// ───────────────────────────── Monitoring ─────────────────────────────

export type MetricsTarget =
  { kind: 'stream'; stream: string } | { kind: 'consumer'; stream: string; consumer: string }

export interface MetricsSeries {
  /** Epoch ms of each sample. */
  t: number[]
  /** Named series, each the same length as `t`. */
  series: Record<string, number[]>
  intervalMs: number
}

export type AlertMetric = 'consumer_pending' | 'consumer_redelivered' | 'stream_bytes_pct'

export interface AlertRule {
  id: string
  connId: string
  name: string
  metric: AlertMetric
  /** Stream name, or `*` for every stream. */
  stream: string
  /** Consumer name, or `*` for every consumer. Ignored for stream metrics. */
  consumer: string
  threshold: number
  /** The condition must hold for this many seconds before the rule fires. */
  durationSeconds: number
  enabled: boolean
  /** Epoch ms; the rule is silent until then. */
  snoozedUntil?: number
  notify: boolean
}

export interface AlertEvent {
  id: string
  ruleId: string
  ruleName: string
  connId: string
  metric: AlertMetric
  target: string
  value: number
  threshold: number
  time: number
  notify: boolean
}

// ───────────────────────────── Audit, search, app ─────────────────────────────

export interface AuditEntry {
  time: string
  connId: string
  connName: string
  action: string
  target: string
  result: 'ok' | 'error' | 'blocked'
  detail?: string
  /** Who did it. Only set in web mode, where several people share one gateway. */
  user?: string
}

export interface AuditQuery {
  connId?: string
  text?: string
  result?: AuditEntry['result']
  limit?: number
}

export interface SearchIndex {
  streams: string[]
  consumers: { stream: string; name: string }[]
  kv: string[]
  obj: string[]
}

export interface AppInfo {
  version: string
  natsClientVersion: string
  mode: 'desktop' | 'web'
  /** False when no OS keychain is available to encrypt saved secrets. */
  secretStorage: boolean
  platform: string
  cliContextDir: string
  user?: { name: string; email?: string }
  /** True when an administrator manages the connections and users may not change them (web mode). */
  connectionsLocked: boolean
  /** True when signing out is possible (web mode with authentication). */
  canSignOut: boolean
}

/** Events that are not tied to one request. */
export type GlobalEvent =
  | { type: 'connection'; state: ConnectionState }
  | { type: 'connections_changed' }
  | { type: 'alert'; alert: AlertEvent }
  | { type: 'notice'; connId: string; level: 'error' | 'warning'; message: string }

// ───────────────────────────── Errors ─────────────────────────────

export type GatewayErrorKind =
  | 'read_only'
  | 'not_connected'
  | 'secret_required'
  | 'permission'
  | 'jetstream'
  | 'timeout'
  | 'no_responders'
  | 'not_found'
  | 'validation'
  | 'unsupported'
  | 'nats'
  | 'internal'

export interface GatewayErrorData {
  kind: GatewayErrorKind
  message: string
  /** JetStream API error code (`err_code`), e.g. 10059 for stream not found. */
  natsCode?: number
  /** For permission errors: the subject the server refused. */
  subject?: string
}

export class GatewayError extends Error {
  readonly kind: GatewayErrorKind
  readonly natsCode?: number
  readonly subject?: string

  constructor(data: GatewayErrorData) {
    super(data.message)
    this.name = 'GatewayError'
    this.kind = data.kind
    this.natsCode = data.natsCode
    this.subject = data.subject
  }

  toJSON(): GatewayErrorData {
    return {
      kind: this.kind,
      message: this.message,
      natsCode: this.natsCode,
      subject: this.subject
    }
  }
}

// ───────────────────────────── The gateway ─────────────────────────────

/** Request/response operations. Every argument and result is JSON. */
export interface GatewayMethods {
  appInfo(): Promise<AppInfo>

  // Connections
  listConnections(): Promise<ConnectionSummary[]>
  saveConnection(input: ConnectionInput): Promise<ConnectionSummary>
  duplicateConnection(id: string): Promise<ConnectionSummary>
  deleteConnection(id: string): Promise<void>
  testConnection(input: ConnectionInput): Promise<TestConnectionResult>
  refreshCliContexts(): Promise<CliImportResult>
  connect(id: string, secrets?: ConnectSecrets): Promise<ConnectionState>
  disconnect(id: string): Promise<void>

  // Overview
  serverInfo(connId: string): Promise<ServerInfoView>
  accountInfo(connId: string): Promise<AccountInfoView>
  clusterInfo(connId: string): Promise<ClusterView>

  // Streams
  listStreams(connId: string): Promise<StreamInfoDto[]>
  streamInfo(connId: string, stream: string): Promise<StreamInfoDto>
  createStream(connId: string, config: StreamConfigDto): Promise<StreamInfoDto>
  updateStream(connId: string, stream: string, config: StreamConfigDto): Promise<StreamInfoDto>
  deleteStream(connId: string, stream: string): Promise<void>
  purgeStream(connId: string, stream: string, request: PurgeRequest): Promise<{ purged: number }>
  streamSubjects(connId: string, stream: string, query: SubjectsQuery): Promise<SubjectsPage>

  // Messages
  getMessages(connId: string, stream: string, query: MessageQuery): Promise<MessagePage>
  getMessage(
    connId: string,
    stream: string,
    seq: number,
    payloadBytes?: number
  ): Promise<MessageDto>
  deleteMessage(connId: string, stream: string, seq: number, erase: boolean): Promise<void>

  // Consumers
  listConsumers(connId: string, stream: string): Promise<ConsumerInfoDto[]>
  listAllConsumers(connId: string): Promise<ConsumerInfoDto[]>
  consumerInfo(connId: string, stream: string, consumer: string): Promise<ConsumerInfoDto>
  createConsumer(
    connId: string,
    stream: string,
    config: ConsumerConfigDto
  ): Promise<ConsumerInfoDto>
  updateConsumer(
    connId: string,
    stream: string,
    consumer: string,
    config: ConsumerConfigDto
  ): Promise<ConsumerInfoDto>
  deleteConsumer(connId: string, stream: string, consumer: string): Promise<void>
  pauseConsumer(
    connId: string,
    stream: string,
    consumer: string,
    until: string
  ): Promise<ConsumerInfoDto>
  resumeConsumer(connId: string, stream: string, consumer: string): Promise<ConsumerInfoDto>

  // Publish
  publish(connId: string, request: PublishRequest): Promise<PublishResult>
  request(connId: string, request: RequestRequest): Promise<RequestResult>

  // KV
  listKvBuckets(connId: string): Promise<KvBucketDto[]>
  createKvBucket(connId: string, input: KvBucketInput): Promise<KvBucketDto>
  deleteKvBucket(connId: string, bucket: string): Promise<void>
  kvKeys(connId: string, bucket: string, filter?: string): Promise<string[]>
  kvGet(connId: string, bucket: string, key: string, revision?: number): Promise<KvEntryDto | null>
  kvHistory(connId: string, bucket: string, key: string): Promise<KvEntryDto[]>
  kvPut(connId: string, bucket: string, key: string, value: string): Promise<{ revision: number }>
  kvDelete(connId: string, bucket: string, key: string): Promise<void>
  kvPurge(connId: string, bucket: string, key: string): Promise<void>

  // Object store
  listObjBuckets(connId: string): Promise<ObjBucketDto[]>
  createObjBucket(connId: string, input: ObjBucketInput): Promise<ObjBucketDto>
  deleteObjBucket(connId: string, bucket: string): Promise<void>
  objList(connId: string, bucket: string): Promise<ObjectInfoDto[]>
  objPreview(
    connId: string,
    bucket: string,
    name: string,
    maxBytes: number
  ): Promise<{ data: string; size: number }>
  objUploadStart(
    connId: string,
    bucket: string,
    name: string,
    description?: string
  ): Promise<{ uploadId: string }>
  objUploadChunk(uploadId: string, data: string): Promise<void>
  objUploadFinish(uploadId: string): Promise<ObjectInfoDto>
  objUploadAbort(uploadId: string): Promise<void>
  objDelete(connId: string, bucket: string, name: string): Promise<void>

  // Monitoring
  metrics(connId: string, target: MetricsTarget, rangeMs: number): Promise<MetricsSeries>
  watchStream(connId: string, stream: string): Promise<void>
  healthSummary(connId: string): Promise<HealthSummary>
  listAlertRules(connId: string): Promise<AlertRule[]>
  saveAlertRule(rule: AlertRule): Promise<AlertRule>
  deleteAlertRule(connId: string, ruleId: string): Promise<void>
  alertHistory(): Promise<AlertEvent[]>

  // Audit, search, settings
  auditList(query: AuditQuery): Promise<AuditEntry[]>
  auditExportCsv(query: AuditQuery): Promise<string>
  searchIndex(connId: string): Promise<SearchIndex>
  getSetting(key: string): Promise<unknown>
  setSetting(key: string, value: unknown): Promise<void>
}

/** Long-running operations that push events until closed. */
export interface GatewayStreams {
  events: { args: Record<string, never>; event: GlobalEvent }
  tail: { args: TailRequest; event: TailEvent }
  scan: { args: { connId: string; stream: string; request: ScanRequest }; event: ScanEvent }
  kvWatch: { args: { connId: string; bucket: string }; event: KvWatchEvent }
  objDownload: { args: { connId: string; bucket: string; name: string }; event: ObjDownloadEvent }
}

export type StreamChannel = keyof GatewayStreams

export interface NatsGateway extends GatewayMethods {
  /** Opens a streaming operation. Call the returned function to stop it. */
  open<K extends StreamChannel>(
    channel: K,
    args: GatewayStreams[K]['args'],
    onEvent: (event: GatewayStreams[K]['event']) => void
  ): () => void
}

export type GatewayMethodName = keyof GatewayMethods

/** Methods that change state on a NATS server. Blocked on read-only connections and audited. */
export const MUTATING_METHODS = [
  'createStream',
  'updateStream',
  'deleteStream',
  'purgeStream',
  'deleteMessage',
  'createConsumer',
  'updateConsumer',
  'deleteConsumer',
  'pauseConsumer',
  'resumeConsumer',
  'publish',
  'request',
  'createKvBucket',
  'deleteKvBucket',
  'kvPut',
  'kvDelete',
  'kvPurge',
  'createObjBucket',
  'deleteObjBucket',
  'objUploadStart',
  'objDelete'
] as const satisfies readonly GatewayMethodName[]

export const STREAM_CHANNELS: readonly StreamChannel[] = [
  'events',
  'tail',
  'scan',
  'kvWatch',
  'objDownload'
]

export function isProduction(envLabel: string | undefined): boolean {
  const label = (envLabel ?? '').trim().toLowerCase()
  return label === 'prod' || label === 'production'
}

/** Every request/response method, as a runtime list. Transports refuse anything not in it. */
export const GATEWAY_METHODS = [
  'appInfo',
  'listConnections',
  'saveConnection',
  'duplicateConnection',
  'deleteConnection',
  'testConnection',
  'refreshCliContexts',
  'connect',
  'disconnect',
  'serverInfo',
  'accountInfo',
  'clusterInfo',
  'listStreams',
  'streamInfo',
  'createStream',
  'updateStream',
  'deleteStream',
  'purgeStream',
  'streamSubjects',
  'getMessages',
  'getMessage',
  'deleteMessage',
  'listConsumers',
  'listAllConsumers',
  'consumerInfo',
  'createConsumer',
  'updateConsumer',
  'deleteConsumer',
  'pauseConsumer',
  'resumeConsumer',
  'publish',
  'request',
  'listKvBuckets',
  'createKvBucket',
  'deleteKvBucket',
  'kvKeys',
  'kvGet',
  'kvHistory',
  'kvPut',
  'kvDelete',
  'kvPurge',
  'listObjBuckets',
  'createObjBucket',
  'deleteObjBucket',
  'objList',
  'objPreview',
  'objUploadStart',
  'objUploadChunk',
  'objUploadFinish',
  'objUploadAbort',
  'objDelete',
  'metrics',
  'watchStream',
  'healthSummary',
  'listAlertRules',
  'saveAlertRule',
  'deleteAlertRule',
  'alertHistory',
  'auditList',
  'auditExportCsv',
  'searchIndex',
  'getSetting',
  'setSetting'
] as const satisfies readonly GatewayMethodName[]

// Compile-time check that the list above names every method of the interface.
type MissingMethods = Exclude<GatewayMethodName, (typeof GATEWAY_METHODS)[number]>
export const ALL_METHODS_LISTED: MissingMethods extends never ? true : never = true
