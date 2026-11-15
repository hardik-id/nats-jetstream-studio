import type { AuthMethod, ConnectionInput } from './api'

export const CONNECTION_COLORS = [
  '#2563eb',
  '#059669',
  '#d97706',
  '#dc2626',
  '#7c3aed',
  '#0891b2',
  '#db2777',
  '#4b5563'
]

/**
 * How long a connection test may take, in milliseconds: the value used when nothing is stored and
 * the range that is accepted. The form and the service both read these, so they cannot disagree.
 */
export const TEST_TIMEOUT_DEFAULT_MS = 5000
export const TEST_TIMEOUT_MIN_MS = 1000
export const TEST_TIMEOUT_MAX_MS = 60_000

/**
 * The test timeout to use for a stored value. Anything that is not a number gives the default and
 * a number outside the range is moved to its nearest end, so a damaged setting can neither hang a
 * test nor fail it at once.
 */
export function clampTestTimeoutMs(value: unknown): number {
  const ms = typeof value === 'number' ? value : NaN
  if (!Number.isFinite(ms)) return TEST_TIMEOUT_DEFAULT_MS
  return Math.min(TEST_TIMEOUT_MAX_MS, Math.max(TEST_TIMEOUT_MIN_MS, Math.round(ms)))
}

/**
 * Reads what was typed into the timeout field: whole or decimal seconds inside the range, as
 * milliseconds. Null when the text is anything else.
 */
export function parseTestTimeoutSeconds(text: string): number | null {
  const trimmed = text.trim()
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null
  const ms = Number(trimmed) * 1000
  return ms >= TEST_TIMEOUT_MIN_MS && ms <= TEST_TIMEOUT_MAX_MS ? Math.round(ms) : null
}

/** Adds the scheme when missing and returns a message when the URL cannot be used. */
export function normalizeServerUrl(input: string): { url: string } | { error: string } {
  const text = input.trim()
  if (!text) return { error: 'Server URL is required' }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `nats://${text}`
  const scheme = withScheme.slice(0, withScheme.indexOf('://')).toLowerCase()
  if (scheme === 'ws' || scheme === 'wss') {
    return {
      error: 'WebSocket URLs are not supported. Use the nats:// or tls:// address of the server.'
    }
  }
  if (scheme !== 'nats' && scheme !== 'tls')
    return { error: `Unsupported scheme "${scheme}://". Use nats:// or tls://` }
  let parsed: URL
  try {
    parsed = new URL(withScheme.replace(/^(nats|tls):\/\//i, 'http://'))
  } catch {
    return { error: 'Not a valid server address. Expected host:port' }
  }
  if (!parsed.hostname) return { error: 'Host is required' }
  if (parsed.port) {
    const port = Number(parsed.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      return { error: 'Port must be between 1 and 65535' }
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '')
    return { error: 'Server address cannot contain a path' }
  const host =
    parsed.hostname.includes(':') && !parsed.hostname.startsWith('[')
      ? `[${parsed.hostname}]`
      : parsed.hostname
  return { url: `${scheme}://${host}:${parsed.port || '4222'}` }
}

export type ConnectionErrors = Partial<
  Record<'name' | 'servers' | 'user' | 'password' | 'token' | 'nkeySeed' | 'credsFile', string>
>

export interface ValidationContext {
  /** Secrets already stored for the connection being edited. */
  stored?: { password?: boolean; token?: boolean; nkeySeed?: boolean }
}

/** Validates the connection form. An empty object means the input can be saved. */
export function validateConnectionInput(
  input: ConnectionInput,
  ctx: ValidationContext = {}
): ConnectionErrors {
  const errors: ConnectionErrors = {}
  if (!input.name.trim()) errors.name = 'Name is required'
  const servers = input.servers.map((s) => s.trim()).filter(Boolean)
  if (servers.length === 0) {
    errors.servers = 'At least one server URL is required'
  } else {
    for (const server of servers) {
      const result = normalizeServerUrl(server)
      if ('error' in result) {
        errors.servers = `${server}: ${result.error}`
        break
      }
    }
  }
  const mustAsk = input.saveSecrets === false
  const needs = (method: AuthMethod): boolean => input.auth === method
  if (needs('userpass')) {
    if (!input.user?.trim()) errors.user = 'User is required'
    if (!mustAsk && !input.password && !ctx.stored?.password)
      errors.password = 'Password is required'
  }
  if (needs('token') && !mustAsk && !input.token && !ctx.stored?.token)
    errors.token = 'Token is required'
  if (needs('nkey') && !mustAsk && !input.nkeySeed && !input.nkeyFile && !ctx.stored?.nkeySeed) {
    errors.nkeySeed = 'NKey seed is required'
  }
  if (needs('nkey') && input.nkeySeed && !/^S[A-Z2-7]{50,}$/.test(input.nkeySeed.trim())) {
    errors.nkeySeed = 'This does not look like an NKey seed (it should start with "S")'
  }
  if (needs('creds') && !input.credsFile?.trim()) errors.credsFile = 'Credentials file is required'
  return errors
}
