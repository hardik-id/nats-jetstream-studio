import { useMemo, useRef, useState, useEffect, type KeyboardEvent, type ReactNode } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { Radio, RefreshCw, Send } from 'lucide-react'
import { formatCount } from '@shared/format'
import { Button, ErrorNote, errorMessage, Notice, Page, readOnlyProps } from '../../components/ui'
import type { MenuItem } from '../../components/ui'
import { useGateway } from '../../gateway'
import { useConnection, useDebounced } from '../../lib/hooks'
import { useSeenSubjects } from '../../state/seenSubjects'
import { useTabs } from '../../state/tabs'
import { PANE_DEFAULT_WIDTH, useSubjectsUi } from '../../state/subjectsUi'
import { PaneFrame, PaneRail } from './SubjectsPane'
import { SubjectDetail } from './SubjectDetail'
import { describeActions, resolveScope, rowMenuItems, runBrowse, runTail } from './subjectActions'
import { SubjectTree } from './SubjectTree'
import { SubjectsToolbar, type LevelChoice } from './SubjectsToolbar'
import {
  buildTree,
  defaultExpanded,
  EXPAND_ALL_CAP,
  excludeSystemStreams,
  expandAllPaths,
  expandToLevel,
  flatten,
  pruneExpanded,
  searchSubjects,
  type SubjectRow,
  type SubjectTreeNode
} from './subjectTree'

const PER_STREAM = 5000
/** Below this width of the screen the detail pane starts as a rail. */
const NARROW_WIDTH = 900

const EMPTY_SET: ReadonlySet<string> = new Set()

/** Search-time opening and closing the user did, for one query. Cleared when the query changes. */
interface SearchOpen {
  query: string
  collapsed: ReadonlySet<string>
  expanded: ReadonlySet<string>
}

/**
 * Subjects as a hierarchy (PBI-061, PBI-127): a virtualised tree of the subjects stored in every
 * stream plus those seen in live tails, with a detail pane for the selected subject.
 */
