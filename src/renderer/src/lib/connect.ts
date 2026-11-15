import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { GatewayError, type ConnectSecrets } from '@shared/api'
import { useGateway } from '../gateway'
import { toast } from '../state/toasts'
import { useOverlays } from '../state/ui'

/** Connect and disconnect, including asking for a secret that is not stored. */
export function useConnectActions(): {
  connect: (id: string, secrets?: ConnectSecrets) => Promise<boolean>
  disconnect: (id: string) => Promise<void>
} {
  const gateway = useGateway()
  const client = useQueryClient()

  const connect = useCallback(
    async (id: string, secrets?: ConnectSecrets): Promise<boolean> => {
      try {
        await gateway.connect(id, secrets)
        return true
      } catch (err) {
        if (err instanceof GatewayError && err.kind === 'secret_required') {
          useOverlays.getState().set({ secretPrompt: id })
          return false
        }
        // The connection row shows the reason; a toast makes sure it is not missed.
        toast.error(err)
        return false
      }
    },
    [gateway]
  )

  const disconnect = useCallback(
    async (id: string): Promise<void> => {
      try {
        await gateway.disconnect(id)
        // Cached data from a closed connection must not be shown as if it were live.
        client.removeQueries({
          predicate: (q) => q.queryKey[1] === id && q.queryKey[0] !== 'setting'
        })
      } catch (err) {
        toast.error(err)
      }
    },
    [gateway, client]
  )

  return { connect, disconnect }
}
