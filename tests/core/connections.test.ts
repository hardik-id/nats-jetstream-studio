import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUser } from '@nats-io/nkeys'
import { connect } from '@nats-io/transport-node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { cliContextDir } from '@core/cliContexts'
import { KeyFileSecretStore, NoSecretStore } from '@core/secrets'
import { StudioService } from '@core/service'
import type { ConnectionState, GlobalEvent, TestConnectionResult } from '@shared/api'
import { freePort, startNatsServer, type TestServer } from '../helpers/natsServer'
import {
  collect,
  createHarness,
  expectGatewayError,
  uniqueName,
  waitFor,
  type Harness
} from '../helpers/studio'

let h: Harness
beforeAll(async () => {
  h = await createHarness()
})
afterAll(async () => {
  await h.dispose()
})

describe('PBI-010 import NATS CLI contexts', () => {
  let dir: string
  let ctxDir: string
  let service: StudioService

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'studio-cli-'))
    ctxDir = join(dir, 'nats', 'context')
    mkdirSync(ctxDir, { recursive: true })
    writeFileSync(
      join(ctxDir, 'local.json'),
      JSON.stringify({
        description: 'Local dev',
        url: h.natsUrl,
        user: 'app',
        password: 'app',
        jetstream_domain: '',
        inbox_prefix: '_INBOX'
      })
    )
    writeFileSync(
      join(ctxDir, 'cloud.json'),
      JSON.stringify({
        url: 'tls://a.example.com:4222,tls://b.example.com',
        creds: '~/keys/cloud.creds',
        ca: '/etc/ca.pem',
        tls_first: true,
        jetstream_domain: 'hub'
      })
    )
    writeFileSync(
      join(ctxDir, 'tok.json'),
      JSON.stringify({
        url: 'nats://10.0.0.1:4222',
        token: 's3cr3t',
        jetstream_api_prefix: '$JS.acme.API'
      })
    )
    writeFileSync(
      join(ctxDir, 'nsc.json'),
      JSON.stringify({ url: 'nats://10.0.0.2:4222', nsc: 'nsc://op/acct/user' })
    )
    writeFileSync(
      join(ctxDir, 'pw.json'),
      JSON.stringify({ url: 'nats://10.0.0.3:4222', user: 'svc', password: 'Ctx-Passw0rd!' })
    )
    writeFileSync(join(ctxDir, 'broken.json'), '{ this is not json')
    writeFileSync(join(ctxDir, 'notes.txt'), 'ignored')
    service = new StudioService({
      dataDir: join(dir, 'data'),
      secretStore: new KeyFileSecretStore(join(dir, 'data', 'key')),
      cliContextDir: ctxDir,
      mode: 'desktop',
      appVersion: 't',
      natsClientVersion: 't'
    })
  })
  afterAll(async () => {
    await service.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('honours XDG_CONFIG_HOME and falls back to ~/.config', () => {
    expect(cliContextDir({ XDG_CONFIG_HOME: '/custom/xdg' })).toBe(
      join('/custom/xdg', 'nats', 'context')
    )
    expect(cliContextDir({})).toMatch(/\.config[\\/]nats[\\/]context$/)
  })

  it('lists each context as a connection and maps the supported fields', async () => {
    const list = await service.listConnections()
    expect(list.map((c) => c.name).sort()).toEqual(['cloud', 'local', 'nsc', 'pw', 'tok'])
    expect(list.every((c) => c.source === 'cli')).toBe(true)

    const local = list.find((c) => c.name === 'local')!
    expect(local).toMatchObject({
      id: 'cli:local',
      auth: 'userpass',
      user: 'app',
      description: 'Local dev',
      inboxPrefix: '_INBOX'
    })
    expect(local.servers).toEqual([h.natsUrl])

    const cloud = list.find((c) => c.name === 'cloud')!
    expect(cloud.auth).toBe('creds')
    expect(cloud.servers).toEqual(['tls://a.example.com:4222', 'tls://b.example.com:4222'])
    expect(cloud.credsFile).toMatch(/keys[\\/]cloud\.creds$/)
    expect(cloud.credsFile).not.toContain('~')
    expect(cloud.tls).toEqual({
      caFile: '/etc/ca.pem',
      certFile: undefined,
      keyFile: undefined,
      handshakeFirst: true
    })
    expect(cloud.jsDomain).toBe('hub')

    const tok = list.find((c) => c.name === 'tok')!
    expect(tok).toMatchObject({ auth: 'token', apiPrefix: '$JS.acme.API' })
    expect(list.find((c) => c.name === 'nsc')!.warnings?.[0]).toMatch(/nsc/)
  })

  it('never exposes secrets from the context files', async () => {
    const json = JSON.stringify(await service.listConnections())
    expect(json).not.toContain('s3cr3t')
    expect(json).not.toContain('Ctx-Passw0rd!')
    // The gateway itself can still read them to connect.
    expect(service.store.resolveSecrets('cli:pw')).toEqual({ password: 'Ctx-Passw0rd!' })
    expect(service.store.resolveSecrets('cli:tok')).toEqual({ token: 's3cr3t' })
  })

  it('skips a malformed file with a warning instead of failing', async () => {
    const result = await service.refreshCliContexts()
    expect(result.imported).toBe(5)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatch(/broken/)
  })

  it('connects with an imported context', async () => {
    const state = await service.connect('cli:local')
    expect(state.status).toBe('connected')
    await service.disconnect('cli:local')
  })

  it('stores studio settings separately and never writes to the CLI files', async () => {
    const hash = (): string =>
      createHash('sha256')
        .update(readFileSync(join(ctxDir, 'local.json')))
        .digest('hex')
    const before = hash()
    const saved = await service.saveConnection({
      id: 'cli:local',
      name: 'ignored',
      servers: [],
      auth: 'none',
      envLabel: 'prod',
      color: '#dc2626',
      readOnly: true
    })
    expect(saved).toMatchObject({
      name: 'local',
      envLabel: 'prod',
      color: '#dc2626',
      readOnly: true,
      source: 'cli'
    })
    expect(hash()).toBe(before)
    await expectGatewayError(service.deleteConnection('cli:local'), 'validation')
  })

  it('picks up new and removed contexts on refresh', async () => {
    writeFileSync(join(ctxDir, 'added.json'), JSON.stringify({ url: 'nats://127.0.0.1:4222' }))
    rmSync(join(ctxDir, 'tok.json'))
    const result = await service.refreshCliContexts()
    expect(result.imported).toBe(5)
    const names = (await service.listConnections()).map((c) => c.name)
    expect(names).toContain('added')
    expect(names).not.toContain('tok')
  })
})

