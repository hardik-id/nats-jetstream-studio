import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import WebSocket from 'ws'
import type { AuthConfig } from '../../src/server/auth'
import { startServer, type RunningServer } from '../../src/server/server'
import type { ConnectionSummary, GatewayErrorData } from '@shared/api'
import type { ServerMessage } from '@shared/rpc'
import { freePort } from '../helpers/natsServer'

const natsUrl = inject('natsUrl')
const dirs: string[] = []

async function start(
  auth: AuthConfig,
  extra: Partial<Parameters<typeof startServer>[0]> = {}
): Promise<RunningServer> {
  const dir = mkdtempSync(join(tmpdir(), 'studio-web-'))
  dirs.push(dir)
  const webRoot = join(dir, 'web')
  mkdirSync(join(webRoot, 'assets'), { recursive: true })
  writeFileSync(
    join(webRoot, 'index.html'),
    '<!doctype html><title>studio</title><div id="root"></div>'
  )
  writeFileSync(join(webRoot, 'assets', 'app.js'), 'console.log("app")')
  writeFileSync(join(dir, 'outside-secret.txt'), 'must never be served')
  return startServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: join(dir, 'data'),
    webRoot,
    auth,
    cliContextDir: join(dir, 'no-contexts'),
    appVersion: '0.0.0-test',
    natsClientVersion: 'test',
    ...extra
  })
}

/** A minimal RPC client over the server's WebSocket. */
class Rpc {
  private next = 1
  private readonly waiting = new Map<number, (m: Extract<ServerMessage, { t: 'result' }>) => void>()
  private constructor(private readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const message = JSON.parse(String(data)) as ServerMessage
      if (message.t === 'result') this.waiting.get(message.id)?.(message)
    })
  }

  static open(server: RunningServer, headers: Record<string, string> = {}): Promise<Rpc> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(server.url.replace('http', 'ws') + '/rpc', {
        headers: { Origin: server.url, ...headers }
      })
      ws.once('open', () => resolve(new Rpc(ws)))
      ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)))
      ws.once('error', reject)
    })
  }

  call<T>(method: string, ...args: unknown[]): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = this.next++
      this.waiting.set(id, (m) =>
        m.ok
          ? resolve(m.value as T)
          : reject(Object.assign(new Error(m.error.message), m.error as GatewayErrorData))
      )
      this.ws.send(JSON.stringify({ t: 'call', id, method, args }))
    })
  }

  close(): void {
    this.ws.close()
  }
}

const cookieOf = (res: Response): string => (res.headers.get('set-cookie') ?? '').split(';')[0]

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe('PBI-101 web mode serves the UI and the gateway', () => {
  let server: RunningServer
  beforeAll(async () => {
    server = await start({ mode: 'none' })
  })
  afterAll(() => server.close())

  it('serves the UI with security headers and never files outside its folder', async () => {
    const page = await fetch(server.url + '/')
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('<div id="root">')
    expect(page.headers.get('content-security-policy')).toContain("default-src 'self'")
    expect(page.headers.get('x-frame-options')).toBe('DENY')
    expect(page.headers.get('x-content-type-options')).toBe('nosniff')

    const asset = await fetch(server.url + '/assets/app.js')
    expect(asset.headers.get('content-type')).toContain('text/javascript')
    expect(asset.headers.get('cache-control')).toContain('immutable')
    // Unknown paths without an extension return the app (client-side routes); missing files are 404.
    expect((await fetch(server.url + '/some/route')).status).toBe(200)
    expect((await fetch(server.url + '/assets/missing.js')).status).toBe(404)

    for (const attempt of [
      '/../outside-secret.txt',
      '/%2e%2e/outside-secret.txt',
      '/..%2foutside-secret.txt',
      '/assets/../../outside-secret.txt'
    ]) {
      const res = await fetch(server.url + attempt)
      expect(await res.text(), attempt).not.toContain('must never be served')
    }
    expect((await fetch(server.url + '/', { method: 'POST' })).status).toBe(405)
    expect(await (await fetch(server.url + '/healthz')).json()).toEqual({
      ok: true,
      version: '0.0.0-test'
    })
  })

  it('runs the same gateway over a WebSocket', async () => {
    const rpc = await Rpc.open(server)
    const info = await rpc.call<{ mode: string; connectionsLocked: boolean; canSignOut: boolean }>(
      'appInfo'
    )
    expect(info).toMatchObject({ mode: 'web', connectionsLocked: false, canSignOut: false })
    const saved = await rpc.call<ConnectionSummary>('saveConnection', {
      name: 'web',
      servers: [natsUrl],
      auth: 'userpass',
      user: 'app',
      password: 'app'
    })
    await rpc.call('connect', saved.id)
    expect((await rpc.call<{ serverName: string }>('serverInfo', saved.id)).serverName).toMatch(
      /^studio-test-/
    )
    await expect(rpc.call('noSuchMethod')).rejects.toMatchObject({ kind: 'internal' })
    await expect(rpc.call('dispose')).rejects.toMatchObject({ kind: 'internal' })
    await rpc.call('deleteConnection', saved.id)
    rpc.close()
  })

  it('refuses a WebSocket opened by another website', async () => {
    await expect(Rpc.open(server, { Origin: 'https://evil.example' })).rejects.toThrow('HTTP 403')
    await expect(Rpc.open(server, { Origin: '' })).rejects.toThrow('HTTP 403')
  })
})

