import { useMemo, useState, type ReactNode } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Database, Radio, RefreshCw, Send } from 'lucide-react'
import { formatCount } from '@shared/format'
import { subjectMatches, type SubjectNode } from '@shared/subject'
import {
  Badge,
  Button,
  ErrorNote,
  Input,
  Notice,
  Page,
  readOnlyProps,
  Spinner
} from '../../components/ui'
import { useGateway } from '../../gateway'
import { useConnection, useDebounced } from '../../lib/hooks'
import { useSeenSubjects } from '../../state/seenSubjects'
import { useTabs } from '../../state/tabs'

const PER_STREAM = 5000
const CHILD_CHUNK = 200

interface TreeNode extends SubjectNode {
  children: Map<string, TreeNode>
  /** Messages seen in live tails on exactly this subject. */
  live: number
  liveTotal: number
}

function emptyNode(token: string, path: string): TreeNode {
  return { token, path, count: 0, total: 0, live: 0, liveTotal: 0, children: new Map() }
}

function addSubject(root: TreeNode, subject: string, stored: number, live: number): void {
  let node = root
  root.total += stored
  root.liveTotal += live
  const tokens = subject.split('.')
  tokens.forEach((token, i) => {
    let child = node.children.get(token)
    if (!child) {
      child = emptyNode(token, node.path ? `${node.path}.${token}` : token)
      node.children.set(token, child)
    }
    child.total += stored
    child.liveTotal += live
    if (i === tokens.length - 1) {
      child.count += stored
      child.live += live
    }
    node = child
  })
}

/**
 * Subjects as a hierarchy (PBI-061), built from the subjects stored in every stream plus the
 * subjects seen in live tails during this session.
 */