describe('PBI-011 add, edit, duplicate and delete a connection', () => {
  it('validates URLs and required fields', async () => {
    const base = { name: 'x', servers: ['nats://localhost:4222'], auth: 'none' as const }
    expect(
      (await expectGatewayError(h.service.saveConnection({ ...base, name: ' ' }), 'validation'))
        .message
    ).toMatch(/Name/)
    expect(
      (await expectGatewayError(h.service.saveConnection({ ...base, servers: [] }), 'validation'))
        .message
    ).toMatch(/server/i)
    expect(
      (
        await expectGatewayError(
          h.service.saveConnection({ ...base, servers: ['http://x:1'] }),
          'validation'
        )
      ).message
    ).toMatch(/Unsupported scheme/)
    expect(
      (
        await expectGatewayError(
          h.service.saveConnection({ ...base, servers: ['ws://x:8080'] }),
          'validation'
        )
      ).message
    ).toMatch(/WebSocket/)
    expect(
      (
        await expectGatewayError(
          h.service.saveConnection({ ...base, servers: ['nats://x:99999'] }),
          'validation'
        )
      ).message
    ).toMatch(/Port|valid/)
    expect(
      (
        await expectGatewayError(
          h.service.saveConnection({ ...base, auth: 'userpass' }),
          'validation'
        )
      ).message
    ).toMatch(/User/)
    expect(
      (await expectGatewayError(h.service.saveConnection({ ...base, auth: 'token' }), 'validation'))
        .message
    ).toMatch(/Token/)
    expect(
      (await expectGatewayError(h.service.saveConnection({ ...base, auth: 'creds' }), 'validation'))
        .message
    ).toMatch(/Credentials/)
    expect(
      (
        await expectGatewayError(
          h.service.saveConnection({ ...base, auth: 'nkey', nkeySeed: 'nope' }),
          'validation'
        )
      ).message
    ).toMatch(/NKey/)
  })

  it('saves every field, normalises URLs and round-trips an edit', async () => {
    const created = await h.service.saveConnection({
      name: '  Staging EU ',
      servers: ['10.1.1.1', 'tls://nats.example.com:4443 '],
      auth: 'userpass',
      user: 'svc',
      password: 'pw-123',
      tls: { caFile: '/ca.pem', certFile: '/c.pem', keyFile: '/k.pem', handshakeFirst: true },
      jsDomain: 'hub',
      inboxPrefix: '_INBOX.svc',
      envLabel: 'staging',
      color: '#059669'
    })
    expect(created).toMatchObject({
      name: 'Staging EU',
      source: 'studio',
      servers: ['nats://10.1.1.1:4222', 'tls://nats.example.com:4443'],
      user: 'svc',
      jsDomain: 'hub',
      inboxPrefix: '_INBOX.svc',
      envLabel: 'staging',
      readOnly: false,
      storedSecrets: { password: true },
      tls: { caFile: '/ca.pem', certFile: '/c.pem', keyFile: '/k.pem', handshakeFirst: true }
    })
    expect(created.state.status).toBe('disconnected')

    // Editing without retyping the password keeps the stored one.
    const edited = await h.service.saveConnection({
      id: created.id,
      name: 'Staging EU 2',
      servers: created.servers,
      auth: 'userpass',
      user: 'svc',
      apiPrefix: '$JS.x.API'
    })
    expect(edited).toMatchObject({
      id: created.id,
      name: 'Staging EU 2',
      apiPrefix: '$JS.x.API',
      storedSecrets: { password: true }
    })
    expect(h.service.store.resolveSecrets(created.id).password).toBe('pw-123')

    const copy = await h.service.duplicateConnection(created.id)
    expect(copy.id).not.toBe(created.id)
    expect(copy.name).toBe('Staging EU 2 copy')
    expect(h.service.store.resolveSecrets(copy.id).password).toBe('pw-123')

    await h.service.deleteConnection(copy.id)
    await h.service.deleteConnection(created.id)
    const ids = (await h.service.listConnections()).map((c) => c.id)
    expect(ids).not.toContain(created.id)
    expect(ids).not.toContain(copy.id)
  })

  it('keeps connections across restarts', async () => {
    const saved = await h.service.saveConnection({
      name: 'persisted',
      servers: [h.natsUrl],
      auth: 'userpass',
      user: 'app',
      password: 'app'
    })
    const second = new StudioService({
      dataDir: h.dataDir,
      secretStore: new KeyFileSecretStore(join(h.dataDir, 'secret.key')),
      cliContextDir: join(h.dataDir, 'none'),
      mode: 'desktop',
      appVersion: 't',
      natsClientVersion: 't'
    })
    try {
      expect((await second.listConnections()).find((c) => c.id === saved.id)?.name).toBe(
        'persisted'
      )
      expect((await second.connect(saved.id)).status).toBe('connected')
    } finally {
      await second.dispose()
      await h.service.deleteConnection(saved.id)
    }
  })

  it('emits an event when the connection list changes', async () => {
    const events: GlobalEvent[] = []
    const close = h.service.open('events', {}, (e) => events.push(e))
    const saved = await h.service.saveConnection({
      name: 'evt',
      servers: [h.natsUrl],
      auth: 'none'
    })
    await h.service.deleteConnection(saved.id)
    close()
    expect(events.filter((e) => e.type === 'connections_changed')).toHaveLength(2)
  })
})