describe('PBI-101 token sign-in', () => {
  let server: RunningServer
  const token = 'a-long-shared-token-for-tests'
  beforeAll(async () => {
    server = await start({ mode: 'token', token })
  })
  afterAll(() => server.close())

  it('gives nothing away without a session', async () => {
    const page = await fetch(server.url + '/', {
      headers: { Accept: 'text/html' },
      redirect: 'manual'
    })
    expect(page.status).toBe(302)
    expect(page.headers.get('location')).toBe('/auth/login')
    expect((await fetch(server.url + '/assets/app.js')).status).toBe(401)
    await expect(Rpc.open(server)).rejects.toThrow('HTTP 401')
    // The health check stays open for load balancers and reveals nothing but the version.
    expect((await fetch(server.url + '/healthz')).status).toBe(200)
  })

  it('rejects a wrong token and accepts the right one', async () => {
    const form = (value: string): RequestInit => ({
      method: 'POST',
      body: new URLSearchParams({ token: value }),
      redirect: 'manual'
    })
    const wrong = await fetch(server.url + '/auth/token', form('nope'))
    expect(wrong.headers.get('location')).toBe('/auth/login?error=1')
    expect(wrong.headers.get('set-cookie')).toBeNull()

    const ok = await fetch(server.url + '/auth/token', form(token))
    expect(ok.status).toBe(302)
    expect(ok.headers.get('location')).toBe('/')
    const setCookie = ok.headers.get('set-cookie')!
    expect(setCookie).toMatch(/HttpOnly/)
    expect(setCookie).toMatch(/SameSite=Lax/)
    const cookie = cookieOf(ok)

    expect((await fetch(server.url + '/', { headers: { Cookie: cookie } })).status).toBe(200)
    const rpc = await Rpc.open(server, { Cookie: cookie })
    expect(await rpc.call('appInfo')).toMatchObject({
      canSignOut: true,
      user: { name: 'token user' }
    })
    rpc.close()

    // A cookie alone is not enough from another origin.
    await expect(
      Rpc.open(server, { Cookie: cookie, Origin: 'https://evil.example' })
    ).rejects.toThrow('HTTP 403')

    // Signing out ends the session.
    await fetch(server.url + '/auth/logout', { headers: { Cookie: cookie }, redirect: 'manual' })
    await expect(Rpc.open(server, { Cookie: cookie })).rejects.toThrow('HTTP 401')
  })
})