export function SubjectsTab({ connId }: { connId: string }): ReactNode {
  const gateway = useGateway()
  const [search, setSearch] = useState('')
  const query = useDebounced(search.trim().toLowerCase(), 200)
  const seen = useSeenSubjects((s) => s.byConn[connId])

  const streams = useQuery({
    queryKey: ['streams', connId],
    queryFn: () => gateway.listStreams(connId)
  })
  const names = useMemo(
    () =>
      (streams.data ?? [])
        .map((s) => s.config.name)
        .filter((n) => !n.startsWith('KV_') && !n.startsWith('OBJ_')),
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
  const loading = streams.isLoading || subjectQueries.some((q) => q.isLoading)
  const truncated = names.filter((_, i) => (subjectQueries[i]?.data?.total ?? 0) > PER_STREAM)
  const dataKey = subjectQueries.map((q) => q.dataUpdatedAt).join(',')

  const root = useMemo(() => {
    const tree = emptyNode('', '')
    subjectQueries.forEach((q) => {
      for (const { subject, count } of q.data?.subjects ?? []) addSubject(tree, subject, count, 0)
    })
    for (const [subject, count] of Object.entries(seen ?? {})) addSubject(tree, subject, 0, count)
    return tree
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataKey, seen])

  /** Which stream stores a subject: the first one whose subject patterns match it. */
  const streamFor = useMemo(() => {
    const patterns = (streams.data ?? [])
      .filter((s) => names.includes(s.config.name))
      .map((s) => ({ name: s.config.name, subjects: s.config.subjects ?? [] }))
    return (subject: string): string | undefined =>
      patterns.find((p) => p.subjects.some((pattern) => subjectMatches(pattern, subject)))?.name
  }, [streams.data, names])

  const refresh = (): void => {
    void streams.refetch()
    subjectQueries.forEach((q) => void q.refetch())
  }

  return (
    <Page
      scroll={false}
      title="Subjects"
      subtitle={`${formatCount(root.total)} stored messages across ${formatCount(names.length)} streams`}
      actions={
        <Button
          icon={<RefreshCw className="h-3.5 w-3.5" aria-hidden />}
          busy={subjectQueries.some((q) => q.isFetching) && !loading}
          onClick={refresh}
        >
          Refresh
        </Button>
      }
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-line bg-panel px-4 py-2">
        <Input
          className="w-80"
          type="search"
          aria-label="Search subjects"
          placeholder="Search subjects"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="text-xs text-muted">
          Counts are stored messages. Subjects seen only in a live tail are marked live.
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto bg-panel p-3">
        <ErrorNote error={streams.error ?? subjectQueries.find((q) => q.error)?.error} />
        {truncated.length > 0 && (
          <Notice className="mb-2">
            Showing the {formatCount(PER_STREAM)} busiest subjects of {truncated.join(', ')}. Open
            the stream&apos;s Subjects tab to page through all of them.
          </Notice>
        )}
        {loading ? (
          <Spinner label="Reading subjects from every stream" />
        ) : root.children.size === 0 ? (
          <p className="p-4 text-muted">
            No subjects yet. Publish to a stream, or start a live tail to see core NATS subjects
            here.
          </p>
        ) : (
          <ul role="tree" aria-label="Subjects">
            <Children node={root} depth={0} query={query} connId={connId} streamFor={streamFor} />
          </ul>
        )}
      </div>
    </Page>
  )
}

function matches(node: TreeNode, query: string): boolean {
  if (!query) return true
  if (node.path.toLowerCase().includes(query)) return true
  for (const child of node.children.values()) if (matches(child, query)) return true
  return false
}

function Children({
  node,
  depth,
  query,
  connId,
  streamFor
}: {
  node: TreeNode
  depth: number
  query: string
  connId: string
  streamFor: (subject: string) => string | undefined
}): ReactNode {
  const [shown, setShown] = useState(CHILD_CHUNK)
  const children = useMemo(
    () =>
      [...node.children.values()]
        .filter((c) => matches(c, query))
        .sort(
          (a, b) =>
            b.total + b.liveTotal - (a.total + a.liveTotal) || a.token.localeCompare(b.token)
        ),
    [node, query]
  )
  return (
    <>
      {children.slice(0, shown).map((child) => (
        <Branch
          key={child.token}
          node={child}
          depth={depth}
          query={query}
          connId={connId}
          streamFor={streamFor}
        />
      ))}
      {children.length > shown && (
        <li style={{ paddingLeft: depth * 18 + 22 }}>
          <button
            className="py-1 text-accent hover:underline"
            onClick={() => setShown((n) => n + CHILD_CHUNK * 5)}
          >
            Show more ({formatCount(children.length - shown)} hidden)
          </button>
        </li>
      )}
    </>
  )
}

function Branch({
  node,
  depth,
  query,
  connId,
  streamFor
}: {
  node: TreeNode
  depth: number
  query: string
  connId: string
  streamFor: (subject: string) => string | undefined
}): ReactNode {
  const tabs = useTabs()
  const conn = useConnection(connId)
  const hasChildren = node.children.size > 0
  // Children are rendered only once a branch is opened; a search opens the branches that match.
  const [open, setOpen] = useState(depth < 1)
  const expanded = open || (query !== '' && hasChildren)
  const wildcard = hasChildren ? `${node.path}.>` : node.path
  const stream = streamFor(node.count > 0 || !hasChildren ? node.path : `${node.path}.x`)

  return (
    <li role="treeitem" aria-expanded={hasChildren ? expanded : undefined} aria-label={node.path}>
      <div
        className="group flex h-7 items-center gap-1.5 rounded-md pr-2 hover:bg-hover"
        style={{ paddingLeft: depth * 18 }}
      >
        {hasChildren ? (
          <button
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-faint hover:text-fg"
            aria-label={expanded ? `Collapse ${node.path}` : `Expand ${node.path}`}
            onClick={() => setOpen(!expanded)}
          >
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" aria-hidden />
            )}
          </button>
        ) : (
          <span className="w-5 shrink-0" />
        )}
        <span className="font-mono text-xs" title={node.path}>
          {node.token}
        </span>
        <span className="tabular text-xs text-muted">{formatCount(node.total)}</span>
        {node.total === 0 && node.liveTotal > 0 && (
          <Badge tone="accent" title="Seen in a live tail; not stored in a stream">
            live
          </Badge>
        )}
        {stream && <Badge title={`Stored in stream ${stream}`}>{stream}</Badge>}
        <span className="ml-auto flex gap-0.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
          {stream && (
            <Button
              size="sm"
              variant="ghost"
              title={`Browse stored messages on ${wildcard}`}
              aria-label={`Browse stored messages on ${wildcard}`}
              icon={<Database className="h-3.5 w-3.5" aria-hidden />}
              onClick={() =>
                tabs.open({
                  kind: 'stream',
                  connId,
                  stream,
                  section: 'messages',
                  subject: wildcard,
                  seq: undefined
                })
              }
            />
          )}
          <Button
            size="sm"
            variant="ghost"
            title={`Live tail on ${wildcard}`}
            aria-label={`Live tail on ${wildcard}`}
            icon={<Radio className="h-3.5 w-3.5" aria-hidden />}
            onClick={() => tabs.openNew('tail', connId, wildcard)}
          />
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Publish to ${node.path}`}
            icon={<Send className="h-3.5 w-3.5" aria-hidden />}
            {...(conn?.readOnly ? readOnlyProps(true) : { title: `Publish to ${node.path}` })}
            onClick={() => tabs.openNew('publish', connId, node.path)}
          />
        </span>
      </div>
      {hasChildren && expanded && (
        <ul role="group">
          <Children
            node={node}
            depth={depth + 1}
            query={query}
            connId={connId}
            streamFor={streamFor}
          />
        </ul>
      )}
    </li>
  )
}
