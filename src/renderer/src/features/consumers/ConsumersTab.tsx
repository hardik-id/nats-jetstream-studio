import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { formatCount } from '@shared/format'
import { Page } from '../../components/ui'
import { useGateway } from '../../gateway'
import { useRefetchInterval } from '../../lib/hooks'
import { ConsumersPanel, consumerTotals } from './ConsumersPanel'

/** Every consumer of the connection, across all streams. */
export function ConsumersTab({ connId }: { connId: string }): ReactNode {
  const gateway = useGateway()
  const refetchInterval = useRefetchInterval()
  // Same key as the panel's query, so this reads the data it has already loaded.
  const query = useQuery({
    queryKey: ['consumers', connId, '*'],
    queryFn: () => gateway.listAllConsumers(connId),
    refetchInterval
  })
  const list = (query.data ?? []).filter(
    (c) => !c.stream_name.startsWith('KV_') && !c.stream_name.startsWith('OBJ_')
  )
  const { attention } = consumerTotals(list)
  const streams = new Set(list.map((c) => c.stream_name)).size
  const subtitle = query.data
    ? `${formatCount(list.length)} ${list.length === 1 ? 'consumer' : 'consumers'} across ${formatCount(streams)} ${streams === 1 ? 'stream' : 'streams'} · ${formatCount(attention)} need attention`
    : undefined
  return (
    <Page scroll={false} title="Consumers" subtitle={subtitle}>
      <ConsumersPanel connId={connId} />
    </Page>
  )
}
