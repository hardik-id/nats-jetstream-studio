import {
  GatewayError,
  GATEWAY_METHODS,
  MUTATING_METHODS,
  type AppInfo,
  type ConnectionInput,
  type ConnectionState,
  type ConnectionSummary,
  type ConsumerInfoDto,
  type GatewayStreams,
  type GlobalEvent,
  type MessageDto,
  type MessagePage,
  type MessageQuery,
  type NatsGateway,
  type StreamChannel,
  type StreamConfigDto,
  type StreamInfoDto
} from '@shared/api'
import { validateConnectionInput } from '@shared/connection'
import { textToBase64, utf8Encode } from '@shared/encoding'
import { compileFilters } from '@shared/filters'
import { subjectMatches } from '@shared/subject'

export interface FakeStream {
  config: StreamConfigDto
  messages: {
    seq: number
    subject: string
    payload: string
    time: string
    headers?: [string, string][]
  }[]
  consumers: ConsumerInfoDto[]
}

export interface FakeGateway extends NatsGateway {
  /** Every call made, in order, for assertions. */
  calls: { method: string; args: unknown[] }[]
  connections: ConnectionSummary[]
  streams: Map<string, FakeStream>
  settings: Map<string, unknown>
  /** Pushes a global event to the UI, as the real gateway does for status changes and alerts. */
  emit(event: GlobalEvent): void
}

const MUTATING = new Set<string>(MUTATING_METHODS)

function streamInfo(s: FakeStream): StreamInfoDto {
  const first = s.messages[0]
  const last = s.messages[s.messages.length - 1]
  return {
    config: s.config,
    created: '2026-01-01T00:00:00Z',
    state: {
      messages: s.messages.length,
      bytes: s.messages.reduce((n, m) => n + m.payload.length, 0),
      first_seq: first?.seq ?? 0,
      first_ts: first?.time ?? '0001-01-01T00:00:00Z',
      last_seq: last?.seq ?? 0,
      last_ts: last?.time ?? '0001-01-01T00:00:00Z',
      consumer_count: s.consumers.length
    }
  }
}

/**
 * An in-memory NatsGateway for UI tests (PBI-002). It behaves like the real one where the UI
 * depends on it: connection state events, read-only enforcement and structured errors.
 * Methods a test does not need answer with an "internal" error naming the method.
 */
