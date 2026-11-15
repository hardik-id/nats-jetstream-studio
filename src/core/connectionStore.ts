import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  isProduction,
  type AuthMethod,
  type CliImportResult,
  type ConnectionConfig,
  type ConnectionInput,
  type ConnectSecrets,
  type TlsConfig
} from '@shared/api'
import { CONNECTION_COLORS, normalizeServerUrl, validateConnectionInput } from '@shared/connection'
import { type CliContext, loadCliContexts } from './cliContexts'
import { gatewayError } from './errors'
import { JsonFile } from './jsonFile'
import type { SecretStore } from './secrets'

interface StoredConnection {
  id: string
  name: string
  description?: string
  servers: string[]
  auth: AuthMethod
  user?: string
  credsFile?: string
  nkeyFile?: string
  tls?: TlsConfig
  jsDomain?: string
  apiPrefix?: string
  inboxPrefix?: string
  color: string
  envLabel: string
  readOnly: boolean
  saveSecrets: boolean
  /** Encrypted values. */
  secrets: { password?: string; token?: string; nkeySeed?: string }
}

/** Studio-side settings for a NATS CLI context. The context file itself is never modified. */
interface CliOverride {
  color?: string
  envLabel?: string
  readOnly?: boolean
}

interface ConnectionsFile {
  version: 1
  connections: StoredConnection[]
  cliOverrides: Record<string, CliOverride>
}

const SECRET_KEYS = ['password', 'token', 'nkeySeed'] as const

function clean(value: string | undefined): string | undefined {
  const v = value?.trim()
  return v ? v : undefined
}

function cleanTls(tls: TlsConfig | undefined): TlsConfig | undefined {
  if (!tls) return undefined
  const out: TlsConfig = {
    caFile: clean(tls.caFile),
    certFile: clean(tls.certFile),
    keyFile: clean(tls.keyFile),
    handshakeFirst: tls.handshakeFirst ? true : undefined
  }
  return Object.values(out).some((v) => v !== undefined) ? out : undefined
}

/** Keeps saved connections and merges in the contexts found in the NATS CLI folder. */
export class ConnectionStore {
  private readonly file: JsonFile<ConnectionsFile>
  private cli: CliContext[] = []
  private cliWarnings: string[] = []

  constructor(
    dataDir: string,
    private readonly secrets: SecretStore,
    readonly cliDir: string
  ) {
    this.file = new JsonFile<ConnectionsFile>(join(dataDir, 'connections.json'), () => ({
      version: 1,
      connections: [],
      cliOverrides: {}
    }))
    this.refreshCli()
  }

  refreshCli(): CliImportResult {
    const { contexts, warnings } = loadCliContexts(this.cliDir)
    this.cli = contexts
    this.cliWarnings = warnings
    return { imported: contexts.length, warnings, directory: this.cliDir }
  }

  get lastCliWarnings(): string[] {
    return this.cliWarnings
  }

  list(): ConnectionConfig[] {
    const data = this.file.read()
    const studio = data.connections.map((c) => this.toConfig(c))
    const cli = this.cli.map((c, i) => this.cliToConfig(c, data.cliOverrides[c.id], i))
    return [...studio, ...cli]
  }

  get(id: string): ConnectionConfig | undefined {
    return this.list().find((c) => c.id === id)
  }

  /** Secrets for connecting. Only ever used inside the gateway process. */
  resolveSecrets(id: string): ConnectSecrets {
    const cli = this.cli.find((c) => c.id === id)
    if (cli) return { ...cli.secrets }
    const stored = this.file.read().connections.find((c) => c.id === id)
    if (!stored) return {}
    const out: ConnectSecrets = {}
    for (const key of SECRET_KEYS) {
      const value = stored.secrets[key]
      if (value === undefined) continue
      try {
        out[key] = this.secrets.decrypt(value)
      } catch {
        // The keychain entry is gone or belongs to another user: treat the secret as not stored.
      }
    }
    return out
  }

  save(input: ConnectionInput): ConnectionConfig {
    if (input.id?.startsWith('cli:')) return this.saveCliOverride(input)

    const data = this.file.read()
    const existing = input.id ? data.connections.find((c) => c.id === input.id) : undefined
    if (input.id && !existing) throw gatewayError('not_found', 'This connection no longer exists')

    const stored = existing?.secrets ?? {}
    const errors = validateConnectionInput(input, {
      stored: { password: !!stored.password, token: !!stored.token, nkeySeed: !!stored.nkeySeed }
    })
    const firstError = Object.values(errors)[0]
    if (firstError) throw gatewayError('validation', firstError)

    const servers = input.servers
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (normalizeServerUrl(s) as { url: string }).url)

    const saveSecrets = input.saveSecrets !== false
    const secrets: StoredConnection['secrets'] = {}
    if (saveSecrets) {
      const wanted: Record<(typeof SECRET_KEYS)[number], boolean> = {
        password: input.auth === 'userpass',
        token: input.auth === 'token',
        nkeySeed: input.auth === 'nkey'
      }
      for (const key of SECRET_KEYS) {
        if (!wanted[key]) continue
        const value = input[key]
        if (value !== undefined && value !== '') secrets[key] = this.secrets.encrypt(value)
        else if (stored[key] !== undefined) secrets[key] = stored[key]
      }
    }

