import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startNatsServer, type TestServer } from '../helpers/natsServer'
import { createHarness, type Harness } from '../helpers/studio'

/** The certificates are made with openssl; without it these tests are skipped, not failed. */
function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** PBI-011: TLS options, checked against servers with real certificates made for the test. */
describe.skipIf(!hasOpenssl())('PBI-011 TLS connections', () => {
  let h: Harness
  let dir: string
  const servers: TestServer[] = []
  const file = (name: string): string => join(dir, name)
  const openssl = (...args: string[]): void => {
    execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' })
  }

  beforeAll(async () => {
    h = await createHarness()
    dir = mkdtempSync(join(tmpdir(), 'studio-tls-'))
    writeFileSync(file('san.ext'), 'subjectAltName=IP:127.0.0.1,DNS:localhost\n')
    openssl(
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      'ca.key',
      '-out',
      'ca.pem',
      '-subj',
      '/CN=Studio Test CA',
      '-days',
      '2'
    )
    for (const name of ['server', 'client']) {
      openssl(
        'req',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        `${name}.key`,
        '-out',
        `${name}.csr`,
        '-subj',
        `/CN=${name === 'server' ? '127.0.0.1' : 'studio-client'}`
      )
      openssl(
        'x509',
        '-req',
        '-in',
        `${name}.csr`,
        '-CA',
        'ca.pem',
        '-CAkey',
        'ca.key',
        '-CAcreateserial',
        '-out',
        `${name}.pem`,
        '-days',
        '2',
        '-extfile',
        'san.ext'
      )
    }
  }, 60_000)

  afterAll(async () => {
    await h.dispose()
    await Promise.all(servers.map((s) => s.stop()))
    rmSync(dir, { recursive: true, force: true })
  })

  const tlsServer = async (extra = ''): Promise<TestServer> => {
    const server = await startNatsServer(
      `tls { cert_file: "${file('server.pem')}", key_file: "${file('server.key')}", ca_file: "${file('ca.pem')}" ${extra} }`
    )
    servers.push(server)
    return server
  }

  it('connects when the server certificate is signed by the given CA', async () => {
    const server = await tlsServer()
    const url = server.url.replace('nats://', 'tls://')
    const saved = await h.service.saveConnection({
      name: 'tls',
      servers: [url],
      auth: 'none',
      tls: { caFile: file('ca.pem') }
    })
    expect((await h.service.connect(saved.id)).status).toBe('connected')
    expect((await h.service.serverInfo(saved.id)).tls).toBe(true)
    await h.service.deleteConnection(saved.id)

    // Without the CA the certificate cannot be trusted, and the test says it is a TLS problem.
    expect(
      await h.service.testConnection({ name: 'no-ca', servers: [url], auth: 'none' })
    ).toMatchObject({ ok: false, kind: 'tls' })
    expect(
      await h.service.testConnection({
        name: 'with-ca',
        servers: [url],
        auth: 'none',
        tls: { caFile: file('ca.pem') }
      })
    ).toMatchObject({ ok: true })
  })

  it('presents a client certificate when the server demands one', async () => {
    const server = await tlsServer(', verify: true')
    const url = server.url.replace('nats://', 'tls://')
    const withCert = {
      caFile: file('ca.pem'),
      certFile: file('client.pem'),
      keyFile: file('client.key')
    }
    expect(
      await h.service.testConnection({ name: 'mtls', servers: [url], auth: 'none', tls: withCert })
    ).toMatchObject({ ok: true })
    const refused = await h.service.testConnection({
      name: 'no-cert',
      servers: [url],
      auth: 'none',
      tls: { caFile: file('ca.pem') }
    })
    expect(refused.ok).toBe(false)

    const saved = await h.service.saveConnection({
      name: 'mtls',
      servers: [url],
      auth: 'none',
      tls: withCert
    })
    expect((await h.service.connect(saved.id)).status).toBe('connected')
    await h.service.deleteConnection(saved.id)
  })

  it('supports servers that expect the TLS handshake first', async () => {
    const server = await tlsServer(', handshake_first: true')
    const url = server.url.replace('nats://', 'tls://')
    const tls = { caFile: file('ca.pem'), handshakeFirst: true }
    expect(
      await h.service.testConnection({ name: 'first', servers: [url], auth: 'none', tls })
    ).toMatchObject({ ok: true })
    // Without the option the client waits for a greeting that never comes in the clear.
    const plain = await h.service.testConnection({
      name: 'not-first',
      servers: [url],
      auth: 'none',
      tls: { caFile: file('ca.pem') }
    })
    expect(plain.ok).toBe(false)
  })
})
