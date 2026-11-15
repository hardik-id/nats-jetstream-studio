import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { AuthMethod, ConnectSecrets, TlsConfig } from '@shared/api'
import { normalizeServerUrl } from '@shared/connection'

/** A context from the NATS CLI (`nats context ...`), the NATS counterpart of a kubeconfig entry. */
export interface CliContext {
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
  secrets: ConnectSecrets
  warnings: string[]
}

/** Where the NATS CLI keeps its contexts: `$XDG_CONFIG_HOME/nats/context`, or `~/.config/nats/context`. */
export function cliContextDir(env: NodeJS.ProcessEnv = process.env): string {
  const base =
    env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim()
      ? env.XDG_CONFIG_HOME
      : join(homedir(), '.config')
  return join(base, 'nats', 'context')
}

function expandHome(path: string | undefined): string | undefined {
  if (!path) return undefined
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Reads every context file. A file that cannot be read is skipped and reported, it never stops the rest. */
export function loadCliContexts(dir: string): { contexts: CliContext[]; warnings: string[] } {
  const contexts: CliContext[] = []
  const warnings: string[] = []
  if (!existsSync(dir)) return { contexts, warnings }

  let files: string[]
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
  } catch (err) {
    return { contexts, warnings: [`Cannot read ${dir}: ${(err as Error).message}`] }
  }

  for (const file of files) {
    const name = basename(file, '.json')
    let raw: Record<string, unknown>
    try {
      const parsed = JSON.parse(readFileSync(join(dir, file), 'utf8'))
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        throw new Error('not a JSON object')
      raw = parsed
    } catch (err) {
      warnings.push(`Skipped context "${name}": ${(err as Error).message}`)
      continue
    }

    const ctxWarnings: string[] = []
    const urls = (text(raw.url) ?? 'nats://127.0.0.1:4222')
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean)
    const servers: string[] = []
    for (const url of urls) {
      const result = normalizeServerUrl(url)
      if ('error' in result) ctxWarnings.push(`${url}: ${result.error}`)
      else servers.push(result.url)
    }
    if (servers.length === 0) {
      warnings.push(`Skipped context "${name}": no usable server URL`)
      continue
    }

    const creds = expandHome(text(raw.creds))
    const nkey = expandHome(text(raw.nkey))
    const user = text(raw.user)
    const password = text(raw.password)
    const token = text(raw.token)

    let auth: AuthMethod = 'none'
    const secrets: ConnectSecrets = {}
    if (creds) auth = 'creds'
    else if (nkey) auth = 'nkey'
    else if (user) {
      auth = 'userpass'
      secrets.password = password ?? ''
    } else if (token) {
      auth = 'token'
      secrets.token = token
    }

    if (text(raw.nsc))
      ctxWarnings.push(
        'This context uses nsc, which the studio cannot resolve. Set a creds file on the context instead.'
      )
    if (text(raw.user_jwt))
      ctxWarnings.push(
        'This context uses user_jwt, which is not supported. Use a creds file instead.'
      )
    if (text(raw.socks_proxy)) ctxWarnings.push('The SOCKS proxy setting is ignored.')

    const tls: TlsConfig = {
      caFile: expandHome(text(raw.ca)),
      certFile: expandHome(text(raw.cert)),
      keyFile: expandHome(text(raw.key)),
      handshakeFirst: raw.tls_first === true ? true : undefined
    }
    const hasTls = Object.values(tls).some((v) => v !== undefined)

    contexts.push({
      id: `cli:${name}`,
      name,
      description: text(raw.description),
      servers,
      auth,
      user,
      credsFile: creds,
      nkeyFile: nkey,
      tls: hasTls ? tls : undefined,
      jsDomain: text(raw.jetstream_domain),
      apiPrefix: text(raw.jetstream_api_prefix),
      inboxPrefix: text(raw.inbox_prefix),
      secrets,
      warnings: ctxWarnings
    })
  }
  return { contexts, warnings }
}