    const envLabel = clean(input.envLabel) ?? existing?.envLabel ?? ''
    const next: StoredConnection = {
      id: existing?.id ?? randomUUID(),
      name: input.name.trim(),
      description: clean(input.description),
      servers,
      auth: input.auth,
      user: input.auth === 'userpass' ? clean(input.user) : undefined,
      credsFile: input.auth === 'creds' ? clean(input.credsFile) : undefined,
      nkeyFile: input.auth === 'nkey' ? clean(input.nkeyFile) : undefined,
      tls: cleanTls(input.tls),
      jsDomain: clean(input.jsDomain),
      apiPrefix: clean(input.apiPrefix),
      inboxPrefix: clean(input.inboxPrefix),
      color:
        clean(input.color) ??
        existing?.color ??
        CONNECTION_COLORS[data.connections.length % CONNECTION_COLORS.length],
      envLabel,
      // Production connections start read-only unless the user decides otherwise.
      readOnly: input.readOnly ?? existing?.readOnly ?? isProduction(envLabel),
      saveSecrets,
      secrets
    }

    if (existing) data.connections[data.connections.indexOf(existing)] = next
    else data.connections.push(next)
    this.file.write(data)
    return this.toConfig(next)
  }

  private saveCliOverride(input: ConnectionInput): ConnectionConfig {
    const id = input.id!
    if (!this.cli.some((c) => c.id === id))
      throw gatewayError('not_found', 'This NATS CLI context no longer exists')
    this.file.update((data) => {
      const current = data.cliOverrides[id] ?? {}
      data.cliOverrides[id] = {
        color: clean(input.color) ?? current.color,
        envLabel: input.envLabel !== undefined ? input.envLabel.trim() : current.envLabel,
        readOnly: input.readOnly ?? current.readOnly
      }
    })
    return this.get(id)!
  }

  duplicate(id: string): ConnectionConfig {
    const source = this.get(id)
    if (!source) throw gatewayError('not_found', 'This connection no longer exists')
    const data = this.file.read()
    const names = new Set(this.list().map((c) => c.name))
    let name = `${source.name} copy`
    for (let i = 2; names.has(name); i++) name = `${source.name} copy ${i}`

    const secrets: StoredConnection['secrets'] = {}
    if (source.saveSecrets) {
      const resolved = this.resolveSecrets(id)
      for (const key of SECRET_KEYS) {
        const value = resolved[key]
        if (value !== undefined && value !== '') secrets[key] = this.secrets.encrypt(value)
      }
    }
    const copy: StoredConnection = {
      id: randomUUID(),
      name,
      description: source.description,
      servers: [...source.servers],
      auth: source.auth,
      user: source.user,
      credsFile: source.credsFile,
      nkeyFile: source.nkeyFile,
      tls: source.tls,
      jsDomain: source.jsDomain,
      apiPrefix: source.apiPrefix,
      inboxPrefix: source.inboxPrefix,
      color: source.color,
      envLabel: source.envLabel,
      readOnly: source.readOnly,
      saveSecrets: source.saveSecrets,
      secrets
    }
    data.connections.push(copy)
    this.file.write(data)
    return this.toConfig(copy)
  }

  delete(id: string): void {
    if (typeof id !== 'string' || !id) throw gatewayError('validation', 'Connection id is required')
    if (id.startsWith('cli:')) {
      throw gatewayError(
        'validation',
        'This connection comes from the NATS CLI. Remove it with "nats context rm".'
      )
    }
    this.file.update((data) => {
      data.connections = data.connections.filter((c) => c.id !== id)
    })
  }

  private toConfig(c: StoredConnection): ConnectionConfig {
    return {
      id: c.id,
      name: c.name,
      source: 'studio',
      description: c.description,
      servers: c.servers,
      auth: c.auth,
      user: c.user,
      credsFile: c.credsFile,
      nkeyFile: c.nkeyFile,
      tls: c.tls,
      jsDomain: c.jsDomain,
      apiPrefix: c.apiPrefix,
      inboxPrefix: c.inboxPrefix,
      color: c.color,
      envLabel: c.envLabel,
      readOnly: c.readOnly,
      storedSecrets: {
        password: c.secrets.password !== undefined || undefined,
        token: c.secrets.token !== undefined || undefined,
        nkeySeed: c.secrets.nkeySeed !== undefined || undefined
      },
      saveSecrets: c.saveSecrets
    }
  }

  private cliToConfig(
    c: CliContext,
    override: CliOverride | undefined,
    index: number
  ): ConnectionConfig {
    const envLabel = override?.envLabel ?? ''
    return {
      id: c.id,
      name: c.name,
      source: 'cli',
      description: c.description,
      servers: c.servers,
      auth: c.auth,
      user: c.user,
      credsFile: c.credsFile,
      nkeyFile: c.nkeyFile,
      tls: c.tls,
      jsDomain: c.jsDomain,
      apiPrefix: c.apiPrefix,
      inboxPrefix: c.inboxPrefix,
      color: override?.color ?? CONNECTION_COLORS[(index + 3) % CONNECTION_COLORS.length],
      envLabel,
      readOnly: override?.readOnly ?? isProduction(envLabel),
      storedSecrets: {
        password: c.secrets.password !== undefined || undefined,
        token: c.secrets.token !== undefined || undefined
      },
      saveSecrets: true,
      warnings: c.warnings.length ? c.warnings : undefined
    }
  }
}
