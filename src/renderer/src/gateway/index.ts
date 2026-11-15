import { createContext, useContext } from 'react'
import type { NatsGateway } from '@shared/api'
import {
  createGatewayClient,
  type ClientMessage,
  type RpcTransport,
  type ServerMessage
} from '@shared/rpc'

export type GatewayStatus = 'ready' | 'connecting' | 'lost' | 'signed-out'

/**
 * Connects the UI to the gateway. In the desktop app that is the preload bridge (Electron IPC);
 * in a browser it is a WebSocket back to the server that served the page.
 */
export function createGateway(onStatus: (status: GatewayStatus) => void): NatsGateway {
  if (window.studioDesktop) {
    onStatus('ready')
    return createGatewayClient(window.studioDesktop)
  }
  return createGatewayClient(webSocketTransport(onStatus))
}

function webSocketTransport(onStatus: (status: GatewayStatus) => void): RpcTransport {
  const handlers = new Set<(message: ServerMessage) => void>()
  const queue: ClientMessage[] = []
  let socket: WebSocket | undefined
  let everOpen = false

  const open = (): void => {
    onStatus(everOpen ? 'lost' : 'connecting')
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/rpc`
    const ws = new WebSocket(url)
    socket = ws
    ws.onopen = () => {
      everOpen = true
      onStatus('ready')
      for (const message of queue.splice(0)) ws.send(JSON.stringify(message))
    }
    ws.onmessage = (event) => {
      let message: ServerMessage
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      for (const handler of handlers) handler(message)
    }
    ws.onclose = () => {
      if (socket !== ws) return
      socket = undefined
      if (everOpen) {
        // In-flight calls and open streams are gone with the socket, so the page must start over.
        onStatus('lost')
        return
      }
      // Never connected: most likely the session expired or the server is restarting.
      fetch('/healthz')
        .then((res) => onStatus(res.ok ? 'signed-out' : 'lost'))
        .catch(() => onStatus('lost'))
    }
  }
  open()

  return {
    send(message) {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
      else if (!everOpen) queue.push(message)
    },
    onMessage(handler) {
      handlers.add(handler)
      return () => handlers.delete(handler)
    }
  }
}

export const GatewayContext = createContext<NatsGateway | null>(null)

export function useGateway(): NatsGateway {
  const gateway = useContext(GatewayContext)
  if (!gateway) throw new Error('GatewayContext is missing')
  return gateway
}
