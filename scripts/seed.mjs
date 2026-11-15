// Fills a NATS server with demo data, and optionally keeps traffic flowing.
//
//   npm run seed                 create streams, consumers, KV and object buckets, publish history
//   npm run traffic              the same, then keep publishing and consuming until Ctrl+C
//   NATS_URL=nats://host:4222 NATS_USER=app NATS_PASS=app npm run seed
//
// What it creates:
//   ORDERS     limits stream, JSON orders on orders.<region>.<event>, three consumers
//                (billing keeps up, shipping is slow and falls behind, audit never acks -> redeliveries)
//   EVENTS     interest stream with mixed JSON and plain-text payloads
//   JOBS       work-queue stream with one worker
//   TELEMETRY  memory stream of small binary readings
//   KV app-config, KV feature-flags, Object Store "artifacts"
//   a responder on "svc.echo" and "svc.time" for trying request/reply
import { connect, headers } from '@nats-io/transport-node'
import { jetstream, jetstreamManager } from '@nats-io/jetstream'
import { Kvm } from '@nats-io/kv'
import { Objm } from '@nats-io/obj'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const REGIONS = ['eu', 'us', 'apac']
const EVENTS = ['created', 'paid', 'shipped', 'cancelled']
const pick = (list) => list[Math.floor(Math.random() * list.length)]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let orderId = 1000
function order() {
  const region = pick(REGIONS)
  const event = pick(EVENTS)
  const id = `ORD-${orderId++}`
  const hdrs = headers()
  hdrs.set('Trace-Id', Math.random().toString(16).slice(2, 14))
  hdrs.set('Content-Type', 'application/json')
  hdrs.set('Region', region)
  const body = {
    order: {
      id,
      total: Math.round(Math.random() * 50000) / 100,
      currency: region === 'eu' ? 'EUR' : 'USD',
      items: 1 + Math.floor(Math.random() * 5)
    },
    customer: {
      id: `C-${Math.floor(Math.random() * 500)}`,
      email: `user${Math.floor(Math.random() * 500)}@example.com`
    },
    event,
    tags: Math.random() < 0.1 ? ['urgent'] : []
  }
  return { subject: `orders.${region}.${event}`, body: JSON.stringify(body), hdrs }
}

async function ensureStream(jsm, config) {
  try {
    await jsm.streams.info(config.name)
    await jsm.streams.update(config.name, config).catch(() => {})
  } catch {
    await jsm.streams.add(config)
  }
}

async function ensureConsumer(jsm, stream, config) {
  try {
    await jsm.consumers.info(stream, config.durable_name)
  } catch {
    await jsm.consumers.add(stream, config)
  }
}

export async function seed(opts = {}) {
  const url = opts.url ?? process.env.NATS_URL ?? 'nats://127.0.0.1:4222'
  const user = opts.user ?? process.env.NATS_USER ?? 'app'
  const pass = opts.pass ?? process.env.NATS_PASS ?? 'app'
  const history = opts.history ?? Number(process.env.SEED_MESSAGES ?? 500)
  const log = opts.quiet ? () => {} : console.log

  const nc = await connect({ servers: url, user, pass, name: 'studio-seed' })
  const jsm = await jetstreamManager(nc)
  const js = jetstream(nc)

  await ensureStream(jsm, {
    name: 'ORDERS',
    description: 'Customer orders',
    subjects: ['orders.>'],
    max_msgs: 200000,
    max_age: 7 * 24 * 3600e9,
    duplicate_window: 120e9,
    allow_direct: true
  })
  await ensureStream(jsm, {
    name: 'EVENTS',
    description: 'Application events',
    subjects: ['events.>'],
    retention: 'interest',
    max_msgs: 50000
  })
  await ensureStream(jsm, {
    name: 'JOBS',
    description: 'Background jobs',
    subjects: ['jobs.>'],
    retention: 'workqueue'
  })
  await ensureStream(jsm, {
    name: 'TELEMETRY',
    description: 'Device readings',
    subjects: ['telemetry.>'],
    storage: 'memory',
    max_msgs_per_subject: 100,
    max_bytes: 16 * 1024 * 1024,
    discard: 'old'
  })

  await ensureConsumer(jsm, 'ORDERS', {
    durable_name: 'billing',
    description: 'Charges paid orders',
    ack_policy: 'explicit',
    filter_subject: 'orders.*.paid'
  })
  await ensureConsumer(jsm, 'ORDERS', {
    durable_name: 'shipping',
    description: 'Slow on purpose',
    ack_policy: 'explicit',
    filter_subjects: ['orders.*.paid', 'orders.*.shipped'],
    max_ack_pending: 50
  })
  await ensureConsumer(jsm, 'ORDERS', {
    durable_name: 'audit',
    description: 'Never acknowledges',
    ack_policy: 'explicit',
    ack_wait: 2e9,
    max_deliver: 20,
    max_ack_pending: 20
  })
  await ensureConsumer(jsm, 'EVENTS', { durable_name: 'analytics', ack_policy: 'explicit' })
  await ensureConsumer(jsm, 'JOBS', {
    durable_name: 'worker',
    ack_policy: 'explicit',
    ack_wait: 10e9
  })

  const kvm = new Kvm(js)
  const config = await kvm.create('app-config', {
    history: 10,
    description: 'Service configuration'
  })
  await config.put('db.host', 'db.internal')
  await config.put('db.port', '5432')
  await config.put('cache.ttl', '30s')
  await config.put('cache.ttl', '60s')
  await config.put('service.limits', JSON.stringify({ rps: 250, burst: 500 }))
  const flags = await kvm.create('feature-flags', { history: 5, description: 'Feature switches' })
  for (const [key, value] of [
    ['checkout.v2', 'true'],
    ['search.fuzzy', 'false'],
    ['beta.dashboard', 'true']
  ])
    await flags.put(key, value)

  const objm = new Objm(js)
  const artifacts = await objm.create('artifacts', { description: 'Build artifacts and reports' })
  await artifacts.putBlob(
    { name: 'README.txt', description: 'Plain text' },
    new TextEncoder().encode('Demo object stored by the seed script.\n')
  )
  await artifacts.putBlob(
    { name: 'reports/summary.json', description: 'JSON report' },
    new TextEncoder().encode(
      JSON.stringify({ generated: new Date().toISOString(), orders: history }, null, 2)
    )
  )
  await artifacts.putBlob(
    { name: 'data/blob.bin', description: 'Binary data' },
    new Uint8Array(randomBytes(300_000))
  )

  const state = (await jsm.streams.info('ORDERS')).state
  if (state.messages < history) {
    const acks = []
    for (let i = state.messages; i < history; i++) {
      const o = order()
      acks.push(js.publish(o.subject, o.body, { headers: o.hdrs }))
      if (acks.length >= 200) await Promise.all(acks.splice(0))
    }
    await Promise.all(acks)
  }
  for (let i = 0; i < 40; i++) {
    await js
      .publish(
        `events.${pick(['login', 'logout', 'signup'])}`,
        i % 4 === 0 ? `plain text event ${i}` : JSON.stringify({ user: `u${i}`, ok: i % 7 !== 0 })
      )
      .catch(() => {})
    await js.publish(
      `jobs.${pick(['email', 'resize', 'export'])}`,
      JSON.stringify({ job: i, attempts: 0 })
    )
  }
  for (let i = 0; i < 60; i++)
    nc.publish(
      `telemetry.device${i % 6}.temp`,
      new Uint8Array([i, 20 + (i % 15), 0xff, 0x00, i * 3])
    )
  await nc.flush()

  log(
    `Seeded ${url}: streams ORDERS, EVENTS, JOBS, TELEMETRY; KV app-config, feature-flags; Object Store artifacts`
  )
  return { nc, jsm, js }
}

