import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GatewayError } from '@shared/api'
import { startNatsServer, type TestServer } from '../helpers/natsServer'
import { createHarness, uniqueName, type Harness } from '../helpers/studio'

let h: Harness
let app: string
beforeAll(async () => {
  h = await createHarness()
  app = await h.connect({ name: 'overview' })
})
afterAll(async () => {
  await h.dispose()
})

describe('PBI-020 server info', () => {
  it('shows what the server reports', async () => {
    const info = await h.service.serverInfo(app)
    const port = Number(new URL(h.natsUrl.replace('nats://', 'http://')).port)
    expect(info).toMatchObject({
      serverName: `studio-test-${port}`,
      connectedUrl: `127.0.0.1:${port}`,
      port,
      tls: false,
      jetstream: true,
      user: 'app',
      account: 'APP'
    })
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(info.maxPayload).toBeGreaterThan(0)
    expect(info.serverId).toMatch(/^N[A-Z0-9]+$/)
    expect(info.rttMs).toBeGreaterThanOrEqual(0)
    expect(info.clientId).toBeGreaterThan(0)
  })

  it('reports the JetStream domain when the server has one', async () => {
    const server: TestServer = await startNatsServer('', { jetstreamExtra: ', domain: "hub"' })
    try {
      const saved = await h.service.saveConnection({
        name: 'clustered',
        servers: [server.url],
        auth: 'none'
      })
      await h.service.connect(saved.id)
      const info = await h.service.serverInfo(saved.id)
      expect(info.cluster).toBeUndefined()
      expect(info.jsDomain).toBe('hub')
      await h.service.deleteConnection(saved.id)
    } finally {
      await server.stop()
    }
  })
})

describe('PBI-021 JetStream account overview', () => {
  it('shows usage against limits and API counters', async () => {
    const { jsm, js } = await h.client()
    const stream = uniqueName('ACC')
    await jsm.streams.add({ name: stream, subjects: [`${stream}.>`] })
    await js.publish(`${stream}.a`, 'hello')
    await jsm.consumers.add(stream, { durable_name: 'c1' })

    const view = await h.service.accountInfo(app)
    expect(view.enabled).toBe(true)
    if (!view.enabled) return
    expect(view.stats.streams).toBeGreaterThanOrEqual(1)
    expect(view.stats.consumers).toBeGreaterThanOrEqual(1)
    expect(view.stats.storage).toBeGreaterThan(0)
    expect(view.stats.limits).toMatchObject({
      max_memory: expect.any(Number),
      max_storage: expect.any(Number),
      max_streams: expect.any(Number),
      max_consumers: expect.any(Number)
    })
    expect(view.stats.api.total).toBeGreaterThan(0)
    expect(view.stats.api.errors).toBeGreaterThanOrEqual(0)

    // API errors are counted by the server, so a failed call shows up here.
    await expect(jsm.streams.info('NO_SUCH_STREAM')).rejects.toThrow()
    const after = await h.service.accountInfo(app)
    if (after.enabled) expect(after.stats.api.errors).toBeGreaterThan(view.stats.api.errors)
    await jsm.streams.delete(stream)
  })

  it('says JetStream is not enabled instead of failing', async () => {
    const id = await h.connect({ name: 'nojs', user: 'nojs', password: 'nojs' })
    const view = await h.service.accountInfo(id)
    expect(view).toEqual({ enabled: false, reason: 'JetStream is not enabled for this account.' })
    // Everything else that needs JetStream reports a clear error rather than hanging.
    const err = await h.service.listStreams(id).catch((e) => e)
    expect(err).toBeInstanceOf(GatewayError)
    expect(err.message).toMatch(/JetStream/i)
    await h.service.deleteConnection(id)
  })

  it('reports account limits when the account is restricted', async () => {
    const server = await startNatsServer(`
      accounts {
        A { jetstream: { max_mem: 10M, max_file: 50M, max_streams: 3, max_consumers: 7 }, users: [ { user: a, password: a } ] }
      }`)
    try {
      const saved = await h.service.saveConnection({
        name: 'limited-acct',
        servers: [server.url],
        auth: 'userpass',
        user: 'a',
        password: 'a'
      })
      await h.service.connect(saved.id)
      const view = await h.service.accountInfo(saved.id)
      expect(view.enabled).toBe(true)
      if (view.enabled) {
        expect(view.stats.limits).toMatchObject({
          max_memory: 10_000_000,
          max_storage: 50_000_000,
          max_streams: 3,
          max_consumers: 7
        })
      }
      await h.service.deleteConnection(saved.id)
    } finally {
      await server.stop()
    }
  })
})

