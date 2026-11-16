import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { RequestUser } from '@core/context'

export type AuthConfig =
  | { mode: 'none' }
  | { mode: 'token'; token: string }
  | {
      mode: 'oidc'
      issuer: string
      clientId: string
      clientSecret?: string
      /** Public base URL of the studio, used to build the redirect URI. */
      publicUrl: string
      scopes?: string
    }

interface Session {
  user: RequestUser
  expires: number
}

interface PendingLogin {
  verifier: string
  nonce: string
  expires: number
}

const COOKIE = 'studio_session'
const SESSION_MS = 12 * 60 * 60 * 1000
const LOGIN_MS = 10 * 60 * 1000

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

function safeEqual(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest()
  const y = createHash('sha256').update(b).digest()
  return timingSafeEqual(x, y)
}

const b64url = (buf: Buffer): string => buf.toString('base64url')

const LOGIN_PAGE = (error: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in - NATS JetStream Studio</title>
<style>
  body{font:14px system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:grid;place-items:center;min-height:100vh;margin:0}
  form{background:#1e293b;padding:28px;border-radius:10px;width:320px;box-shadow:0 10px 30px rgba(0,0,0,.4)}
  h1{font-size:17px;margin:0 0 16px} label{display:block;margin-bottom:6px;color:#94a3b8}
  input{width:100%;box-sizing:border-box;padding:9px 10px;border-radius:6px;border:1px solid #475569;background:#0f172a;color:inherit;font:inherit}
  button{margin-top:14px;width:100%;padding:9px;border:0;border-radius:6px;background:#2563eb;color:#fff;font:inherit;cursor:pointer}
  .err{color:#fca5a5;margin:0 0 12px}
</style></head><body>
<form method="post" action="/auth/token">
  <h1>NATS JetStream Studio</h1>
  ${error ? `<p class="err" role="alert">${error}</p>` : ''}
  <label for="token">Access token</label>
  <input id="token" name="token" type="password" autocomplete="current-password" autofocus required>
  <button type="submit">Sign in</button>
</form></body></html>`

/**
 * Sign-in for web mode (PBI-101). Nothing behind it is reachable without a session:
 * the page, the WebSocket and therefore every NATS operation.
 */
export class Auth {
  private readonly sessions = new Map<string, Session>()
  private readonly pending = new Map<string, PendingLogin>()
  /** Callbacks for open connections, by session id, and the timer that fires at expiry. */
  private readonly watchers = new Map<
    string,
    { callbacks: Set<() => void>; timer: NodeJS.Timeout }
  >()
  private discovery:
    | Promise<{
        authorization_endpoint: string
        token_endpoint: string
        jwks_uri: string
        issuer: string
      }>
    | undefined
  private jwks: ReturnType<typeof createRemoteJWKSet> | undefined

  constructor(
    readonly config: AuthConfig,
    private readonly sessionMs = SESSION_MS
  ) {}

  get enabled(): boolean {
    return this.config.mode !== 'none'
  }

  /** The signed-in user for a request, or null. With auth disabled everyone is "local". */
  userFor(req: IncomingMessage): RequestUser | null {
    if (this.config.mode === 'none') return { name: 'local' }
    const sid = parseCookies(req.headers.cookie)[COOKIE]
    if (!sid) return null
    const session = this.sessions.get(sid)
    if (!session) return null
    if (session.expires < Date.now()) {
      this.sessions.delete(sid)
      return null
    }
    return session.user
  }

  /** The session id in a request's cookie (undefined without one, or with auth disabled). */
  sessionIdFor(req: IncomingMessage): string | undefined {
    if (this.config.mode === 'none') return undefined
    return parseCookies(req.headers.cookie)[COOKIE]
  }

  /** True while the session exists and has not expired. */
  sessionActive(sid: string): boolean {
    const session = this.sessions.get(sid)
    if (!session) return false
    if (session.expires < Date.now()) {
      this.endSession(sid)
      return false
    }
    return true
  }

  /**
   * Calls `onEnd` once when the session is logged out or expires, even if its connection is idle.
   * Returns a function that stops watching (call it when the connection closes).
   */
  watchSession(sid: string, onEnd: () => void): () => void {
    const session = this.sessions.get(sid)
    if (!session) {
      onEnd()
      return () => {}
    }
    let entry = this.watchers.get(sid)
    if (!entry) {
      const timer = setTimeout(
        () => this.endSession(sid),
        Math.max(0, session.expires - Date.now()) + 1
      )
      timer.unref()
      entry = { callbacks: new Set(), timer }
      this.watchers.set(sid, entry)
    }
    entry.callbacks.add(onEnd)
    return () => {
      const current = this.watchers.get(sid)
      if (!current) return
      current.callbacks.delete(onEnd)
      if (current.callbacks.size === 0) {
        clearTimeout(current.timer)
        this.watchers.delete(sid)
      }
    }
  }

  private endSession(sid: string): void {
    this.sessions.delete(sid)
    const entry = this.watchers.get(sid)
    if (!entry) return
    clearTimeout(entry.timer)
    this.watchers.delete(sid)
    for (const callback of entry.callbacks) callback()
  }

  /** Clears every timer (server shutdown). */
  dispose(): void {
    for (const entry of this.watchers.values()) clearTimeout(entry.timer)
    this.watchers.clear()
  }

  private startSession(res: ServerResponse, user: RequestUser, secure: boolean): void {
    const sid = b64url(randomBytes(32))
    this.sessions.set(sid, { user, expires: Date.now() + this.sessionMs })
    const flags = [
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${Math.floor(this.sessionMs / 1000)}`
    ]
    if (secure) flags.push('Secure')
    res.setHeader('Set-Cookie', `${COOKIE}=${sid}; ${flags.join('; ')}`)
  }

  private isSecure(req: IncomingMessage): boolean {
    if (this.config.mode === 'oidc') return this.config.publicUrl.startsWith('https://')
    return req.headers['x-forwarded-proto'] === 'https'
  }

  private redirect(res: ServerResponse, location: string): void {
    res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' })
    res.end()
  }

  /** Handles /auth/* routes. Returns true when the request was answered. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith('/auth/')) return false

    if (url.pathname === '/auth/logout') {
      const sid = parseCookies(req.headers.cookie)[COOKIE]
      if (sid) this.endSession(sid)
      res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
      this.redirect(res, '/')
      return true
    }

    if (this.config.mode === 'token') {
      if (url.pathname === '/auth/login') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store'
        })
        res.end(LOGIN_PAGE(url.searchParams.has('error') ? 'That token is not valid.' : ''))
        return true
      }
      if (url.pathname === '/auth/token' && req.method === 'POST') {
        const body = await readBody(req, 8192)
        const token = new URLSearchParams(body).get('token') ?? ''
        if (!safeEqual(token, this.config.token)) {
          // Slow down guessing a little.
          await new Promise((r) => setTimeout(r, 400))
          this.redirect(res, '/auth/login?error=1')
          return true
        }
        this.startSession(res, { name: 'token user' }, this.isSecure(req))
        this.redirect(res, '/')
        return true
      }
    }

    if (this.config.mode === 'oidc') {
      if (url.pathname === '/auth/login') {
        await this.oidcLogin(res)
        return true
      }
      if (url.pathname === '/auth/callback') {
        await this.oidcCallback(req, res, url)
        return true
      }
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not found')
    return true
  }

  private get redirectUri(): string {
    if (this.config.mode !== 'oidc') throw new Error('OIDC is not configured')
    return `${this.config.publicUrl.replace(/\/$/, '')}/auth/callback`
  }

  private discover(): NonNullable<Auth['discovery']> {
    if (this.config.mode !== 'oidc') throw new Error('OIDC is not configured')
    const issuer = this.config.issuer.replace(/\/$/, '')
    if (!this.discovery) {
      this.discovery = fetch(`${issuer}/.well-known/openid-configuration`)
        .then(async (res) => {
          if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`)
          const doc = await res.json()
          for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri', 'issuer']) {
            if (typeof doc[key] !== 'string')
              throw new Error(`OIDC discovery document has no ${key}`)
          }
          return doc
        })
        .catch((err) => {
          this.discovery = undefined
          throw err
        })
    }
    return this.discovery
  }

  private async oidcLogin(res: ServerResponse): Promise<void> {
    if (this.config.mode !== 'oidc') return
    const doc = await this.discover()
    const now = Date.now()
    for (const [state, login] of this.pending) if (login.expires < now) this.pending.delete(state)

    const state = b64url(randomBytes(24))
    const verifier = b64url(randomBytes(48))
    const nonce = b64url(randomBytes(24))
    this.pending.set(state, { verifier, nonce, expires: now + LOGIN_MS })

    const target = new URL(doc.authorization_endpoint)
    target.searchParams.set('response_type', 'code')
    target.searchParams.set('client_id', this.config.clientId)
    target.searchParams.set('redirect_uri', this.redirectUri)
    target.searchParams.set('scope', this.config.scopes ?? 'openid profile email')
    target.searchParams.set('state', state)
    target.searchParams.set('nonce', nonce)
    target.searchParams.set(
      'code_challenge',
      b64url(createHash('sha256').update(verifier).digest())
    )
    target.searchParams.set('code_challenge_method', 'S256')
    this.redirect(res, target.toString())
  }

  private async oidcCallback(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (this.config.mode !== 'oidc') return
    const fail = (status: number, message: string): void => {
      res.writeHead(status, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store'
      })
      res.end(`Sign-in failed: ${message}`)
    }
    const state = url.searchParams.get('state') ?? ''
    const code = url.searchParams.get('code')
    const login = this.pending.get(state)
    this.pending.delete(state)
    if (url.searchParams.get('error'))
      return fail(403, url.searchParams.get('error_description') ?? url.searchParams.get('error')!)
    if (!login || login.expires < Date.now())
      return fail(400, 'this sign-in attempt is unknown or has expired. Please start again.')
    if (!code) return fail(400, 'the identity provider returned no code')

    try {
      const doc = await this.discover()
      const form = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.redirectUri,
        client_id: this.config.clientId,
        code_verifier: login.verifier
      })
      const headers: Record<string, string> = {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      }
      if (this.config.clientSecret) {
        headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(this.config.clientId)}:${encodeURIComponent(this.config.clientSecret)}`).toString('base64')}`
      }
      const tokenRes = await fetch(doc.token_endpoint, { method: 'POST', headers, body: form })
      if (!tokenRes.ok)
        return fail(502, `the identity provider refused the code (${tokenRes.status})`)
      const tokens = (await tokenRes.json()) as { id_token?: string }
      if (!tokens.id_token) return fail(502, 'the identity provider returned no ID token')

      if (!this.jwks) this.jwks = createRemoteJWKSet(new URL(doc.jwks_uri))
      const { payload } = await jwtVerify(tokens.id_token, this.jwks, {
        issuer: doc.issuer,
        audience: this.config.clientId
      })
      if (payload.nonce !== login.nonce)
        return fail(400, 'the ID token does not belong to this sign-in attempt')

      const email = typeof payload.email === 'string' ? payload.email : undefined
      const name =
        (typeof payload.name === 'string' && payload.name) ||
        (typeof payload.preferred_username === 'string' && payload.preferred_username) ||
        email ||
        String(payload.sub)
      this.startSession(res, { name, email }, this.isSecure(req))
      this.redirect(res, '/')
    } catch (err) {
      fail(502, (err as Error).message)
    }
  }
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('Request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