describe('PBI-012 test connection', () => {
  const input = { name: 't', auth: 'userpass' as const, user: 'app', password: 'app' }

  it('reports server details and JetStream availability without saving', async () => {
    const before = (await h.service.listConnections()).length
    const result = await h.service.testConnection({ ...input, servers: [h.natsUrl] })
    expect(result).toMatchObject({ ok: true, jetstream: true })
    if (result.ok) {
      expect(result.serverName).toMatch(/^studio-test-/)
      expect(result.version).toMatch(/^\d+\.\d+\.\d+/)
      expect(result.rttMs).toBeGreaterThanOrEqual(0)
    }
    expect((await h.service.listConnections()).length).toBe(before)
  })

  it('says when JetStream is not available to the account', async () => {
    const result = await h.service.testConnection({
      ...input,
      user: 'nojs',
      password: 'nojs',
      servers: [h.natsUrl]
    })
    expect(result).toMatchObject({ ok: true, jetstream: false })
    if (result.ok) expect(result.jetstreamNote).toBeTruthy()
  })

  it('names an authentication failure', async () => {
    const result = await h.service.testConnection({
      ...input,
      password: 'wrong',
      servers: [h.natsUrl]
    })
    expect(result).toMatchObject({ ok: false, kind: 'auth' })
  })

  it('names a refused connection', async () => {
    const port = await freePort()
    const result = await h.service.testConnection({
      ...input,
      servers: [`nats://127.0.0.1:${port}`]
    })
    expect(result).toMatchObject({ ok: false, kind: 'refused' })
  })

  it('tries every server, so one that is down does not hide one that works', async () => {
    // The client dials in an order of its own choosing; either way round the test must succeed.
    const down = `nats://127.0.0.1:${await freePort()}`
    for (let run = 0; run < 8; run++) {
      const result = await h.service.testConnection({ ...input, servers: [down, h.natsUrl] })
      expect(result, `run ${run + 1}`).toMatchObject({ ok: true, jetstream: true })
    }
  })

  it('names a name-resolution failure', async () => {
    const result = await h.service.testConnection({
      ...input,
      servers: ['nats://no-such-host.invalid:4222']
    })
    expect(result).toMatchObject({ ok: false, kind: 'dns' })
  })

  it('names a TLS failure', async () => {
    const result = await h.service.testConnection({
      ...input,
      servers: [h.natsUrl],
      tls: { handshakeFirst: true }
    })
    expect(result).toMatchObject({ ok: false, kind: 'tls' })
  })

  describe('when the server hangs up with a reset instead of a reason', () => {
    // On Windows a reset discards the -ERR the server wrote just before closing, so the client only
    // sees ECONNRESET. A fake server that resets right after INFO produces the same thing anywhere.
    const INFO =
      'INFO {"server_id":"x","server_name":"x","version":"2.10.0","proto":1,"host":"127.0.0.1","port":1,"max_payload":1048576,"headers":true,"auth_required":true}\r\n'
    let fake: Server
    let fakeUrl: string
    beforeAll(async () => {
      fake = createServer((socket) => {
        socket.on('error', () => {})
        socket.write(INFO)
        socket.once('data', () => socket.resetAndDestroy())
      })
      await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve))
      fakeUrl = `nats://127.0.0.1:${(fake.address() as { port: number }).port}`
    })
    afterAll(() => new Promise<void>((resolve) => fake.close(() => resolve())))

    it('names a login the server dropped as an authentication failure', async () => {
      const result = await h.service.testConnection({ ...input, servers: [fakeUrl] })
      expect(result).toMatchObject({ ok: false, kind: 'auth' })
      if (!result.ok) expect(result.message).toMatch(/Authentication failed/)
    })

    it('names a TLS handshake the server dropped as a TLS failure', async () => {
      const result = await h.service.testConnection({
        ...input,
        servers: [fakeUrl],
        tls: { handshakeFirst: true }
      })
      expect(result).toMatchObject({ ok: false, kind: 'tls' })
    })

    it('does not blame credentials when none were sent', async () => {
      const result = await h.service.testConnection({
        name: 't',
        auth: 'none',
        servers: [fakeUrl]
      })
      expect(result).toMatchObject({ ok: false, kind: 'other' })
    })

    it('explains a failed connect the same way', async () => {
      const saved = await h.service.saveConnection({ ...input, servers: [fakeUrl] })
      const err = await expectGatewayError(h.service.connect(saved.id), 'nats')
      expect(err.message).toMatch(/Authentication failed/)
      await h.service.deleteConnection(saved.id)
    })
  })

  describe('against servers that never answer', () => {
    // Each accepts the TCP connection and then says nothing, like a host behind a firewall that
    // swallows the traffic.
    const silent: Server[] = []
    const urls: string[] = []
    beforeAll(async () => {
      for (let i = 0; i < 3; i++) {
        const port = await freePort()
        const server = createServer(() => {})
        await new Promise<void>((r) => server.listen(port, '127.0.0.1', r))
        silent.push(server)
        urls.push(`nats://127.0.0.1:${port}`)
      }
    })
    afterAll(() => {
      for (const server of silent) server.close()
    })
    afterEach(async () => {
      await h.service.setSetting('testTimeoutMs', null)
    })

    /** Runs a test with a timeout of one second and returns the result with the time it took. */
    const timed = async (
      servers: string[]
    ): Promise<{ result: TestConnectionResult; elapsed: number }> => {
      await h.service.setSetting('testTimeoutMs', 1000)
      const started = Date.now()
      const result = await h.service.testConnection({ ...input, servers })
      return { result, elapsed: Date.now() - started }
    }

    it('gives up after the configured timeout', async () => {
      const { result, elapsed } = await timed([urls[0]])
      expect(result).toMatchObject({ ok: false, kind: 'timeout' })
      expect(elapsed).toBeGreaterThanOrEqual(950)
      expect(elapsed).toBeLessThan(2500)
    })

    it('gives up after the same time when several servers do not answer', async () => {
      // The client dials the servers one after the other and gives each the whole timeout, so
      // without a deadline of its own this test would take three seconds, not one.
      const { result, elapsed } = await timed(urls)
      expect(result).toEqual({
        ok: false,
        kind: 'timeout',
        message: 'Timed out waiting for the server'
      })
      expect(elapsed).toBeGreaterThanOrEqual(950)
      expect(elapsed).toBeLessThan(2500)

      const two = await timed(urls.slice(0, 2))
      expect(two.result).toMatchObject({ ok: false, kind: 'timeout' })
      expect(two.elapsed).toBeLessThan(2000)
    })

    it('uses the nearest limit when the stored timeout is out of range', async () => {
      // Half a second is below the range, so the test waits the minimum of one second.
      await h.service.setSetting('testTimeoutMs', 500)
      const started = Date.now()
      const result = await h.service.testConnection({ ...input, servers: [urls[0]] })
      const elapsed = Date.now() - started
      expect(result).toMatchObject({ ok: false, kind: 'timeout' })
      expect(elapsed).toBeGreaterThanOrEqual(950)
      expect(elapsed).toBeLessThan(2500)
    })

    it('hangs up when a server answers only after the deadline has passed', async () => {
      // A server of its own, so that every connection counted here was made by this test.
      const real = await startNatsServer()
      const sys = await connect({ servers: real.url, user: 'sys', pass: 'sys' })
      /** The connections the studio made to the real server: how many are open, how many closed. */
      const studioConnections = async (): Promise<{ open: number; closed: number }> => {
        const reply = await sys.request(
          '$SYS.REQ.SERVER.PING.CONNZ',
          // state 2 lists closed connections as well as open ones.
          JSON.stringify({ state: 2, limit: 1024 }),
          { timeout: 2000 }
        )
        const all = reply
          .json<{ data: { connections: { name?: string; stop?: string }[] } }>()
          .data.connections.filter((c) => c.name === 'NATS JetStream Studio')
        const closed = all.filter((c) => c.stop).length
        return { open: all.length - closed, closed }
      }
      try {
        // The client chooses the order to dial in. When it starts with the real server the test
        // simply succeeds, so repeat until a run starts with a silent one and times out. With
        // three silent servers that is three runs out of four.
        let succeeded = 0
        let timedOut = false
        for (let run = 0; run < 20 && !timedOut; run++) {
          const { result, elapsed } = await timed([...urls, real.url])
          if (result.ok) {
            succeeded++
            continue
          }
          timedOut = true
          expect(result).toMatchObject({ ok: false, kind: 'timeout' })
          expect(elapsed).toBeLessThan(2500)
        }
        expect(timedOut, 'a run that started with a silent server').toBe(true)

        // Behind the timed-out run the client is still dialling. It reaches the real server after
        // at most two more silent ones, and that late connection has to be closed again: every
        // connection the studio made is closed and none is left open.
        await waitFor(
          async () => {
            const { open, closed } = await studioConnections()
            return open === 0 && closed === succeeded + 1
          },
          10_000,
          'the late connection to be opened and closed again'
        )
      } finally {
        await sys.close()
        await real.stop()
      }
    })
  })

  it('uses the stored secret when testing an existing connection', async () => {
    const saved = await h.service.saveConnection({ ...input, name: 'stored', servers: [h.natsUrl] })
    const result = await h.service.testConnection({
      id: saved.id,
      name: 'stored',
      servers: [h.natsUrl],
      auth: 'userpass',
      user: 'app'
    })
    expect(result.ok).toBe(true)
    await h.service.deleteConnection(saved.id)
  })
})