describe('PBI-022 cluster topology', () => {
  it('lists servers with JetStream usage for a system-account user', async () => {
    const sys = await h.connect({ name: 'sys', user: 'sys', password: 'sys' })
    const view = await h.service.clusterInfo(sys)
    expect(view.available).toBe(true)
    expect(view.servers).toHaveLength(1)
    const server = view.servers[0]
    expect(server.name).toMatch(/^studio-test-/)
    expect(server.version).toMatch(/^\d+\.\d+/)
    expect(server.connections).toBeGreaterThanOrEqual(1)
    expect(server.cores).toBeGreaterThan(0)
    expect(server.mem).toBeGreaterThan(0)
    expect(server.jetstream).toMatchObject({
      streams: expect.any(Number),
      consumers: expect.any(Number),
      apiTotal: expect.any(Number)
    })
    await h.service.deleteConnection(sys)
  })

  it('explains what is needed when the user is not in the system account', async () => {
    const view = await h.service.clusterInfo(app)
    expect(view.available).toBe(false)
    expect(view.servers).toEqual([])
    expect(view.reason).toMatch(/system account/)
  })
})

describe('PBI-022 cluster topology on a real three-node cluster', () => {
  const servers: TestServer[] = []
  let sys: string

  beforeAll(async () => {
    const { freePort } = await import('../helpers/natsServer')
    const ports = [await freePort(), await freePort(), await freePort()]
    const routes = ports.map((p) => `nats://127.0.0.1:${p}`).join(', ')
    for (let i = 0; i < 3; i++) {
      servers.push(
        await startNatsServer(`
          cluster { name: "tri", listen: "127.0.0.1:${ports[i]}", routes: [${routes}] }
          accounts {
            SYS { users: [ { user: sys, password: sys } ] }
            APP { jetstream: enabled, users: [ { user: app, password: app } ] }
          }
          system_account: SYS`)
      )
    }
    const saved = await h.service.saveConnection({
      name: 'tri-sys',
      servers: servers.map((s) => s.url),
      auth: 'userpass',
      user: 'sys',
      password: 'sys'
    })
    sys = saved.id
    await h.service.connect(sys)
  }, 60_000)

  afterAll(async () => {
    await h.service.deleteConnection(sys)
    await Promise.all(servers.map((s) => s.stop()))
  })

  it('shows every server, its routes and the JetStream meta leader', async () => {
    let view = await h.service.clusterInfo(sys)
    // The meta group needs a moment to elect a leader and to list its peers after start-up; wait
    // for everything asserted below, not only for the leader (a slow runner showed one replica).
    const settled = (): boolean =>
      view.servers.length === 3 && !!view.meta?.leader && view.meta.replicas.length === 2
    for (let i = 0; i < 40 && !settled(); i++) {
      await new Promise((r) => setTimeout(r, 500))
      view = await h.service.clusterInfo(sys)
    }
    expect(view.available).toBe(true)
    expect(view.servers).toHaveLength(3)
    expect(view.servers.every((s) => s.cluster === 'tri')).toBe(true)
    for (const s of view.servers) expect(s.routes.length).toBeGreaterThanOrEqual(2)
    expect(view.meta?.leader).toBeTruthy()
    expect(view.servers.map((s) => s.name)).toContain(view.meta!.leader)
    expect(view.meta!.clusterSize).toBe(3)
    expect(view.meta!.replicas).toHaveLength(2)
    expect((await h.service.serverInfo(sys)).cluster).toBe('tri')
  }, 60_000)

  it('shows the leader and replica state of a replicated stream', async () => {
    const saved = await h.service.saveConnection({
      name: 'tri-app',
      servers: servers.map((s) => s.url),
      auth: 'userpass',
      user: 'app',
      password: 'app'
    })
    await h.service.connect(saved.id)
    const name = uniqueName('R3')
    let info = await h.service.createStream(saved.id, {
      name,
      subjects: [`${name}.>`],
      num_replicas: 3
    })
    for (
      let i = 0;
      i < 40 && !(info.cluster?.leader && info.cluster.replicas?.every((r) => r.current));
      i++
    ) {
      await new Promise((r) => setTimeout(r, 250))
      info = await h.service.streamInfo(saved.id, name)
    }
    expect(info.cluster?.name).toBe('tri')
    expect(info.cluster?.leader).toBeTruthy()
    expect(info.cluster?.replicas).toHaveLength(2)
    expect(info.cluster!.replicas!.every((r) => r.current && !r.offline)).toBe(true)
    await h.service.deleteConnection(saved.id)
  }, 60_000)
})
