import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createAccount,
  createOperator,
  createUser,
  encodeAccount,
  encodeOperator,
  encodeUser,
  fmtCreds,
  type KeyPair
} from '@nats-io/jwt'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GatewayError, type ConnectionInput } from '@shared/api'
import { startNatsServer, type TestServer } from '../helpers/natsServer'
import { createHarness, type Harness } from '../helpers/studio'

/**
 * Credentials-file login (a user JWT plus its NKey seed), checked against a real nats-server that
 * runs in operator mode: it trusts one operator and knows its accounts only through their JWTs.
 * Every key, JWT and creds file is made for the test.
 */

/** One user's credentials file and the secrets inside it. */
interface Creds {
  file: string
  jwt: string
  seed: string
  /** The user's public key, which is how the server names the user. */
  user: string
}

/**
 * The JWT library sets no account limits of its own, and the server reads a missing limit as zero:
 * an account without `conn` may not open a single connection. `-1` means unlimited.
 */
const CORE_LIMITS = {
  subs: -1,
  data: -1,
  payload: -1,
  imports: -1,
  exports: -1,
  wildcards: true,
  conn: -1,
  leaf: -1
}
/** JetStream is switched on for an account by giving it storage in its JWT. */
const JETSTREAM_LIMITS = { mem_storage: -1, disk_storage: -1, streams: -1, consumer: -1 }

let h: Harness
let server: TestServer
let dir: string
let account: KeyPair
let alice: Creds

async function writeCreds(
  name: string,
  issuer: KeyPair,
  opts: { exp?: number } = {}
): Promise<Creds> {
  const user = createUser()
  const jwt = await encodeUser(name, user, issuer, {}, opts)
  const file = join(dir, `${name}.creds`)
  writeFileSync(file, fmtCreds(jwt, user), { mode: 0o600 })
  return { file, jwt, seed: new TextDecoder().decode(user.getSeed()), user: user.getPublicKey() }
}

function credsInput(name: string, creds: Creds): ConnectionInput {
  return { name, servers: [server.url], auth: 'creds', credsFile: creds.file }
}

/**
 * Fails when `text` holds the seed or the JWT, or any 12-character run of either, so a shortened
 * or partly masked copy counts as a leak too.
 */
function expectNoSecrets(text: string, creds: Creds, where: string): void {
  for (const [label, secret] of [
    ['seed', creds.seed],
    ['JWT', creds.jwt]
  ]) {
    let leaked = false
    for (let i = 0; i + 12 <= secret.length && !leaked; i++)
      leaked = text.includes(secret.slice(i, i + 12))
    expect(leaked, `${where} contains part of the ${label}`).toBe(false)
  }
}

async function expectGatewayError(promise: Promise<unknown>, kind: string): Promise<GatewayError> {
  const err = await promise.then(
    () => undefined,
    (e) => e
  )
  expect(err, `expected a "${kind}" error`).toBeInstanceOf(GatewayError)
  expect((err as GatewayError).kind).toBe(kind)
  return err as GatewayError
}

/** The server must turn these credentials away, and nothing the studio says may give them away. */
async function expectRefused(creds: Creds): Promise<void> {
  const tested = await h.service.testConnection(credsInput('refused', creds))
  expect(tested).toMatchObject({ ok: false, kind: 'auth' })
  expectNoSecrets(JSON.stringify(tested), creds, 'the test result')

  const saved = await h.service.saveConnection(credsInput('refused', creds))
  try {
    const err = await expectGatewayError(h.service.connect(saved.id), 'nats')
    expect(err.message).toMatch(/Authentication failed/)
    expectNoSecrets(err.message, creds, 'the connect error')
    const state = (await h.service.listConnections()).find((c) => c.id === saved.id)!.state
    expect(state.status).toBe('error')
    expect(state.error).toMatch(/Authentication failed/)
    expectNoSecrets(JSON.stringify(state), creds, 'the connection state')
  } finally {
    await h.service.deleteConnection(saved.id)
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'studio-creds-'))
  const operator = createOperator()
  const system = createAccount()
  account = createAccount()
  const operatorJwt = await encodeOperator('studio-test-operator', operator)
  const systemJwt = await encodeAccount(
    'SYS',
    system,
    { limits: CORE_LIMITS },
    { signer: operator }
  )
  const accountJwt = await encodeAccount(
    'APP',
    account,
    { limits: { ...CORE_LIMITS, ...JETSTREAM_LIMITS } },
    { signer: operator }
  )
  // Operator mode needs a system account, and with the memory resolver the server knows exactly
  // the accounts that are preloaded here.
  server = await startNatsServer(`
operator: ${operatorJwt}
system_account: ${system.getPublicKey()}
resolver: MEMORY
resolver_preload: {
  ${system.getPublicKey()}: ${systemJwt}
  ${account.getPublicKey()}: ${accountJwt}
}
`)
  alice = await writeCreds('alice', account)

  // A NATS CLI context that points at the same file, in place before the studio starts.
  const ctxDir = join(dir, 'nats', 'context')
  mkdirSync(ctxDir, { recursive: true })
  writeFileSync(join(ctxDir, 'jwt.json'), JSON.stringify({ url: server.url, creds: alice.file }))
  h = await createHarness({ cliContextDir: ctxDir })
})