describe('PBI-011 authentication methods', () => {
  const servers: TestServer[] = []
  afterAll(async () => {
    await Promise.all(servers.map((s) => s.stop()))
  })

  it('connects with a token', async () => {
    const server = await startNatsServer('authorization { token: "tok-abc" }')
    servers.push(server)
    const ok = await h.service.saveConnection({
      name: 'token',
      servers: [server.url],
      auth: 'token',
      token: 'tok-abc'
    })
    expect((await h.service.connect(ok.id)).status).toBe('connected')
    await h.service.deleteConnection(ok.id)
    expect(
      await h.service.testConnection({
        name: 'bad',
        servers: [server.url],
        auth: 'token',
        token: 'nope'
      })
    ).toMatchObject({ ok: false, kind: 'auth' })
  })

  it('connects with an NKey seed typed in or read from a file', async () => {
    const user = createUser()
    const seed = new TextDecoder().decode(user.getSeed())
    const server = await startNatsServer(
      `authorization { users: [ { nkey: ${user.getPublicKey()} } ] }`
    )
    servers.push(server)

    const typed = await h.service.saveConnection({
      name: 'nkey',
      servers: [server.url],
      auth: 'nkey',
      nkeySeed: seed
    })
    expect(typed.storedSecrets).toEqual({ nkeySeed: true })
    expect((await h.service.connect(typed.id)).status).toBe('connected')
    await h.service.deleteConnection(typed.id)

    const seedFile = join(h.dataDir, 'user.nk')
    writeFileSync(seedFile, seed + '\n')
    const fromFile = await h.service.saveConnection({
      name: 'nkey-file',
      servers: [server.url],
      auth: 'nkey',
      nkeyFile: seedFile
    })
    expect((await h.service.connect(fromFile.id)).status).toBe('connected')
    await h.service.deleteConnection(fromFile.id)
  })

  it('explains a credentials file that cannot be read', async () => {
    const saved = await h.service.saveConnection({
      name: 'creds',
      servers: [h.natsUrl],
      auth: 'creds',
      credsFile: '/no/such/file.creds'
    })
    const err = await expectGatewayError(h.service.connect(saved.id), 'validation')
    expect(err.message).toMatch(/Credentials file cannot be read/)
    await h.service.deleteConnection(saved.id)
  })
})

