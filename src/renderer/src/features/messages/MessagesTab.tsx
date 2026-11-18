import { useMemo, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { GatewayError } from '@shared/api'
import { Button, EmptyState, ErrorNote, Notice, Page, Spinner } from '../../components/ui'
import { useGateway } from '../../gateway'
import { useRefetchInterval } from '../../lib/hooks'
import { useTabs } from '../../state/tabs'
import { openNav, TabIcon } from '../shell/nav'
import { MessageBrowser } from './MessageBrowser'
import { StreamPicker, type StreamOption } from './StreamPicker'

/**
 * The Messages screen of a connection (PBI-128): a stream picker above the message browser. There
 * is one per connection; every "browse messages" link in the studio opens it on the right stream,
 * subject or sequence (see `openMessages`), and the choice is kept in the tab, so it survives a
 * restart.
 */
export function MessagesTab({
  tabId,
  connId,
  stream: stored,
  subject,
  seq
}: {
  tabId: string
  connId: string
  stream?: string
  subject?: string
  seq?: number
}): ReactNode {
  const gateway = useGateway()
  const client = useQueryClient()
  const patch = useTabs((s) => s.patch)
  const openTab = useTabs((s) => s.open)
  const refetchInterval = useRefetchInterval()
  // The same list (and cache) as the Streams screen.
  const list = useQuery({
    queryKey: ['streams', connId],
    queryFn: () => gateway.listStreams(connId)
  })
  const options = useMemo<StreamOption[]>(
    () =>
      (list.data ?? [])
        .map((s) => ({ name: s.config.name, messages: s.state.messages }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [list.data]
  )
  // A stream that was chosen here and has since been deleted, to say so once it is cleared.
  const [gone, setGone] = useState<string | null>(null)
  // With exactly one stream there is nothing to choose. Otherwise nothing is guessed, and not
  // right after the chosen stream disappeared either, so the notice about it stays readable.
  const stream = stored ?? (!gone && options.length === 1 ? options[0].name : undefined)

  // The same query as the stream page, so Live and Reload in the browser keep it fresh.
  const info = useQuery({
    queryKey: ['stream', connId, stream],
    enabled: stream !== undefined,
    queryFn: async () => {
      try {
        return await gateway.streamInfo(connId, stream!)
      } catch (e) {
        if (e instanceof GatewayError && e.kind === 'not_found') {
          void client.invalidateQueries({ queryKey: ['streams', connId] })
          if (stream === stored) {
            // The stored stream is gone: forget it, and say why the screen is empty.
            setGone(stream!)
            patch(tabId, { stream: undefined, subject: undefined, seq: undefined })
          }
        }
        throw e
      }
    },
    refetchInterval
  })
  const notFound = info.error instanceof GatewayError && info.error.kind === 'not_found'

  // "Expand to read" covers this page's header; it is inert while that is on. It belongs to the
  // stream it was turned on for, so choosing another stream ends it.
  const [read, setRead] = useState<{ stream?: string; on: boolean }>({ on: false })
  const expanded = read.on && read.stream === stream
  const covered = expanded && !!info.data && !info.error

  const choose = (next: string): void => {
    setGone(null)
    patch(tabId, { stream: next, subject: undefined, seq: undefined })
  }

  const refresh = (): void => {
    void list.refetch()
    if (stream) void info.refetch()
  }
  const refreshing = stream
    ? info.isFetching && !info.isLoading
    : list.isFetching && !list.isLoading

  let body: ReactNode
  if (!stream) {
    body = (
      <>
        {gone && (
          <Notice tone="warn" className="m-4 mb-0">
            Stream <span className="font-mono">{gone}</span> no longer exists. Choose another
            stream.
          </Notice>
        )}
        {list.error ? (
          <ErrorNote className="m-4" error={list.error} onRetry={() => void list.refetch()} />
        ) : list.isLoading ? (
          <div className="p-6">
            <Spinner label="Loading streams" />
          </div>
        ) : options.length === 0 ? (
          <EmptyState
            icon={<TabIcon kind="messages" className="h-10 w-10" />}
            title="This connection has no streams"
          >
            <p className="mb-3">
              Messages are browsed per stream. Create one on the Streams screen.
            </p>
            <Button onClick={() => openNav(connId, 'streams')}>Open Streams</Button>
          </EmptyState>
        ) : (
          <EmptyState
            icon={<TabIcon kind="messages" className="h-10 w-10" />}
            title="Choose a stream to browse its messages"
          >
            <p>Pick it in the Stream field above, or type part of its name to filter the list.</p>
          </EmptyState>
        )}
      </>
    )
  } else if (notFound) {
    body = (
      <EmptyState title={`Stream ${stream} no longer exists`}>
        <p>Choose another stream above.</p>
      </EmptyState>
    )
  } else if (info.error) {
    body = <ErrorNote className="m-4" error={info.error} onRetry={() => void info.refetch()} />
  } else if (!info.data) {
    body = (
      <div className="p-6">
        <Spinner label="Loading stream" />
      </div>
    )
  } else {
    body = (
      <div className="min-h-0 flex-1">
        <MessageBrowser
          key={stream}
          connId={connId}
          info={info.data}
          requestSubject={subject}
          requestSeq={seq}
          visible
          expanded={expanded}
          onExpandedChange={(on) => setRead({ stream, on })}
        />
      </div>
    )
  }

  return (
    <Page
      scroll={false}
      headerInert={covered}
      title="Messages"
      subtitle={stream && info.data?.config.description}
      filter={
        <StreamPicker
          streams={options}
          value={stream}
          onChange={choose}
          loading={list.isLoading}
          autoFocus={!stream}
          onOpen={() => {
            if (list.isStale) void list.refetch()
          }}
        />
      }
      actions={
        <>
          {stream && (
            <Button
              icon={<TabIcon kind="stream" />}
              onClick={() => openTab({ kind: 'stream', connId, stream })}
            >
              Open stream
            </Button>
          )}
          <Button
            icon={<RefreshCw className="h-3.5 w-3.5" aria-hidden />}
            busy={refreshing}
            onClick={refresh}
          >
            Refresh
          </Button>
        </>
      }
    >
      {body}
    </Page>
  )
}
