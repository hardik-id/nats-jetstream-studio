import { STREAM_CHANNELS, type StreamChannel } from '@shared/api'
import type { ClientMessage, ServerMessage } from '@shared/rpc'
import { runAs, type RequestUser } from './context'
import { gatewayError, toGatewayError } from './errors'
import type { StudioService } from './service'

const CHANNELS = new Set<string>(STREAM_CHANNELS)
const MAX_OPEN_STREAMS = 200

/**
 * One UI client (a window or a browser tab) talking to the service.
 * Keeps track of the streams that client opened so they are all closed when it goes away.
 */
export class RpcSession {
  private readonly streams = new Map<number, () => void>()
  private disposed = false

  constructor(
    private readonly service: StudioService,
    private readonly send: (message: ServerMessage) => void,
    private readonly user?: RequestUser
  ) {}

  handle(message: ClientMessage): void {
    if (this.disposed || typeof message !== 'object' || message === null) return
    switch (message.t) {
      case 'call':
        void this.call(message.id, message.method, message.args)
        break
      case 'open':
        this.open(message.id, message.channel, message.args)
        break
      case 'close':
        this.streams.get(message.id)?.()
        this.streams.delete(message.id)
        break
    }
  }

  private async call(id: number, method: string, args: unknown[]): Promise<void> {
    try {
      const value = await runAs(this.user, () =>
        this.service.invoke(String(method), Array.isArray(args) ? args : [])
      )
      this.reply({ t: 'result', id, ok: true, value: value === undefined ? null : value })
    } catch (err) {
      this.reply({ t: 'result', id, ok: false, error: toGatewayError(err).toJSON() })
    }
  }

  private open(id: number, channel: string, args: unknown): void {
    try {
      if (!CHANNELS.has(channel))
        throw gatewayError('internal', `Unknown stream channel "${channel}"`)
      if (this.streams.has(id)) throw gatewayError('internal', 'Stream id is already in use')
      if (this.streams.size >= MAX_OPEN_STREAMS)
        throw gatewayError('internal', 'Too many open streams')
      const close = this.service.open(channel as StreamChannel, (args ?? {}) as never, (event) =>
        this.reply({ t: 'event', id, event })
      )
      this.streams.set(id, close)
    } catch (err) {
      // Streams report failures as events, so the UI has one place to handle them.
      this.reply({ t: 'event', id, event: { type: 'error', error: toGatewayError(err).toJSON() } })
    }
  }

  private reply(message: ServerMessage): void {
    if (this.disposed) return
    try {
      this.send(message)
    } catch {
      // The window or socket is gone; dispose() will follow.
    }
  }

  dispose(): void {
    this.disposed = true
    for (const close of this.streams.values()) close()
    this.streams.clear()
  }
}
