import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { WebSocketServer } from 'ws'
import { RpcSession } from '@core/rpcSession'
import { KeyFileSecretStore } from '@core/secrets'
import { StudioService } from '@core/service'
import type { ConnectionInput } from '@shared/api'
import type { ClientMessage } from '@shared/rpc'
import { Auth, type AuthConfig } from './auth'

export interface ServerOptions {
  port: number
  host: string
  dataDir: string
  /** Folder with the built UI (index.html and assets). */
  webRoot: string
  auth: AuthConfig
  /** Session length in milliseconds. Defaults to 12 hours; tests shorten it. */
  sessionMs?: number
  /**
   * Only accept requests whose Host (and WebSocket Origin) is a loopback name or address. This is
   * what stops DNS rebinding when nobody signs in. Defaults to true for `auth.mode === 'none'` and
   * is ignored for token and OIDC sign-in. Set it to false only for the explicit
   * `STUDIO_ALLOW_INSECURE=1` setup, which then has no rebinding protection.
   */
  requireLoopback?: boolean
  cliContextDir: string
  appVersion: string
  natsClientVersion: string
  /** JSON file with connections the administrator provides. */
  provisionFile?: string
  lockConnections?: boolean
  forceReadOnly?: boolean
  /** How often stream and consumer metrics are sampled. Defaults to 5 seconds. */
  sampleIntervalMs?: number
}

export interface RunningServer {
  url: string
  service: StudioService
  close(): Promise<void>
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json'
}

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
}

/** The hostname of a `host[:port]` value or an origin, lowercased and without IPv6 brackets. */
function hostnameOf(value: string, isOrigin: boolean): string | undefined {
  try {
    const name = new URL(isOrigin ? value : `http://${value}`).hostname.toLowerCase()
    return name.startsWith('[') && name.endsWith(']') ? name.slice(1, -1) : name
  } catch {
    return undefined
  }
}

/** localhost, 127.0.0.0/8 and ::1. */
function isLoopbackName(name: string | undefined): boolean {
  if (!name) return false
  if (name === 'localhost' || name === 'localhost.') return true
  const kind = isIP(name)
  return kind === 4 ? name.startsWith('127.') : kind === 6 && name === '::1'
}

/** The Host header names this machine itself, so a rebound public name is refused. */
function loopbackHost(req: IncomingMessage): boolean {
  const host = req.headers.host
  return host !== undefined && isLoopbackName(hostnameOf(host, false))
}

/** True when the request comes from a page served by this server (blocks cross-site WebSockets). */
function sameOrigin(req: IncomingMessage, requireLoopback: boolean): boolean {
  const origin = req.headers.origin
  if (!origin) return false
  try {
    if (new URL(origin).host !== req.headers.host?.toLowerCase()) return false
  } catch {
    return false
  }
  return !requireLoopback || (loopbackHost(req) && isLoopbackName(hostnameOf(origin, true)))
}

