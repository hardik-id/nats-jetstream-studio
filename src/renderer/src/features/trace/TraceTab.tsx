import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import type { ConsumerInfoDto } from '@shared/api'
import { formatCount } from '@shared/format'
import {
  DEFAULT_MATCH_CAP,
  scanLimitOf,
  validateTraceQuery,
  MAX_SCAN_LIMIT,
  type TraceQuery
} from '@shared/trace'
import { Button, ErrorNote, Page } from '../../components/ui'
import { useGateway } from '../../gateway'
import { useTabActive } from '../../lib/hooks'
import { useTabs } from '../../state/tabs'
import { isSystemStream } from '../subjects/subjectTree'
import type { StreamOption } from '../messages/StreamPicker'
import { buildTrace, formatSpan, type ConsumersByStream } from './model/trace'
import { cancelledText, NoMatches, NothingRun, ScanProgress, StreamNotices } from './TraceStates'
import { blankRule, DEFAULT_WINDOW, TraceToolbar } from './TraceToolbar'
import { TraceDetail } from './TraceDetail'
import { useTrace } from './useTrace'
import { resolveSettings } from './views/controls'
import { TRACE_VIEWS } from './views/registry'
import type { ViewSettings } from './views/types'

const emptyQuery = (): TraceQuery => ({ rules: [blankRule()], window: DEFAULT_WINDOW })

/**
 * The Trace screen (PBI-138): follow a request across subjects and consumers. The tab spec holds
 * the query, so it survives a restart; the result is in memory. Run copies the toolbar's draft to
 * the spec, and the effect below runs whatever query the spec holds (also one a "Follow" opened).
 */
