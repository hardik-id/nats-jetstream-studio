import type { NatsConnection } from '@nats-io/nats-core'
import type { ClusterServerView, ClusterView, PeerInfoDto } from '@shared/api'
import { toGatewayError } from './errors'

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Sends one request to every server through the system account and collects the answers. */
async function pingAll(nc: NatsConnection, subject: string, maxWaitMs: number): Promise<any[]> {
  const replies: any[] = []
  const iter = await nc.requestMany(subject, '', {
    strategy: 'stall',
    maxWait: maxWaitMs,
    stall: 300
  })
  for await (const msg of iter) {
    try {
      replies.push(msg.json())
    } catch {
      // Ignore anything that is not JSON.
    }
  }
  return replies
}

const NO_ACCESS =
  'Cluster details need a user in the system account. Connect with a system-account user to see servers, routes and the JetStream meta leader.'

/**
 * Reads cluster topology from the `$SYS` monitoring subjects (PBI-022).
 * These only answer for users of the system account; anyone else gets `available: false`.
 */
export async function readClusterInfo(nc: NatsConnection, maxWaitMs = 1500): Promise<ClusterView> {
  let stats: any[]
  let varz: any[]
  let jsz: any[]
  try {
    ;[stats, varz, jsz] = await Promise.all([
      pingAll(nc, '$SYS.REQ.SERVER.PING', maxWaitMs),
      pingAll(nc, '$SYS.REQ.SERVER.PING.VARZ', maxWaitMs),
      pingAll(nc, '$SYS.REQ.SERVER.PING.JSZ', maxWaitMs)
    ])
  } catch (err) {
    const ge = toGatewayError(err)
    if (ge.kind === 'permission' || ge.kind === 'no_responders' || ge.kind === 'timeout') {
      return { available: false, reason: NO_ACCESS, servers: [] }
    }
    throw ge
  }
  if (stats.length === 0) return { available: false, reason: NO_ACCESS, servers: [] }

  const varzById = new Map<string, any>()
  for (const reply of varz) if (reply?.server?.id) varzById.set(reply.server.id, reply.data ?? {})
  const jszById = new Map<string, any>()
  for (const reply of jsz) if (reply?.server?.id) jszById.set(reply.server.id, reply.data ?? {})

  let meta: ClusterView['meta']
  const servers: ClusterServerView[] = stats.map((reply) => {
    const server = reply.server ?? {}
    const s = reply.statsz ?? {}
    const v = varzById.get(server.id) ?? {}
    const j = jszById.get(server.id)
    if (j?.meta_cluster && (!meta || j.meta_cluster.leader)) {
      const replicas: PeerInfoDto[] = (j.meta_cluster.replicas ?? []).map((r: any) => ({
        name: r.name,
        current: !!r.current,
        offline: !!r.offline,
        active: r.active ?? 0,
        lag: r.lag
      }))
      meta = {
        name: j.meta_cluster.name,
        leader: j.meta_cluster.leader,
        clusterSize: j.meta_cluster.cluster_size,
        replicas
      }
    }
    return {
      name: server.name ?? server.id ?? 'unknown',
      id: server.id ?? '',
      host: server.host,
      version: server.ver ?? v.version ?? '',
      cluster: server.cluster,
      connections: s.connections ?? v.connections ?? 0,
      subscriptions: s.subscriptions ?? v.subscriptions ?? 0,
      cpu: s.cpu ?? v.cpu ?? 0,
      mem: s.mem ?? v.mem ?? 0,
      cores: s.cores ?? v.cores ?? 0,
      slowConsumers: s.slow_consumers ?? v.slow_consumers ?? 0,
      start: s.start ?? v.start,
      routes: (s.routes ?? []).map((r: any) => ({
        name: r.name ?? '',
        rid: r.rid ?? 0,
        pending: r.pending ?? 0
      })),
      gateways: (s.gateways ?? []).map((g: any) => ({
        name: g.name ?? '',
        inbound: g.inbound_connections ?? 0
      })),
      leafnodes: v.leafnodes ?? 0,
      jetstream: j
        ? {
            streams: j.streams ?? 0,
            consumers: j.consumers ?? 0,
            messages: j.messages ?? 0,
            bytes: j.bytes ?? 0,
            memoryUsed: j.memory ?? 0,
            storageUsed: j.storage ?? 0,
            apiTotal: j.api?.total ?? 0,
            apiErrors: j.api?.errors ?? 0
          }
        : undefined
    }
  })
  servers.sort((a, b) => a.name.localeCompare(b.name))
  return { available: true, servers, meta }
}