describe('PBI-013 multiple simultaneous connections', () => {
  it('keeps five connections open independently', async () => {
    const ids = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        h.connect({ name: `multi-${i}`, color: '#7c3aed', envLabel: i === 0 ? 'dev' : 'test' })
      )
    )
    let list = await h.service.listConnections()
    for (const id of ids) expect(list.find((c) => c.id === id)!.state.status).toBe('connected')
    expect(list.find((c) => c.id === ids[0])).toMatchObject({ color: '#7c3aed', envLabel: 'dev' })

    // A tail on the connection being closed must stop; the others keep working.
    const received: string[] = []
    const closeTail = h.service.open('tail', { connId: ids[1], subject: 'multi.>' }, (e) => {
      if (e.type === 'messages') received.push(...e.messages.map((m) => m.subject))
    })
    await h.service.disconnect(ids[0])
    list = await h.service.listConnections()
    expect(list.find((c) => c.id === ids[0])!.state.status).toBe('disconnected')
    for (const id of ids.slice(1))
      expect(list.find((c) => c.id === id)!.state.status).toBe('connected')
    await expectGatewayError(h.service.listStreams(ids[0]), 'not_connected')

    await h.service.publish(ids[2], { subject: 'multi.ping', payload: '', mode: 'core' })
    await waitFor(() => received.includes('multi.ping'), 5000, 'message on surviving connection')
    closeTail()
    for (const id of ids) await h.service.deleteConnection(id)
  })

  it('stops subscriptions when a connection is closed', async () => {
    const id = await h.connect()
    const nc = await h.coreClient('sys', 'sys')
    const subsFor = async (): Promise<number> => {
      const reply = await nc.request(
        '$SYS.REQ.SERVER.PING.CONNZ',
        JSON.stringify({ subscriptions: true, limit: 1024 }),
        { timeout: 2000 }
      )
      const conns = reply.json<{
        data: { connections: { name?: string; subscriptions?: number }[] }
      }>().data.connections
      return conns
        .filter((c) => c.name === 'NATS JetStream Studio')
        .reduce((n, c) => n + (c.subscriptions ?? 0), 0)
    }
    const subscribedTo = async (subject: string): Promise<boolean> => {
      const reply = await nc.request(
        '$SYS.REQ.SERVER.PING.CONNZ',
        JSON.stringify({ subscriptions: true, limit: 1024 }),
        { timeout: 2000 }
      )
      const conns = reply.json<{ data: { connections: { subscriptions_list?: string[] }[] } }>()
        .data.connections
      return conns.some((c) => c.subscriptions_list?.includes(subject))
    }
    expect(await subsFor()).toBeGreaterThanOrEqual(0)
    h.service.open('tail', { connId: id, subject: 'leak.check.>' }, () => {})
    await waitFor(() => subscribedTo('leak.check.>'), 5000, 'subscription to appear on the server')
    await h.service.disconnect(id)
    await waitFor(
      async () => !(await subscribedTo('leak.check.>')),
      5000,
      'subscription to go away'
    )
    await h.service.deleteConnection(id)
  })
})