export function TraceTab({
  tabId,
  connId,
  query,
  view: storedView,
  viewSettings: storedSettings
}: {
  tabId: string
  connId: string
  query?: TraceQuery
  /** The view and its settings from the tab spec. */
  view?: string
  viewSettings?: ViewSettings
}): ReactNode {
  const gateway = useGateway()
  const patch = useTabs((s) => s.patch)
  const active = useTabActive()
  const { runner, state } = useTrace()

  const [draft, setDraft] = useState<TraceQuery>(() => query ?? emptyQuery())
  // The time of the message the trace was started from: it is what the "around" windows centre on.
  const [anchor] = useState(() =>
    query?.window.kind === 'around' ? query.window.anchor : undefined
  )
  const [problem, setProblem] = useState<string>()
  const [selected, setSelected] = useState<string | null>(null)
  // The detail pane opens on a click or Enter, then follows the selection (arrows, Previous, Next).
  // Arrow keys alone only move the selection. Escape or Close hides it again.
  const [paneOpen, setPaneOpen] = useState(false)
  const tableBox = useRef<HTMLDivElement>(null)

  // Runs the tab's query when the tab is shown, once per query object. This is the one place a
  // trace starts from state; Run only changes the spec.
  const runnable = query !== undefined && validateTraceQuery(query) === undefined
  useEffect(() => {
    if (active && runnable) runner.ensure(gateway, connId, query)
  }, [active, runnable, query, runner, gateway, connId])

  const list = useQuery({
    queryKey: ['streams', connId],
    queryFn: () => gateway.listStreams(connId)
  })
  const options = useMemo<StreamOption[]>(
    () =>
      (list.data ?? [])
        .map((s) => ({ name: s.config.name, messages: s.state.messages }))
        .filter((s) => draft.includeSystem || !isSystemStream(s.name))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [list.data, draft.includeSystem]
  )

  // Consumers of the streams that have matches: the same query key as the consumer list, read once
  // per stream (not per message).
  const matchedStreams = useMemo(
    () => [...new Set(state.messages.map((m) => m.stream))].sort(),
    [state.messages]
  )
  const consumers = useQueries({
    queries: matchedStreams.map((stream) => ({
      queryKey: ['consumers', connId, stream],
      queryFn: () => gateway.listConsumers(connId, stream),
      staleTime: 30_000
    })),
    combine: (results): ConsumersByStream => {
      const out: Record<string, ConsumerInfoDto[] | undefined> = {}
      results.forEach((r, i) => (out[matchedStreams[i]] = r.data))
      return out
    }
  })
  const trace = useMemo(() => buildTrace(state.messages, consumers), [state.messages, consumers])

  const run = (): void => {
    const why = validateTraceQuery(draft)
    setProblem(why)
    if (why) return
    // A copy, so that running the same draft again is a new query for the effect above.
    patch(tabId, { query: { ...draft } })
    setSelected(null)
    setPaneOpen(false)
  }
  const cancel = (): void => runner.cancel()
  const refresh = (): void => {
    if (query) runner.start(gateway, connId, query)
    setSelected(null)
    setPaneOpen(false)
  }
  const scanMore = (): void => {
    if (!query) return
    const limit = Math.min(scanLimitOf(query) * 10, MAX_SCAN_LIMIT)
    const next = { ...query, scanLimit: limit }
    setDraft({ ...draft, scanLimit: limit })
    patch(tabId, { query: next })
  }

  // The view and its settings live in the tab spec (so they survive a restart and a rerun); an
  // unknown view id falls back to the first view. Switching views keeps the selection and the pane.
  const viewDef = TRACE_VIEWS.find((v) => v.id === storedView) ?? TRACE_VIEWS[0]
  const viewSettings = useMemo(
    () => resolveSettings(viewDef, storedSettings),
    [viewDef, storedSettings]
  )
  const changeView = (id: string): void => patch(tabId, { view: id })
  const changeSetting = (id: string, value: string | boolean): void =>
    patch(tabId, { viewSettings: { ...storedSettings, [id]: value } })
  const View = viewDef.Component
  const running = state.status === 'scanning'
  const hops = trace.hops
  const selectedIndex = selected === null ? -1 : hops.findIndex((h) => h.id === selected)
  const hop = selectedIndex >= 0 ? hops[selectedIndex] : null
  const select = (id: string): void => setSelected(id)
  const closePane = (): void => {
    setPaneOpen(false)
    // The pane (and the focus in it) goes away: keep the keyboard in the view.
    tableBox.current?.querySelector<HTMLElement>('[role=table],[role=listbox]')?.focus()
  }

  const cancelledNote = state.status === 'cancelled' ? ` · ${cancelledText(state.streams)}` : ''
  const found =
    hops.length === 0
      ? 'No messages found'
      : `${formatCount(hops.length)} ${hops.length === 1 ? 'message' : 'messages'} · ${trace.subjects} ${trace.subjects === 1 ? 'subject' : 'subjects'} · ${trace.streams.length} ${trace.streams.length === 1 ? 'stream' : 'streams'}${hops.length > 1 ? ` · ${formatSpan(trace.durationMs)} end to end` : ''}`
  const subtitle =
    state.status === 'idle'
      ? 'Follow a header or a JSON value across the streams'
      : running
        ? 'Searching...'
        : found + cancelledNote

  let body: ReactNode
  if (state.status === 'idle') body = <NothingRun />
  else if (state.status === 'failed')
    body = <ErrorNote className="m-4" error={state.error} onRetry={refresh} />
  else if (running) body = <ScanProgress streams={state.streams} onCancel={cancel} />
  else if (hops.length === 0)
    body = <NoMatches streams={state.streams} cancelled={state.status === 'cancelled'} />
  else
    body = (
      // Side by side when there is room (container width, not the window's), else stacked.
      <div className="@container min-h-0 flex-1">
        <div className="flex h-full min-h-0 flex-col @5xl:flex-row">
          <div ref={tableBox} className="min-h-32 min-w-0 flex-1">
            <View
              trace={trace}
              selected={selected}
              onSelect={select}
              settings={viewSettings}
              onOpen={(id) => {
                select(id)
                setPaneOpen(true)
              }}
            />
          </div>
          {hop && paneOpen && (
            <div className="h-[55%] shrink-0 @5xl:h-auto @5xl:w-[44%] @5xl:max-w-[720px] @5xl:min-w-[380px]">
              <TraceDetail
                connId={connId}
                message={hop.message}
                onClose={closePane}
                onPrevious={
                  selectedIndex > 0 ? () => select(hops[selectedIndex - 1].id) : undefined
                }
                onNext={
                  selectedIndex < hops.length - 1
                    ? () => select(hops[selectedIndex + 1].id)
                    : undefined
                }
              />
            </div>
          )}
        </div>
      </div>
    )

  return (
    <Page
      scroll={false}
      title="Trace"
      subtitle={subtitle}
      actions={
        <Button
          icon={<RefreshCw className="h-3.5 w-3.5" aria-hidden />}
          busy={running}
          disabled={!query}
          title="Run the trace again"
          onClick={refresh}
        >
          Refresh
        </Button>
      }
    >
      <TraceToolbar
        draft={draft}
        onChange={setDraft}
        anchor={anchor}
        streams={options}
        streamsLoading={list.isLoading}
        running={running}
        problem={problem}
        view={viewDef}
        viewSettings={viewSettings}
        onViewChange={changeView}
        onViewSettingChange={changeSetting}
        onRun={run}
        onCancel={cancel}
      />
      {!running && state.status !== 'idle' && state.status !== 'failed' && query && (
        <StreamNotices
          streams={state.streams}
          query={query}
          cancelled={state.status === 'cancelled'}
          matchCap={state.matchCap ?? DEFAULT_MATCH_CAP}
          onScanMore={scanMore}
        />
      )}
      <div className="flex min-h-0 flex-1 flex-col">{body}</div>
    </Page>
  )
}