export function SubjectsTab({ connId }: { connId: string }): ReactNode {
  const gateway = useGateway()
  const tabs = useTabs()
  const conn = useConnection(connId)
  const readOnly = conn?.readOnly === true
  const { ui, ready, update } = useSubjectsUi(connId)
  const [search, setSearch] = useState('')
  const query = useDebounced(search.trim(), 200)
  const [searchOpen, setSearchOpen] = useState<SearchOpen>({
    query: '',
    collapsed: EMPTY_SET,
    expanded: EMPTY_SET
  })
  const [note, setNote] = useState<string | null>(null)
  const seen = useSeenSubjects((s) => s.byConn[connId])
  const searchInput = useRef<HTMLInputElement>(null)
  const root = useRef<HTMLDivElement>(null)

  const streams = useQuery({
    queryKey: ['streams', connId],
    queryFn: () => gateway.listStreams(connId)
  })
  const names = useMemo(
    () => excludeSystemStreams((streams.data ?? []).map((s) => s.config.name)),
    [streams.data]
  )
  const subjectQueries = useQueries({
    queries: names.map((stream) => ({
      queryKey: ['subjects', connId, stream, '', 'count', 0, PER_STREAM],
      queryFn: () =>
        gateway.streamSubjects(connId, stream, { sort: 'count' as const, limit: PER_STREAM }),
      staleTime: 30_000
    }))
  })
  const waiting = subjectQueries.filter((q) => q.isLoading).length
  const settled = ready && !streams.isLoading && waiting === 0
  const truncated = names.filter((_, i) => (subjectQueries[i]?.data?.total ?? 0) > PER_STREAM)
  const failed = names.flatMap((stream, i) =>
    subjectQueries[i]?.error ? [{ stream, error: subjectQueries[i].error, index: i }] : []
  )
  const dataKey = `${names.join(',')}|${subjectQueries.map((q) => q.dataUpdatedAt).join(',')}`

  const patterns = useMemo(
    () =>
      (streams.data ?? [])
        .filter((s) => names.includes(s.config.name))
        .map((s) => ({ name: s.config.name, subjects: s.config.subjects ?? [] })),
    [streams.data, names]
  )

  // Rows appear as each stream answers: the tree is built from the streams that have data.
  const tree = useMemo(
    () =>
      buildTree(
        names.flatMap((stream, i) => {
          const data = subjectQueries[i]?.data
          return data ? [{ stream, subjects: data.subjects }] : []
        }),
        seen,
        patterns
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataKey, seen, patterns]
  )

  const filters = useMemo(
    () => ({ onlyWithMessages: ui.onlyWithMessages, source: ui.source }),
    [ui.onlyWithMessages, ui.source]
  )

  // The open nodes: what the user chose, else the top level. Paths that are gone are dropped,
  // but only once every stream has answered (a partial tree must not forget anything).
  const expanded = useMemo(() => {
    if (ui.expanded === null) return defaultExpanded(tree)
    return settled ? pruneExpanded(tree, ui.expanded) : new Set(ui.expanded)
  }, [tree, ui.expanded, settled])

  const searching = query !== ''
  const searchResult = useMemo(
    () => (searching ? searchSubjects(tree, query, filters) : null),
    [tree, query, filters, searching]
  )
  const sCollapsed = searching && searchOpen.query === query ? searchOpen.collapsed : EMPTY_SET
  const sExpanded = searching && searchOpen.query === query ? searchOpen.expanded : EMPTY_SET

  const rows = useMemo(() => {
    let open: ReadonlySet<string> = expanded
    if (searching && sCollapsed.size)
      open = new Set([...expanded].filter((p) => !sCollapsed.has(p)))
    return flatten(tree, {
      expanded: open,
      search: searchResult ?? undefined,
      sort: ui.sort,
      searchCollapsed: sCollapsed,
      searchExpanded: sExpanded,
      ...filters
    })
  }, [tree, expanded, searching, searchResult, sCollapsed, sExpanded, ui.sort, filters])

  const selectedNode: SubjectTreeNode | null = ui.selected
    ? (tree.byPath.get(ui.selected) ?? null)
    : null

  // ---- opening and closing ----

  /** Opens or closes rows. While searching this changes the search view only, never `expanded`. */
  const setOpen = (targets: SubjectRow[], open: boolean): void => {
    setNote(null)
    if (searchResult) {
      const collapsed = new Set(sCollapsed)
      const opened = new Set(sExpanded)
      for (const t of targets) {
        if (!open) {
          opened.delete(t.path)
          collapsed.add(t.path)
        } else {
          collapsed.delete(t.path)
          // A match that is also an ancestor is open unless closed; opening it again must not
          // switch it to "show everything below".
          if (!(t.match && searchResult.revealed.has(t.path))) opened.add(t.path)
        }
      }
      setSearchOpen({ query, collapsed, expanded: opened })
      return
    }
    const next = new Set(expanded)
    for (const t of targets) {
      if (open) next.add(t.path)
      else next.delete(t.path)
    }
    update({ expanded: [...next] })
  }

  const applyExpansion = (choice: LevelChoice | 'none'): void => {
    const result =
      choice === 'none'
        ? { expanded: new Set<string>(), level: 1, capped: false }
        : choice === 'all'
          ? expandAllPaths(tree, EXPAND_ALL_CAP, filters)
          : expandToLevel(tree, choice, filters)
    setNote(
      result.capped
        ? `Expanded to level ${result.level} (limit of ${formatCount(EXPAND_ALL_CAP)} rows)`
        : null
    )
    if (searchResult) {
      // The search view. The levels count over the whole tree (a match opens to show its
      // descendants), so ancestors and the user's own open nodes that fall outside the result
      // are closed for this search, and the result's nodes are opened.
      const closed = new Set<string>()
      for (const p of searchResult.revealed) if (!result.expanded.has(p)) closed.add(p)
      for (const p of expanded) if (!result.expanded.has(p)) closed.add(p)
      setSearchOpen({ query, collapsed: closed, expanded: new Set(result.expanded) })
    } else update({ expanded: [...result.expanded] })
  }

  // ---- selection and the detail pane ----

  const narrow = useNarrow(root)
  const paneCollapsed = ui.paneCollapsed ?? narrow
  const [dragWidth, setDragWidth] = useState<number | null>(null)

  const select = (row: SubjectRow, open: boolean): void => {
    update({
      selected: row.path,
      ...(open && paneCollapsed ? { paneCollapsed: false } : {})
    })
    if (open) runDefault(row.node)
  }

  // ---- row menu and the default action ----

  const menuItems = (node: SubjectTreeNode): MenuItem[] =>
    rowMenuItems(node, { connId, tabs, streams: patterns, readOnly })

  /** Enter and double-click: browse the subject when a stream stores it, else tail it. */
  const runDefault = (node: SubjectTreeNode): void => {
    const a = describeActions(node, resolveScope(node), patterns, readOnly)
    if (a.browse.enabled) runBrowse(tabs, connId, a.browse)
    else runTail(tabs, connId, a.tail)
  }

  const refresh = (): void => {
    void streams.refetch()
    subjectQueries.forEach((q) => void q.refetch())
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const el = e.target as HTMLElement
    const typing = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
    if ((e.key === '/' && !typing) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f')) {
      e.preventDefault()
      searchInput.current?.focus()
      searchInput.current?.select()
    }
  }

  const clearSearch = (): void => setSearch('')
  const empty = settled && tree.nodeCount === 0
  const showSkeleton = (!settled && tree.nodeCount === 0) || !ready
  const subtitle = !settled
    ? streams.isLoading || !ready
      ? 'Reading streams...'
      : `Reading ${formatCount(waiting)} of ${formatCount(names.length)} streams...`
    : `${formatCount(tree.total)} stored messages · ${formatCount(names.length)} streams · ${formatCount(tree.subjectCount)} subjects`
  const paneNode = selectedNode
  const detail = (
    <div className="h-full border-l border-line">
      <SubjectDetail
        connId={connId}
        node={paneNode}
        streams={patterns}
        readOnly={readOnly}
        onCollapse={() => update({ paneCollapsed: true })}
      />
    </div>
  )

  return (
    <Page
      scroll={false}
      title="Subjects"
      subtitle={subtitle}
      actions={
        <Button
          icon={<RefreshCw className="h-3.5 w-3.5" aria-hidden />}
          busy={subjectQueries.some((q) => q.isFetching) && settled}
          onClick={refresh}
        >
          Refresh
        </Button>
      }
    >
      <div ref={root} className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
        <SubjectsToolbar
          searchRef={searchInput}
          search={search}
          onSearch={setSearch}
          matchCount={searchResult ? searchResult.count : null}
          onExpandAll={() => applyExpansion('all')}
          onCollapseAll={() => applyExpansion('none')}
          onLevel={applyExpansion}
          sort={ui.sort}
          onSort={(sort) => update({ sort })}
          onlyWithMessages={ui.onlyWithMessages}
          onOnlyWithMessages={(onlyWithMessages) => update({ onlyWithMessages })}
          source={ui.source}
          onSource={(source) => update({ source })}
          disabled={tree.nodeCount === 0}
        />
        {(note || truncated.length > 0 || streams.error || failed.length > 0) && (
          <div className="flex shrink-0 flex-col gap-2 border-b border-line bg-panel px-4 py-2">
            <ErrorNote error={streams.error} onRetry={() => void streams.refetch()} />
            {failed.map((f) => (
              <ErrorNote
                key={f.stream}
                error={
                  new Error(`Could not read the subjects of ${f.stream}. ${errorMessage(f.error)}`)
                }
                onRetry={() => void subjectQueries[f.index]?.refetch()}
              />
            ))}
            {note && (
              <div role="status">
                <Notice tone="accent">{note}</Notice>
              </div>
            )}
            {truncated.length > 0 && (
              <Notice>
                Showing the {formatCount(PER_STREAM)} busiest subjects of {truncated.join(', ')}.
                Open the stream&apos;s Subjects tab to page through all of them.
              </Notice>
            )}
          </div>
        )}
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1">
            {showSkeleton ? (
              <Skeleton />
            ) : empty ? (
              <div className="flex flex-col items-start gap-3 p-6">
                <p className="text-muted">
                  No subjects yet. Publish to a stream, or start a live tail to see core NATS
                  subjects here.
                </p>
                <div className="flex gap-2">
                  <Button
                    icon={<Radio className="h-3.5 w-3.5" aria-hidden />}
                    onClick={() => tabs.openNew('tail', connId)}
                  >
                    Start a live tail
                  </Button>
                  <Button
                    icon={<Send className="h-3.5 w-3.5" aria-hidden />}
                    {...readOnlyProps(readOnly)}
                    onClick={() => tabs.openNew('publish', connId)}
                  >
                    Publish a message
                  </Button>
                </div>
              </div>
            ) : rows.length === 0 ? (
              <div className="flex flex-col items-start gap-3 p-6">
                <p className="text-muted">
                  {searching ? `No subjects match "${query}".` : 'No subjects match the filters.'}
                </p>
                {searching && <Button onClick={clearSearch}>Clear search</Button>}
              </div>
            ) : (
              <SubjectTree
                rows={rows}
                selectedPath={ui.selected}
                onSelect={select}
                onSetOpen={setOpen}
                menuItems={menuItems}
              />
            )}
          </div>
          <PaneFrame
            width={dragWidth ?? ui.paneWidth ?? PANE_DEFAULT_WIDTH}
            onWidth={setDragWidth}
            onCommit={(w) => {
              update({ paneWidth: w })
              setDragWidth(null)
            }}
            collapsed={paneCollapsed}
          >
            {paneCollapsed ? (
              <PaneRail
                label={paneNode ? paneNode.path : 'Subject details'}
                onExpand={() => update({ paneCollapsed: false })}
              />
            ) : (
              detail
            )}
          </PaneFrame>
        </div>
      </div>
    </Page>
  )
}

function Skeleton(): ReactNode {
  return (
    <div role="status" aria-label="Reading subjects" className="flex flex-col gap-2 p-4">
      {[70, 45, 60, 35, 52, 40].map((w, i) => (
        <div key={i} className="h-5 animate-pulse rounded bg-hover" style={{ width: `${w}%` }} />
      ))}
    </div>
  )
}

/** True when the screen is narrower than `NARROW_WIDTH`; the pane is a rail by default then. */
function useNarrow(ref: React.RefObject<HTMLElement | null>): boolean {
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? el.clientWidth
      setNarrow(w > 0 && w < NARROW_WIDTH)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return narrow
}