export function createFakeGateway(
  seed: { connections?: Partial<ConnectionSummary>[]; appInfo?: Partial<AppInfo> } = {}
): FakeGateway {
  const listeners = new Set<(event: GlobalEvent) => void>()
  const calls: FakeGateway['calls'] = []
  const streams = new Map<string, FakeStream>()
  const settings = new Map<string, unknown>()
  let nextId = 1

  const connections: ConnectionSummary[] = (seed.connections ?? []).map((c, i) => ({
    id: c.id ?? `c${i + 1}`,
    name: c.name ?? `Connection ${i + 1}`,
    source: 'studio',
    servers: ['nats://127.0.0.1:4222'],
    auth: 'none',
    color: '#2563eb',
    envLabel: '',
    readOnly: false,
    storedSecrets: {},
    saveSecrets: true,
    ...c,
    state: { id: c.id ?? `c${i + 1}`, status: 'disconnected', reconnects: 0, ...c.state }
  }))

  const emit = (event: GlobalEvent): void => {
    for (const listener of listeners) listener(event)
  }
  const find = (id: string): ConnectionSummary => {
    const conn = connections.find((c) => c.id === id)
    if (!conn)
      throw new GatewayError({ kind: 'not_found', message: 'This connection no longer exists' })
    return conn
  }
  const setState = (id: string, patch: Partial<ConnectionState>): ConnectionState => {
    const conn = find(id)
    conn.state = { ...conn.state, ...patch }
    emit({ type: 'connection', state: conn.state })
    return conn.state
  }
  const stream = (name: string): FakeStream => {
    const s = streams.get(name)
    if (!s)
      throw new GatewayError({
        kind: 'not_found',
        message: 'stream not found (JetStream error 10059)',
        natsCode: 10059
      })
    return s
  }

  const methods: Partial<Record<(typeof GATEWAY_METHODS)[number], (...args: never[]) => unknown>> =
    {
      appInfo: (): AppInfo => ({
        version: '0.0.0-fake',
        natsClientVersion: 'fake',
        mode: 'desktop',
        secretStorage: true,
        platform: 'test',
        cliContextDir: '/fake/nats/context',
        connectionsLocked: false,
        canSignOut: false,
        ...seed.appInfo
      }),
      listConnections: () => connections.map((c) => ({ ...c })),
      saveConnection: (input: ConnectionInput) => {
        const existing = input.id ? connections.find((c) => c.id === input.id) : undefined
        const errors = validateConnectionInput(input, { stored: existing?.storedSecrets })
        const first = Object.values(errors)[0]
        if (first) throw new GatewayError({ kind: 'validation', message: first })
        const id = existing?.id ?? `c${connections.length + nextId++}`
        const saved: ConnectionSummary = {
          id,
          name: input.name.trim(),
          source: 'studio',
          servers: input.servers,
          auth: input.auth,
          user: input.user,
          color: input.color ?? '#2563eb',
          envLabel: input.envLabel ?? '',
          readOnly: input.readOnly ?? false,
          storedSecrets: { password: input.password ? true : existing?.storedSecrets.password },
          saveSecrets: input.saveSecrets !== false,
          state: existing?.state ?? { id, status: 'disconnected', reconnects: 0 }
        }
        if (existing) connections[connections.indexOf(existing)] = saved
        else connections.push(saved)
        emit({ type: 'connections_changed' })
        return saved
      },
      deleteConnection: (id: string) => {
        connections.splice(connections.indexOf(find(id)), 1)
        emit({ type: 'connections_changed' })
      },
      testConnection: () => ({
        ok: true,
        serverName: 'fake-server',
        version: '2.11.0',
        rttMs: 1,
        jetstream: true
      }),
      refreshCliContexts: () => ({ imported: 0, warnings: [], directory: '/fake/nats/context' }),
      connect: (id: string) =>
        setState(id, {
          status: 'connected',
          server: '127.0.0.1:4222',
          serverName: 'fake-server',
          version: '2.11.0',
          error: undefined
        }),
      disconnect: (id: string) => {
        setState(id, { status: 'disconnected' })
      },
      listStreams: () => [...streams.values()].map(streamInfo),
      streamInfo: (_connId: string, name: string) => streamInfo(stream(name)),
      createStream: (_connId: string, config: StreamConfigDto) => {
        if (streams.has(config.name))
          throw new GatewayError({
            kind: 'jetstream',
            message: 'stream name already in use (JetStream error 10058)',
            natsCode: 10058
          })
        streams.set(config.name, { config, messages: [], consumers: [] })
        return streamInfo(stream(config.name))
      },
      deleteStream: (_connId: string, name: string) => {
        stream(name)
        streams.delete(name)
      },
      listConsumers: (_connId: string, name: string) => stream(name).consumers,
      listAllConsumers: () => [...streams.values()].flatMap((s) => s.consumers),
      getMessages: (_connId: string, name: string, query: MessageQuery): MessagePage => {
        const s = stream(name)
        const matching = s.messages.filter(
          (m) => !query.subject || subjectMatches(query.subject, m.subject)
        )
        const first = s.messages[0]?.seq ?? 0
        const last = s.messages[s.messages.length - 1]?.seq ?? 0
        const from =
          query.start.kind === 'first'
            ? first
            : query.start.kind === 'last'
              ? last
              : query.start.kind === 'seq'
                ? query.start.seq
                : first
        const ordered =
          query.direction === 'asc'
            ? matching.filter((m) => m.seq >= from)
            : matching.filter((m) => m.seq <= from).reverse()
        const page = ordered.slice(0, query.limit)
        const messages: MessageDto[] = page.map((m) => ({
          seq: m.seq,
          subject: m.subject,
          time: m.time,
          size: m.payload.length,
          headers: m.headers ?? [],
          payload: textToBase64(m.payload),
          truncated: false
        }))
        return {
          messages,
          exhausted: ordered.length <= query.limit,
          startSeq: from,
          firstSeq: first,
          lastSeq: last
        }
      },
      searchIndex: () => ({ streams: [...streams.keys()], consumers: [], kv: [], obj: [] }),
      healthSummary: () => ({ total: 0, unhealthy: 0, items: [] }),
      getSetting: (key: string) => settings.get(key) ?? null,
      setSetting: (key: string, value: unknown) => {
        if (value === null || value === undefined) settings.delete(key)
        else settings.set(key, value)
      }
    }

  const gateway: Record<string, unknown> = {
    calls,
    connections,
    streams,
    settings,
    emit,
    open<K extends StreamChannel>(
      channel: K,
      _args: GatewayStreams[K]['args'],
      onEvent: (event: GatewayStreams[K]['event']) => void
    ): () => void {
      calls.push({ method: `open:${channel}`, args: [_args] })
      if (channel === 'scan') {
        // Runs the real filter over the fake stream, so a UI test sees what a scan would show.
        let open = true
        const { stream: name, request } = _args as GatewayStreams['scan']['args']
        const emitScan = onEvent as (event: GatewayStreams['scan']['event']) => void
        void Promise.resolve().then(() => {
          if (!open) return
          const test = compileFilters(request.filters)
          const all = [...stream(name).messages]
          const from =
            request.start.kind === 'seq'
              ? request.start.seq
              : request.direction === 'asc'
                ? 0
                : Infinity
          const ordered = (
            request.direction === 'asc'
              ? all.filter((m) => m.seq >= from)
              : all.filter((m) => m.seq <= from).reverse()
          ).filter((m) => !request.subject || subjectMatches(request.subject, m.subject))
          const messages: MessageDto[] = []
          let scanned = 0
          for (const m of ordered) {
            scanned++
            if (test(m.headers ?? [], utf8Encode(m.payload)).match)
              messages.push({
                seq: m.seq,
                subject: m.subject,
                time: m.time,
                size: m.payload.length,
                headers: m.headers ?? [],
                payload: textToBase64(m.payload),
                truncated: false
              })
            if (messages.length >= request.limit) break
          }
          if (messages.length) emitScan({ type: 'matches', messages })
          emitScan({
            type: 'done',
            reason: scanned < ordered.length ? 'page' : 'end',
            scanned,
            matched: messages.length,
            skippedNonJson: 0,
            resumeSeq: null
          })
        })
        return () => {
          open = false
        }
      }
      if (channel !== 'events') return () => {}
      const listener = onEvent as (event: GlobalEvent) => void
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }

  for (const method of GATEWAY_METHODS) {
    gateway[method] = async (...args: unknown[]) => {
      calls.push({ method, args })
      // Like the real gateway: read-only is enforced here, whatever the UI allowed.
      if (
        MUTATING.has(method) &&
        typeof args[0] === 'string' &&
        connections.find((c) => c.id === args[0])?.readOnly
      ) {
        throw new GatewayError({ kind: 'read_only', message: 'This connection is read-only.' })
      }
      const impl = methods[method] as ((...a: unknown[]) => unknown) | undefined
      if (!impl)
        throw new GatewayError({
          kind: 'internal',
          message: `The fake gateway does not implement "${method}"`
        })
      return impl(...args)
    }
  }
  return gateway as unknown as FakeGateway
}