describe('PBI-101 OIDC sign-in', () => {
  let idp: Server
  let issuer: string
  let server: RunningServer
  let publicUrl: string
  let privateKey: CryptoKey
  let jwk: JWK
  const codes = new Map<string, { nonce: string; challenge: string; redirectUri: string }>()
  let tamper: 'none' | 'audience' | 'nonce' | 'signature' = 'none'

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256')
    privateKey = pair.privateKey as CryptoKey
    jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }
    const other = await generateKeyPair('RS256')

    const idpPort = await freePort()
    issuer = `http://127.0.0.1:${idpPort}`
    // A tiny identity provider: discovery, authorize (auto-approves), token and keys.
    idp = createServer((req, res) => {
      const url = new URL(req.url ?? '/', issuer)
      const json = (body: unknown, status = 200): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      if (url.pathname === '/.well-known/openid-configuration') {
        return json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`
        })
      }
      if (url.pathname === '/jwks') return json({ keys: [jwk] })
      if (url.pathname === '/authorize') {
        const code = Math.random().toString(36).slice(2)
        codes.set(code, {
          nonce: url.searchParams.get('nonce')!,
          challenge: url.searchParams.get('code_challenge')!,
          redirectUri: url.searchParams.get('redirect_uri')!
        })
        res.writeHead(302, {
          Location: `${url.searchParams.get('redirect_uri')}?code=${code}&state=${url.searchParams.get('state')}`
        })
        return res.end()
      }
      if (url.pathname === '/token' && req.method === 'POST') {
        let body = ''
        req.on('data', (d) => (body += d))
        req.on('end', () => {
          void (async () => {
            const form = new URLSearchParams(body)
            const grant = codes.get(form.get('code') ?? '')
            codes.delete(form.get('code') ?? '')
            const { createHash } = await import('node:crypto')
            const expected = createHash('sha256')
              .update(form.get('code_verifier') ?? '')
              .digest('base64url')
            if (
              !grant ||
              grant.challenge !== expected ||
              grant.redirectUri !== form.get('redirect_uri')
            )
              return json({ error: 'invalid_grant' }, 400)
            const idToken = await new SignJWT({
              nonce: tamper === 'nonce' ? 'someone-else' : grant.nonce,
              name: 'Ada Lovelace',
              email: 'ada@example.com'
            })
              .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
              .setIssuer(issuer)
              .setAudience(tamper === 'audience' ? 'another-app' : 'studio')
              .setSubject('user-1')
              .setIssuedAt()
              .setExpirationTime('5m')
              .sign(tamper === 'signature' ? (other.privateKey as CryptoKey) : privateKey)
            json({ id_token: idToken, access_token: 'unused', token_type: 'Bearer' })
          })()
        })
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((r) => idp.listen(idpPort, '127.0.0.1', r))

    const port = await freePort()
    publicUrl = `http://127.0.0.1:${port}`
    server = await start({ mode: 'oidc', issuer, clientId: 'studio', publicUrl }, { port })
  })
  afterAll(async () => {
    await server.close()
    idp.close()
  })

  /** Follows the sign-in redirects by hand, the way a browser would. */
  async function signIn(): Promise<Response> {
    const login = await fetch(publicUrl + '/auth/login', { redirect: 'manual' })
    expect(login.status).toBe(302)
    const authorize = new URL(login.headers.get('location')!)
    expect(authorize.origin).toBe(issuer)
    expect(authorize.searchParams.get('client_id')).toBe('studio')
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${publicUrl}/auth/callback`)
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorize.searchParams.get('scope')).toContain('openid')
    const approved = await fetch(authorize, { redirect: 'manual' })
    return fetch(approved.headers.get('location')!, { redirect: 'manual' })
  }

  it('requires sign-in before anything else', async () => {
    const page = await fetch(publicUrl + '/', {
      headers: { Accept: 'text/html' },
      redirect: 'manual'
    })
    expect(page.headers.get('location')).toBe('/auth/login')
    await expect(Rpc.open(server)).rejects.toThrow('HTTP 401')
  })

  it('signs a user in and names them in the app and the audit log', async () => {
    tamper = 'none'
    const callback = await signIn()
    expect(callback.status).toBe(302)
    expect(callback.headers.get('location')).toBe('/')
    const cookie = cookieOf(callback)
    expect(cookie).toMatch(/^studio_session=/)

    const rpc = await Rpc.open(server, { Cookie: cookie })
    expect(await rpc.call('appInfo')).toMatchObject({
      mode: 'web',
      canSignOut: true,
      user: { name: 'Ada Lovelace', email: 'ada@example.com' }
    })
    const saved = await rpc.call<ConnectionSummary>('saveConnection', {
      name: 'oidc',
      servers: [natsUrl],
      auth: 'userpass',
      user: 'app',
      password: 'app'
    })
    await rpc.call('connect', saved.id)
    const stream = `OIDC_${Math.random().toString(36).slice(2, 8).toUpperCase()}`
    await rpc.call('createStream', saved.id, { name: stream, subjects: [`${stream}.>`] })
    await rpc.call('deleteStream', saved.id, stream)
    const audit = await rpc.call<{ action: string; user?: string }[]>('auditList', {
      connId: saved.id
    })
    expect(audit.map((e) => [e.action, e.user])).toEqual([
      ['stream.delete', 'ada@example.com'],
      ['stream.create', 'ada@example.com']
    ])
    expect(await rpc.call<string>('auditExportCsv', { connId: saved.id })).toContain(
      '"ada@example.com"'
    )
    await rpc.call('deleteConnection', saved.id)
    rpc.close()
  })

  it('rejects tokens meant for another app, another sign-in, or signed by someone else', async () => {
    for (const mode of ['audience', 'nonce', 'signature'] as const) {
      tamper = mode
      const callback = await signIn()
      expect(callback.status, mode).toBeGreaterThanOrEqual(400)
      expect(callback.headers.get('set-cookie'), mode).toBeNull()
      expect(await callback.text(), mode).toMatch(/Sign-in failed/)
    }
    tamper = 'none'
  })

  it('rejects a callback that does not belong to a sign-in it started', async () => {
    const forged = await fetch(`${publicUrl}/auth/callback?code=abc&state=made-up`, {
      redirect: 'manual'
    })
    expect(forged.status).toBe(400)
    expect(forged.headers.get('set-cookie')).toBeNull()

    // A state can be used once.
    const login = await fetch(publicUrl + '/auth/login', { redirect: 'manual' })
    const approved = await fetch(login.headers.get('location')!, { redirect: 'manual' })
    const callbackUrl = approved.headers.get('location')!
    expect((await fetch(callbackUrl, { redirect: 'manual' })).status).toBe(302)
    expect((await fetch(callbackUrl, { redirect: 'manual' })).status).toBe(400)
  })
})

describe('PBI-101 administrator controls', () => {
  it('provisions connections from a file, locks them and can force read-only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'studio-prov-'))
    dirs.push(dir)
    const provisionFile = join(dir, 'connections.json')
    writeFileSync(
      provisionFile,
      JSON.stringify({
        connections: [
          {
            name: 'Shared',
            servers: [natsUrl],
            auth: 'userpass',
            user: 'app',
            password: 'app',
            envLabel: 'dev',
            readOnly: false
          }
        ]
      })
    )
    const dataDir = join(dir, 'data')
    const server = await start(
      { mode: 'none' },
      { provisionFile, dataDir, lockConnections: true, forceReadOnly: true }
    )
    try {
      const rpc = await Rpc.open(server)
      expect(await rpc.call('appInfo')).toMatchObject({ connectionsLocked: true })
      const list = await rpc.call<ConnectionSummary[]>('listConnections')
      expect(list).toHaveLength(1)
      // Read-only is enforced by the server whatever the connection itself says.
      expect(list[0]).toMatchObject({
        name: 'Shared',
        readOnly: true,
        storedSecrets: { password: true }
      })
      expect(JSON.stringify(list)).not.toContain('"app"}')

      await expect(
        rpc.call('saveConnection', { name: 'mine', servers: [natsUrl], auth: 'none' })
      ).rejects.toMatchObject({
        kind: 'validation',
        message: expect.stringMatching(/managed by its administrator/)
      })
      await expect(
        rpc.call('saveConnection', {
          id: list[0].id,
          name: 'Shared',
          servers: [natsUrl],
          auth: 'userpass',
          user: 'app',
          readOnly: false
        })
      ).rejects.toMatchObject({ kind: 'validation' })
      await expect(rpc.call('deleteConnection', list[0].id)).rejects.toMatchObject({
        kind: 'validation'
      })
      await expect(rpc.call('duplicateConnection', list[0].id)).rejects.toMatchObject({
        kind: 'validation'
      })

      await rpc.call('connect', list[0].id)
      expect((await rpc.call<unknown[]>('listStreams', list[0].id)).length).toBeGreaterThanOrEqual(
        0
      )
      await expect(
        rpc.call('createStream', list[0].id, { name: 'NOPE_RO', subjects: ['nope.ro'] })
      ).rejects.toMatchObject({ kind: 'read_only' })
      await expect(
        rpc.call('publish', list[0].id, { subject: 'nope.ro', payload: '', mode: 'core' })
      ).rejects.toMatchObject({ kind: 'read_only' })
      rpc.close()
    } finally {
      await server.close()
    }

    // Starting again with the same file updates the connection instead of adding a second one.
    writeFileSync(
      provisionFile,
      JSON.stringify({
        connections: [
          {
            name: 'Shared',
            servers: [natsUrl],
            auth: 'userpass',
            user: 'app',
            password: 'app',
            envLabel: 'staging'
          }
        ]
      })
    )
    const again = await start({ mode: 'none' }, { provisionFile, dataDir })
    try {
      const rpc = await Rpc.open(again)
      const list = await rpc.call<ConnectionSummary[]>('listConnections')
      expect(list).toHaveLength(1)
      expect(list[0].envLabel).toBe('staging')
      rpc.close()
    } finally {
      await again.close()
    }
  })
})