afterAll(async () => {
  await h?.dispose()
  await server?.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('PBI-011 credentials file (JWT) authentication', () => {
  it('connects and reports the account and user the JWT belongs to', async () => {
    const saved = await h.service.saveConnection(credsInput('jwt', alice))
    expect(saved).toMatchObject({ auth: 'creds', credsFile: alice.file })
    expect(saved.storedSecrets).toEqual({})

    const state = await h.service.connect(saved.id)
    expect(state).toMatchObject({
      status: 'connected',
      server: `127.0.0.1:${server.port}`,
      serverName: `studio-test-${server.port}`
    })

    // In operator mode the server names accounts and users by their public keys.
    const info = await h.service.serverInfo(saved.id)
    expect(info.account).toBe(account.getPublicKey())
    expect(info.user).toBe(alice.user)
    expect(info.jetstream).toBe(true)

    // JetStream comes from the limits in the account JWT, and it really answers.
    const js = await h.service.accountInfo(saved.id)
    expect(js.enabled).toBe(true)
    const stream = await h.service.createStream(saved.id, {
      name: 'JWT_ORDERS',
      subjects: ['jwt.>']
    })
    expect(stream.config.name).toBe('JWT_ORDERS')
    await h.service.deleteStream(saved.id, 'JWT_ORDERS')

    await h.service.deleteConnection(saved.id)
  })

  it('refuses a user whose account the server does not know', async () => {
    // Correctly signed, but by an account that is not in resolver_preload.
    await expectRefused(await writeCreds('stranger', createAccount()))
  })

  it('refuses a user JWT that has expired', async () => {
    const now = Math.floor(Date.now() / 1000)
    await expectRefused(await writeCreds('expired', account, { exp: now - 3600 }))

    // The same kind of JWT with its expiry still ahead is accepted, so the date is what decides.
    const fresh = await writeCreds('fresh', account, { exp: now + 3600 })
    expect(await h.service.testConnection(credsInput('fresh', fresh))).toMatchObject({ ok: true })
  })

  it('accepts a credentials file with Windows line endings or without a final newline', async () => {
    // The NATS CLI reads both, so a file that works there has to work here.
    const text = readFileSync(alice.file, 'utf8')
    const crlf = { ...alice, file: join(dir, 'alice-crlf.creds') }
    writeFileSync(crlf.file, text.replace(/\n/g, '\r\n'))
    const bare = { ...alice, file: join(dir, 'alice-bare.creds') }
    writeFileSync(bare.file, text.trimEnd())

    for (const creds of [crlf, bare]) {
      const saved = await h.service.saveConnection(credsInput('line-ends', creds))
      expect((await h.service.connect(saved.id)).status).toBe('connected')
      expect((await h.service.serverInfo(saved.id)).user).toBe(alice.user)
      await h.service.deleteConnection(saved.id)
    }
  })
})

describe('PBI-012 test connection with a credentials file', () => {
  it('reports the server and JetStream without saving anything', async () => {
    const before = (await h.service.listConnections()).length
    const result = await h.service.testConnection(credsInput('jwt-test', alice))
    expect(result).toMatchObject({
      ok: true,
      jetstream: true,
      serverName: `studio-test-${server.port}`
    })
    if (result.ok) expect(result.version).toMatch(/^\d+\.\d+\.\d+/)
    expect((await h.service.listConnections()).length).toBe(before)
  })
})

describe('PBI-010 NATS CLI context with a credentials file', () => {
  it('lists the context and connects with it', async () => {
    const ctx = (await h.service.listConnections()).find((c) => c.id === 'cli:jwt')
    expect(ctx).toMatchObject({
      name: 'jwt',
      source: 'cli',
      auth: 'creds',
      credsFile: alice.file,
      servers: [server.url]
    })

    expect((await h.service.connect('cli:jwt')).status).toBe('connected')
    const info = await h.service.serverInfo('cli:jwt')
    expect(info.account).toBe(account.getPublicKey())
    expect(info.user).toBe(alice.user)
    await h.service.disconnect('cli:jwt')
  })
})

describe('PBI-014 credentials file stays where it is', () => {
  it('stores only the path, never the JWT or the seed', async () => {
    const saved = await h.service.saveConnection(credsInput('jwt-stored', alice))
    await h.service.connect(saved.id)

    const onDisk = readFileSync(join(h.dataDir, 'connections.json'), 'utf8')
    const stored = JSON.parse(onDisk).connections.find((c: { id: string }) => c.id === saved.id)
    expect(stored).toMatchObject({ auth: 'creds', credsFile: alice.file })
    expect(stored.secrets).toEqual({})
    expectNoSecrets(onDisk, alice, 'connections.json')

    // Nothing else the studio keeps on disk or hands to the UI has it either.
    const checked: string[] = []
    for (const entry of readdirSync(h.dataDir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue
      const path = join(entry.parentPath, entry.name)
      expectNoSecrets(readFileSync(path, 'latin1'), alice, path)
      checked.push(entry.name)
    }
    expect(checked).toContain('connections.json')
    expectNoSecrets(JSON.stringify(await h.service.listConnections()), alice, 'the connection list')

    await h.service.deleteConnection(saved.id)
  })
})
