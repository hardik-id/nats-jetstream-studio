import { type ReactNode } from 'react'
import { Database, Plus } from 'lucide-react'
import { Button, EmptyState, Kbd } from '../../components/ui'
import { TabActiveContext, useAppInfo, useConnections } from '../../lib/hooks'
import { useTabs, type Tab } from '../../state/tabs'
import { useOverlays } from '../../state/ui'
import { AlertsTab } from '../monitoring/AlertsTab'
import { AuditTab } from '../audit/AuditTab'
import { ConsumerTab } from '../consumers/ConsumerTab'
import { ConsumersTab } from '../consumers/ConsumersTab'
import { DecodersTab } from '../decoders/DecodersTab'
import { KvBucketTab } from '../kv/KvBucketTab'
import { KvTab } from '../kv/KvTab'
import { MessagesTab } from '../messages/MessagesTab'
import { ObjBucketTab } from '../objects/ObjBucketTab'
import { ObjectsTab } from '../objects/ObjectsTab'
import { OverviewTab } from '../overview/OverviewTab'
import { PublishTab } from '../publish/PublishTab'
import { StreamTab } from '../streams/StreamTab'
import { StreamsTab } from '../streams/StreamsTab'
import { SubjectsTab } from '../subjects/SubjectsTab'
import { TailTab } from '../tail/TailTab'
import { TraceTab } from '../trace/TraceTab'
import { ConnectionGate } from './ConnectionGate'

function content(tab: Tab): ReactNode {
  const spec = tab.spec
  switch (spec.kind) {
    case 'overview':
      return <OverviewTab connId={spec.connId} />
    case 'streams':
      return <StreamsTab connId={spec.connId} />
    case 'stream':
      return (
        <StreamTab
          tabId={tab.id}
          connId={spec.connId}
          stream={spec.stream}
          section={spec.section}
        />
      )
    case 'messages':
      return (
        <MessagesTab
          tabId={tab.id}
          connId={spec.connId}
          stream={spec.stream}
          subject={spec.subject}
          seq={spec.seq}
        />
      )
    case 'consumers':
      return <ConsumersTab connId={spec.connId} />
    case 'consumer':
      return (
        <ConsumerTab
          tabId={tab.id}
          connId={spec.connId}
          stream={spec.stream}
          consumer={spec.consumer}
        />
      )
    case 'subjects':
      return <SubjectsTab connId={spec.connId} />
    case 'tail':
      return <TailTab tabId={tab.id} connId={spec.connId} subject={spec.subject} />
    case 'trace':
      return (
        <TraceTab
          tabId={tab.id}
          connId={spec.connId}
          query={spec.query}
          view={spec.view}
          viewSettings={spec.viewSettings}
        />
      )
    case 'publish':
      return <PublishTab connId={spec.connId} subject={spec.subject} />
    case 'kv':
      return <KvTab connId={spec.connId} />
    case 'kvBucket':
      return <KvBucketTab tabId={tab.id} connId={spec.connId} bucket={spec.bucket} />
    case 'objects':
      return <ObjectsTab connId={spec.connId} />
    case 'objBucket':
      return <ObjBucketTab tabId={tab.id} connId={spec.connId} bucket={spec.bucket} />
    case 'alerts':
      return <AlertsTab connId={spec.connId} />
    case 'decoders':
      return <DecodersTab connId={spec.connId} />
    case 'audit':
      return <AuditTab connId={spec.connId} />
  }
}

/**
 * Renders every open tab and shows only the active one. Hidden tabs stay mounted so a live tail
 * keeps collecting and a message browser keeps its place, but they stop polling.
 */
export function TabHost(): ReactNode {
  const { tabs, activeId } = useTabs()
  const { data: connections = [], isLoading } = useConnections()
  const setOverlay = useOverlays((s) => s.set)
  const locked = useAppInfo()?.connectionsLocked

  if (tabs.length === 0) {
    return (
      <EmptyState
        icon={<Database className="h-10 w-10" aria-hidden />}
        title={
          connections.length === 0 && !isLoading
            ? 'Connect to a NATS server to get started'
            : 'Nothing open'
        }
      >
        {connections.length === 0 && !isLoading ? (
          <>
            <p className="mb-3">
              Add a connection, or create a context with the NATS CLI and the studio will find it.
            </p>
            {!locked && (
              <Button
                variant="primary"
                icon={<Plus className="h-4 w-4" aria-hidden />}
                onClick={() => setOverlay({ connectionForm: 'new' })}
              >
                Add connection
              </Button>
            )}
          </>
        ) : (
          <p>
            Pick a connection on the left, or press <Kbd>Ctrl K</Kbd> to search.
          </p>
        )}
      </EmptyState>
    )
  }

  return (
    <>
      {tabs.map((tab) => {
        const active = tab.id === activeId
        return (
          <div
            key={tab.id}
            role="tabpanel"
            aria-labelledby={`tab-${tab.id}`}
            hidden={!active}
            className="h-full min-h-0"
          >
            <TabActiveContext.Provider value={active}>
              <ConnectionGate connId={tab.spec.connId} tabId={tab.id}>
                {content(tab)}
              </ConnectionGate>
            </TabActiveContext.Provider>
          </div>
        )
      })}
    </>
  )
}
