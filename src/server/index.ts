import { join, resolve } from 'node:path'
import natsPkg from '@nats-io/transport-node/package.json'
import appPkg from '../../package.json'
import { cliContextDir } from '@core/cliContexts'
import type { AuthConfig } from './auth'
import { startServer } from './server'

const env = process.env
const flag = (name: string): boolean => /^(1|true|yes)$/i.test(env[name] ?? '')

function authFromEnv(host: string): AuthConfig {
  const mode = (env.STUDIO_AUTH ?? '').toLowerCase()
  if (mode === 'oidc' || (!mode && env.STUDIO_OIDC_ISSUER)) {
    const issuer = env.STUDIO_OIDC_ISSUER
    const clientId = env.STUDIO_OIDC_CLIENT_ID
    const publicUrl = env.STUDIO_PUBLIC_URL
    if (!issuer || !clientId || !publicUrl) {
      throw new Error(
        'OIDC sign-in needs STUDIO_OIDC_ISSUER, STUDIO_OIDC_CLIENT_ID and STUDIO_PUBLIC_URL'
      )
    }
    return {
      mode: 'oidc',
      issuer,
      clientId,
      clientSecret: env.STUDIO_OIDC_CLIENT_SECRET,
      publicUrl,
      scopes: env.STUDIO_OIDC_SCOPES
    }
  }
  if (mode === 'token' || (!mode && env.STUDIO_AUTH_TOKEN)) {
    const token = env.STUDIO_AUTH_TOKEN
    if (!token || token.length < 16)
      throw new Error('STUDIO_AUTH_TOKEN must be at least 16 characters')
    return { mode: 'token', token }
  }
  if (mode === 'none') {
    const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
    if (!loopback && !flag('STUDIO_ALLOW_INSECURE')) {
      throw new Error(
        'STUDIO_AUTH=none is only allowed when listening on localhost. Anyone who can reach this port could use your NATS credentials.'
      )
    }
    return { mode: 'none' }
  }
  throw new Error(
    'Choose how users sign in: set STUDIO_OIDC_ISSUER (recommended), STUDIO_AUTH_TOKEN, or STUDIO_AUTH=none for local use.'
  )
}

async function main(): Promise<void> {
  const host = env.HOST ?? '127.0.0.1'
  const dataDir = resolve(env.STUDIO_DATA_DIR ?? '.studio-data')
  const running = await startServer({
    port: Number(env.PORT ?? 8080),
    host,
    dataDir,
    webRoot: resolve(env.STUDIO_WEB_ROOT ?? join(__dirname, '..', 'web')),
    auth: authFromEnv(host),
    cliContextDir: env.STUDIO_CONTEXT_DIR ? resolve(env.STUDIO_CONTEXT_DIR) : cliContextDir(),
    appVersion: appPkg.version,
    natsClientVersion: natsPkg.version,
    provisionFile: env.STUDIO_PROVISION_FILE ? resolve(env.STUDIO_PROVISION_FILE) : undefined,
    lockConnections: flag('STUDIO_LOCK_CONNECTIONS'),
    forceReadOnly: flag('STUDIO_READ_ONLY'),
    sampleIntervalMs: env.STUDIO_SAMPLE_INTERVAL_MS
      ? Math.max(500, Number(env.STUDIO_SAMPLE_INTERVAL_MS))
      : undefined
  })
  console.log(`NATS JetStream Studio ${appPkg.version} listening on ${running.url}`)

  const stop = (): void => {
    void running.close().finally(() => process.exit(0))
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

main().catch((err) => {
  console.error(`Cannot start: ${(err as Error).message}`)
  process.exit(1)
})
