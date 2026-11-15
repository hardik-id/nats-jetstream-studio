import { useEffect, useRef, type ReactNode } from 'react'
import { Plug } from 'lucide-react'
import { Button, EmptyState, Notice, Spinner } from '../../components/ui'
import { useConnectActions } from '../../lib/connect'
import { useConnection, useConnections, useTabActive } from '../../lib/hooks'
import { useTabs } from '../../state/tabs'

/**
 * Shows a tab's content only while its connection is usable. A restored tab whose connection is
 * closed connects by itself the first time it is shown (PBI-093).
 */
export function ConnectionGate({
  connId,
  tabId,
  children
}: {
  connId: string
  tabId: string
  children: ReactNode
}): ReactNode {
  const { isLoading } = useConnections()
  const conn = useConnection(connId)
  const active = useTabActive()
  const { connect } = useConnectActions()
  const close = useTabs((s) => s.close)
  const tried = useRef(false)
  const status = conn?.state.status

  useEffect(() => {
    if (active && status === 'disconnected' && !tried.current) {
      tried.current = true
      void connect(connId)
    }
  }, [active, status, connId, connect])

  if (isLoading)
    return (
      <div className="p-6">
        <Spinner />
      </div>
    )
  if (!conn) {
    return (
      <EmptyState title="This connection no longer exists">
        <Button onClick={() => close(tabId)}>Close tab</Button>
      </EmptyState>
    )
  }
  if (status === 'connecting')
    return (
      <div className="p-6">
        <Spinner label={`Connecting to ${conn.name}`} />
      </div>
    )
  if (status === 'disconnected' || status === 'error') {
    return (
      <EmptyState
        title={
          status === 'error' ? `Cannot connect to ${conn.name}` : `Not connected to ${conn.name}`
        }
        icon={<Plug className="h-8 w-8" aria-hidden />}
      >
        {status === 'error' && <p className="mb-3 text-danger">{conn.state.error}</p>}
        <Button variant="primary" onClick={() => void connect(connId)}>
          Connect
        </Button>
      </EmptyState>
    )
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      {status === 'reconnecting' && (
        <Notice tone="warn" className="m-2 shrink-0">
          The connection to {conn.name} was lost. Reconnecting... Data on this tab may be out of
          date.
        </Notice>
      )}
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  )
}
