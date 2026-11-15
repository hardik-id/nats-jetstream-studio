import type { ReactNode } from 'react'
import { Page } from '../../components/ui'
import { ConsumersPanel } from './ConsumersPanel'

/** Every consumer of the connection, across all streams. */
export function ConsumersTab({ connId }: { connId: string }): ReactNode {
  return (
    <Page
      scroll={false}
      title="Consumers"
      subtitle="Across all streams. To add a consumer, open its stream."
    >
      <ConsumersPanel connId={connId} />
    </Page>
  )
}