/** Starts web mode (PBI-101): the same React UI, with the gateway reached over a WebSocket. */
export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const auth = new Auth(opts.auth, opts.sessionMs)
  // Without sign-in the browser's same-origin rule is the only barrier, and DNS rebinding defeats
  // it (Host and Origin both name the attacker's domain), so insist on loopback names.
  const requireLoopback = opts.auth.mode === 'none' && opts.requireLoopback !== false
  const service = new StudioService({
    dataDir: opts.dataDir,
    secretStore: new KeyFileSecretStore(join(opts.dataDir, 'secret.key')),
    cliContextDir: opts.cliContextDir,
    mode: 'web',
    appVersion: opts.appVersion,
    natsClientVersion: opts.natsClientVersion,
    lockConnections: opts.lockConnections,
    forceReadOnly: opts.forceReadOnly,
    canSignOut: auth.enabled,
    sampler: opts.sampleIntervalMs ? { intervalMs: opts.sampleIntervalMs } : undefined
  })

  if (opts.provisionFile) {
    const doc = JSON.parse(readFileSync(opts.provisionFile, 'utf8')) as {
      connections?: ConnectionInput[]
    }
    if (!Array.isArray(doc.connections))
      throw new Error(`${opts.provisionFile}: expected { "connections": [...] }`)
    service.provision(doc.connections)
  }

  const webRoot = resolve(opts.webRoot)
  const indexFile = join(webRoot, 'index.html')
  if (!existsSync(indexFile))
    throw new Error(`UI not found at ${indexFile}. Run "npm run build:web" first.`)

  const serveFile = (res: ServerResponse, file: string, cache: string): void => {
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': cache
    })
    createReadStream(file).pipe(res)
  }

  const onRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost')

    if (requireLoopback && !loopbackHost(req)) {
      res.writeHead(403, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
      res.end('Forbidden: open the studio through localhost or 127.0.0.1')
      return
    }
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ ok: true, version: opts.appVersion }))
      return
    }
    if (await auth.handle(req, res, url)) return

    if (!auth.userFor(req)) {
      const wantsPage = req.method === 'GET' && (req.headers.accept ?? '').includes('text/html')
      if (wantsPage) {
        res.writeHead(302, { Location: '/auth/login', 'Cache-Control': 'no-store' })
        res.end()
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({ error: 'Sign in required' }))
      }
      return
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' })
      res.end()
      return
    }

    // Static files, never outside the web root.
    const requested = normalize(join(webRoot, decodeURIComponent(url.pathname)))
    if (requested !== webRoot && !requested.startsWith(webRoot + sep)) {
      res.writeHead(403)
      res.end()
      return
    }
    if (requested !== webRoot && existsSync(requested) && statSync(requested).isFile()) {
      const hashed = url.pathname.startsWith('/assets/')
      serveFile(res, requested, hashed ? 'public, max-age=31536000, immutable' : 'no-cache')
      return
    }
    if (extname(url.pathname)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not found')
      return
    }
    serveFile(res, indexFile, 'no-cache')
  }

  const server: Server = createServer((req, res) => {
    onRequest(req, res).catch((err) => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end(`Server error: ${(err as Error).message}`)
    })
  })

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const user = auth.userFor(req)
    // Both checks matter: the cookie proves who it is, the origin proves our own page opened it.
    if (url.pathname !== '/rpc' || !user || !sameOrigin(req, requireLoopback)) {
      socket.write(
        `HTTP/1.1 ${!user ? '401 Unauthorized' : '403 Forbidden'}\r\nConnection: close\r\n\r\n`
      )
      socket.destroy()
      return
    }
    const sid = auth.sessionIdFor(req)
    wss.handleUpgrade(req, socket, head, (ws) => {
      // An open socket must not outlive its session: close it on logout and on expiry.
      const endSession = (): void => ws.close(4401, 'session ended')
      const unwatch = sid ? auth.watchSession(sid, endSession) : () => {}
      const session = new RpcSession(
        service,
        (message) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message))
        },
        auth.enabled ? user : undefined
      )
      ws.on('message', (data) => {
        if (sid && !auth.sessionActive(sid)) return endSession()
        let message: ClientMessage
        try {
          message = JSON.parse(String(data))
        } catch {
          return
        }
        session.handle(message)
      })
      ws.on('close', () => {
        unwatch()
        session.dispose()
      })
      ws.on('error', () => {
        unwatch()
        session.dispose()
      })
    })
  })

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(opts.port, opts.host, resolveListen)
  })
  const address = server.address() as { port: number }

  return {
    url: `http://${opts.host === '0.0.0.0' || opts.host === '::' ? 'localhost' : opts.host}:${address.port}`,
    service,
    async close() {
      for (const client of wss.clients) client.terminate()
      wss.close()
      auth.dispose()
      await new Promise<void>((r) => server.close(() => r()))
      await service.dispose()
    }
  }
}
