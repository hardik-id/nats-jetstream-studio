import {
  GatewayError,
  GATEWAY_METHODS,
  type GatewayErrorData,
  type GatewayStreams,
  type NatsGateway,
  type StreamChannel
} from './api'

/**
 * The wire protocol between the UI and the gateway. The same messages travel over Electron IPC
 * (desktop) and over a WebSocket (web mode), so the UI code is identical in both.
 */
export type ClientMessage =
  | { t: 'call'; id: number; method: string; args: unknown[] }
  | { t: 'open'; id: number; channel: string; args: unknown }
  | { t: 'close'; id: number }

export type ServerMessage =
  | { t: 'result'; id: number; ok: true; value: unknown }
  | { t: 'result'; id: number; ok: false; error: GatewayErrorData }
  | { t: 'event'; id: number; event: unknown }

export interface RpcTransport {
  send(message: ClientMessage): void
  /** Registers the handler for incoming messages. Returns a function that removes it. */
  onMessage(handler: (message: ServerMessage) => void): () => void
}

/** Builds a typed `NatsGateway` on top of a message transport. */
export function createGatewayClient(transport: RpcTransport): NatsGateway & { dispose(): void } {
  let nextId = 1
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  const streams = new Map<number, (event: unknown) => void>()

  const off = transport.onMessage((message) => {
    if (message.t === 'result') {
      const call = pending.get(message.id)
      if (!call) return
      pending.delete(message.id)
      if (message.ok) call.resolve(message.value)
      else call.reject(new GatewayError(message.error))
    } else if (message.t === 'event') {
      streams.get(message.id)?.(message.event)
    }
  })

  const gateway: Record<string, unknown> = {
    open<K extends StreamChannel>(
      channel: K,
      args: GatewayStreams[K]['args'],
      onEvent: (event: GatewayStreams[K]['event']) => void
    ): () => void {
      const id = nextId++
      streams.set(id, onEvent as (event: unknown) => void)
      transport.send({ t: 'open', id, channel, args })
      let closed = false
      return () => {
        if (closed) return
        closed = true
        streams.delete(id)
        transport.send({ t: 'close', id })
      }
    },
    dispose(): void {
      off()
      for (const call of pending.values())
        call.reject(
          new GatewayError({ kind: 'not_connected', message: 'The gateway connection was closed' })
        )
      pending.clear()
      streams.clear()
    }
  }
  for (const method of GATEWAY_METHODS) {
    gateway[method] = (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        const id = nextId++
        pending.set(id, { resolve, reject })
        try {
          transport.send({ t: 'call', id, method, args })
        } catch (err) {
          pending.delete(id)
          reject(err as Error)
        }
      })
  }
  return gateway as unknown as NatsGateway & { dispose(): void }
}