describe('PBI-014 secure secret storage', () => {
  it('encrypts secrets on disk and never returns them', async () => {
    const saved = await h.service.saveConnection({
      name: 'secret',
      servers: [h.natsUrl],
      auth: 'userpass',
      user: 'app',
      password: 'Sup3r-Secret-Pw!'
    })
    const onDisk = readFileSync(join(h.dataDir, 'connections.json'), 'utf8')
    expect(onDisk).not.toContain('Sup3r-Secret-Pw!')
    expect(onDisk).toContain('v1:')
    expect(JSON.stringify(await h.service.listConnections())).not.toContain('Sup3r-Secret-Pw!')
    expect(JSON.stringify(saved)).not.toContain('Sup3r-Secret-Pw!')
    await h.service.deleteConnection(saved.id)
  })

  it('references credential and key files by path without copying them', async () => {
    const creds = join(h.dataDir, 'my.creds')
    writeFileSync(creds, 'FAKE-CREDS-CONTENT')
    const saved = await h.service.saveConnection({
      name: 'paths',
      servers: [h.natsUrl],
      auth: 'creds',
      credsFile: creds,
      tls: { caFile: '/x/ca.pem' }
    })
    expect(saved.credsFile).toBe(creds)
    expect(readFileSync(join(h.dataDir, 'connections.json'), 'utf8')).not.toContain(
      'FAKE-CREDS-CONTENT'
    )
    await h.service.deleteConnection(saved.id)
  })

  it('asks for the secret on every connect when the user chooses not to save it', async () => {
    const saved = await h.service.saveConnection({
      name: 'ask',
      servers: [h.natsUrl],
      auth: 'userpass',
      user: 'app',
      password: 'app',
      saveSecrets: false
    })
    expect(saved.saveSecrets).toBe(false)
    expect(saved.storedSecrets).toEqual({})
    const file = JSON.parse(readFileSync(join(h.dataDir, 'connections.json'), 'utf8'))
    expect(file.connections.find((c: { id: string }) => c.id === saved.id).secrets).toEqual({})

    await expectGatewayError(h.service.connect(saved.id), 'secret_required')
    expect((await h.service.listConnections()).find((c) => c.id === saved.id)!.state.status).toBe(
      'disconnected'
    )
    expect((await h.service.connect(saved.id, { password: 'app' })).status).toBe('connected')
    await h.service.deleteConnection(saved.id)
  })

  it('does not leak the password in connection errors', async () => {
    const saved = await h.service.saveConnection({
      name: 'wrongpw',
      servers: [h.natsUrl],
      auth: 'userpass',
      user: 'app',
      password: 'Wr0ng-But-Secret'
    })
    const err = await expectGatewayError(h.service.connect(saved.id), 'nats')
    expect(err.message).toMatch(/Authentication failed/)
    expect(err.message).not.toContain('Wr0ng-But-Secret')
    const state = (await h.service.listConnections()).find((c) => c.id === saved.id)!.state
    expect(state).toMatchObject({ status: 'error' })
    expect(state.error).not.toContain('Wr0ng-But-Secret')
    await h.service.deleteConnection(saved.id)
  })

  it('reports when no secure storage is available and refuses to store secrets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'studio-nosecret-'))
    const service = new StudioService({
      dataDir: dir,
      secretStore: new NoSecretStore(),
      cliContextDir: join(dir, 'none'),
      mode: 'desktop',
      appVersion: 't',
      natsClientVersion: 't'
    })
    try {
      expect((await service.appInfo()).secretStorage).toBe(false)
      await expect(
        service.saveConnection({
          name: 'x',
          servers: [h.natsUrl],
          auth: 'userpass',
          user: 'app',
          password: 'app'
        })
      ).rejects.toThrow(/not available/)
      const saved = await service.saveConnection({
        name: 'x',
        servers: [h.natsUrl],
        auth: 'userpass',
        user: 'app',
        password: 'app',
        saveSecrets: false
      })
      expect((await service.connect(saved.id, { password: 'app' })).status).toBe('connected')
    } finally {
      await service.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('PBI-015 auto-reconnect and status', () => {
  let server: TestServer
  let id: string
  const states: ConnectionState[] = []
  let closeEvents: () => void

  beforeAll(async () => {
    server = await startNatsServer('authorization { user: u, password: p }')
    closeEvents = h.service.open('events', {}, (e) => {
      if (e.type === 'connection' && e.state.id === id) states.push(e.state)
    })
    const saved = await h.service.saveConnection({
      name: 'reconnect',
      servers: [server.url],
      auth: 'userpass',
      user: 'u',
      password: 'p'
    })
    id = saved.id
    await h.service.connect(id)
  })
  afterAll(async () => {
    closeEvents()
    await h.service.deleteConnection(id)
    await server.stop()
  })
  afterEach(() => {
    states.length = 0
  })

  it('reports connecting then connected with server details', async () => {
    const state = (await h.service.listConnections()).find((c) => c.id === id)!.state
    expect(state).toMatchObject({
      status: 'connected',
      server: `127.0.0.1:${server.port}`,
      reconnects: 0
    })
    expect(state.serverName).toBe(`studio-test-${server.port}`)
    expect(states.map((s) => s.status)).toEqual(['connecting', 'connected'])
  })

  it('reconnects after the server restarts and marks the gap in a live tail', async () => {
    const tail = collect(
      h.service,
      'tail',
      { connId: id, subject: 'gap.>' },
      (events) =>
        events.some(
          (e) => e.type === 'messages' && e.messages.some((m) => m.subject === 'gap.after')
        ),
      20_000
    )
    await new Promise((r) => setTimeout(r, 100))

    await server.kill()
    await waitFor(
      () => states.some((s) => s.status === 'reconnecting'),
      10_000,
      'reconnecting state'
    )
    await expectGatewayError(h.service.serverInfo(id), 'not_connected')

    await server.restart()
    await waitFor(
      () => states.some((s) => s.status === 'connected' && s.reconnects === 1),
      15_000,
      'reconnected state'
    )

    await h.service.publish(id, { subject: 'gap.after', payload: '', mode: 'core' })
    const { events, close } = await tail
    close()
    const types = events.map((e) => e.type)
    expect(types).toContain('gap')
    expect(types.indexOf('gap')).toBeLessThan(types.lastIndexOf('messages'))
    expect((await h.service.serverInfo(id)).serverName).toBe(`studio-test-${server.port}`)
  })
})

describe('PBI-015 authentication failures stop retrying', () => {
  it('ends in an error state with the reason instead of looping', async () => {
    const port = await freePort()
    let server = await startNatsServer('authorization { user: u, password: first }', { port })
    const saved = await h.service.saveConnection({
      name: 'authfail',
      servers: [server.url],
      auth: 'userpass',
      user: 'u',
      password: 'first'
    })
    const states: ConnectionState[] = []
    const close = h.service.open('events', {}, (e) => {
      if (e.type === 'connection' && e.state.id === saved.id) states.push(e.state)
    })
    try {
      await h.service.connect(saved.id)
      await server.stop()
      // The server comes back with a different password, so every reconnect is refused.
      server = await startNatsServer('authorization { user: u, password: second }', { port })
      await waitFor(() => states.some((s) => s.status === 'error'), 25_000, 'error state')
      const final = states[states.length - 1]
      expect(final.status).toBe('error')
      expect(final.error).toMatch(/Authentication failed/)
      const count = states.length
      await new Promise((r) => setTimeout(r, 1500))
      expect(states.length).toBe(count)
      await expectGatewayError(h.service.serverInfo(saved.id), 'not_connected')
    } finally {
      close()
      await h.service.deleteConnection(saved.id)
      await server.stop()
    }
  })
})

describe('PBI-016 read-only mode', () => {
  it('defaults to read-only for production connections only', async () => {
    const prod = await h.service.saveConnection({
      name: 'p',
      servers: [h.natsUrl],
      auth: 'none',
      envLabel: 'Prod'
    })
    const production = await h.service.saveConnection({
      name: 'p2',
      servers: [h.natsUrl],
      auth: 'none',
      envLabel: 'production'
    })
    const dev = await h.service.saveConnection({
      name: 'd',
      servers: [h.natsUrl],
      auth: 'none',
      envLabel: 'dev'
    })
    const optOut = await h.service.saveConnection({
      name: 'p3',
      servers: [h.natsUrl],
      auth: 'none',
      envLabel: 'prod',
      readOnly: false
    })
    expect([prod.readOnly, production.readOnly, dev.readOnly, optOut.readOnly]).toEqual([
      true,
      true,
      false,
      false
    ])
    for (const c of [prod, production, dev, optOut]) await h.service.deleteConnection(c.id)
  })

  it('rejects every mutating call in the gateway, whatever the UI sends', async () => {
    const id = await h.connect({ name: 'ro', readOnly: true })
    const stream = uniqueName('RO')
    const { jsm } = await h.client()
    await jsm.streams.add({ name: stream, subjects: [`${stream}.>`] })

    const attempts: [string, Promise<unknown>][] = [
      ['createStream', h.service.createStream(id, { name: uniqueName('X'), subjects: ['x.ro'] })],
      [
        'updateStream',
        h.service.updateStream(id, stream, { name: stream, subjects: [`${stream}.>`], max_msgs: 5 })
      ],
      ['purgeStream', h.service.purgeStream(id, stream, {})],
      ['deleteStream', h.service.deleteStream(id, stream)],
      ['deleteMessage', h.service.deleteMessage(id, stream, 1, true)],
      [
        'createConsumer',
        h.service.createConsumer(id, stream, { durable_name: 'c', ack_policy: 'explicit' })
      ],
      ['updateConsumer', h.service.updateConsumer(id, stream, 'c', {})],
      ['deleteConsumer', h.service.deleteConsumer(id, stream, 'c')],
      [
        'pauseConsumer',
        h.service.pauseConsumer(id, stream, 'c', new Date(Date.now() + 60_000).toISOString())
      ],
      ['resumeConsumer', h.service.resumeConsumer(id, stream, 'c')],
      ['publish', h.service.publish(id, { subject: `${stream}.a`, payload: '', mode: 'core' })],
      ['request', h.service.request(id, { subject: `${stream}.a`, payload: '', timeoutMs: 200 })],
      ['createKvBucket', h.service.createKvBucket(id, { bucket: 'ro_bucket' })],
      ['deleteKvBucket', h.service.deleteKvBucket(id, 'ro_bucket')],
      ['kvPut', h.service.kvPut(id, 'ro_bucket', 'k', '')],
      ['kvDelete', h.service.kvDelete(id, 'ro_bucket', 'k')],
      ['kvPurge', h.service.kvPurge(id, 'ro_bucket', 'k')],
      ['createObjBucket', h.service.createObjBucket(id, { bucket: 'ro_obj' })],
      ['deleteObjBucket', h.service.deleteObjBucket(id, 'ro_obj')],
      ['objUploadStart', h.service.objUploadStart(id, 'ro_obj', 'file')],
      ['objDelete', h.service.objDelete(id, 'ro_obj', 'file')]
    ]
    for (const [name, attempt] of attempts) {
      const err = await expectGatewayError(attempt, 'read_only')
      expect(err.message, name).toMatch(/read-only/)
    }

    // Nothing changed on the server, and reading still works.
    expect((await jsm.streams.info(stream)).config.max_msgs).toBe(-1)
    expect((await h.service.listStreams(id)).some((s) => s.config.name === stream)).toBe(true)
    const blocked = await h.service.auditList({ connId: id, result: 'blocked' })
    expect(blocked.length).toBe(attempts.length)

    // Turning read-only off applies immediately, without reconnecting.
    const cfg = (await h.service.listConnections()).find((c) => c.id === id)!
    await h.service.saveConnection({
      id,
      name: cfg.name,
      servers: cfg.servers,
      auth: 'userpass',
      user: 'app',
      readOnly: false
    })
    expect((await h.service.listConnections()).find((c) => c.id === id)!.state.status).toBe(
      'connected'
    )
    await h.service.deleteStream(id, stream)
    await h.service.deleteConnection(id)
  })

  it('covers every method declared as mutating', async () => {
    const { MUTATING_METHODS } = await import('@shared/api')
    expect([...MUTATING_METHODS].sort()).toEqual(
      [
        'createConsumer',
        'createKvBucket',
        'createObjBucket',
        'createStream',
        'deleteConsumer',
        'deleteKvBucket',
        'deleteMessage',
        'deleteObjBucket',
        'deleteStream',
        'kvDelete',
        'kvPurge',
        'kvPut',
        'objDelete',
        'objUploadStart',
        'pauseConsumer',
        'publish',
        'purgeStream',
        'request',
        'resumeConsumer',
        'updateConsumer',
        'updateStream'
      ].sort()
    )
  })
})