/** Keeps publishing and consuming so the studio has live data to show. Returns a stop function. */
export function startTraffic({ nc, js }, opts = {}) {
  const rate = opts.rate ?? Number(process.env.TRAFFIC_RATE ?? 20)
  let running = true
  const loops = []

  const responders = [
    nc.subscribe('svc.echo', { callback: (_e, m) => m.respond(m.data, { headers: m.headers }) }),
    nc.subscribe('svc.time', {
      callback: (_e, m) => m.respond(JSON.stringify({ now: new Date().toISOString() }))
    })
  ]

  loops.push(
    (async () => {
      while (running) {
        const o = order()
        js.publish(o.subject, o.body, { headers: o.hdrs }).catch(() => {})
        if (Math.random() < 0.3)
          js.publish(
            `events.${pick(['login', 'logout', 'signup', 'error'])}`,
            JSON.stringify({ user: `u${Math.floor(Math.random() * 99)}`, at: Date.now() })
          ).catch(() => {})
        if (Math.random() < 0.2)
          js.publish(
            `jobs.${pick(['email', 'resize', 'export'])}`,
            JSON.stringify({ job: orderId })
          ).catch(() => {})
        nc.publish(
          `telemetry.device${Math.floor(Math.random() * 6)}.temp`,
          new Uint8Array([orderId & 0xff, 20 + Math.floor(Math.random() * 15)])
        )
        nc.publish(
          `metrics.cpu.host${Math.floor(Math.random() * 3)}`,
          JSON.stringify({ pct: Math.round(Math.random() * 100) })
        )
        await sleep(1000 / rate)
      }
    })()
  )

  const consume = async (stream, name, { ack = true, delayMs = 0, batch = 20 } = {}) => {
    while (running) {
      try {
        const consumer = await js.consumers.get(stream, name)
        const msgs = await consumer.fetch({ max_messages: batch, expires: 1000 })
        for await (const m of msgs) {
          if (delayMs) await sleep(delayMs)
          if (ack) m.ack()
        }
      } catch {
        await sleep(500)
      }
    }
  }
  loops.push(consume('ORDERS', 'billing'))
  loops.push(consume('ORDERS', 'shipping', { delayMs: 400, batch: 5 }))
  loops.push(consume('ORDERS', 'audit', { ack: false, batch: 5 }))
  loops.push(consume('EVENTS', 'analytics'))
  loops.push(consume('JOBS', 'worker', { delayMs: 50 }))

  return async () => {
    running = false
    for (const sub of responders) sub.unsubscribe()
    await Promise.allSettled(loops)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const handles = await seed()
  if (process.argv.includes('--traffic')) {
    const stop = startTraffic(handles)
    console.log('Publishing and consuming. Press Ctrl+C to stop.')
    process.on('SIGINT', async () => {
      await stop()
      await handles.nc.close()
      process.exit(0)
    })
  } else {
    await handles.nc.close()
  }
}
