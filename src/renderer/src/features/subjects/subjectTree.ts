/**
 * Pure model of the Subjects screen (PBI-127): a token tree with stored and live counts, search,
 * sorting, filters, a flat list of visible rows for virtualisation, expansion helpers and the
 * scope -> filter mapping. No React, no gateway, no DOM.
 *
 * Complexity (N = nodes, S = streams): `buildTree` is O(subjects x depth + N x S); `flatten` is
 * O(visible rows + children of every open node), plus one O(N) pass while a search is active;
 * children are sorted once per node and sort key (cached); `expandToLevel` is O(N). Nothing
 * recurses, so very deep subjects cannot overflow the stack.
 */
import { hasWildcard, subjectMatches, subjectsOverlap, validateSubject } from '@shared/subject'

/** Maximum number of rows "Expand all" may produce. */
export const EXPAND_ALL_CAP = 5000

/** Subjects of one stream with their stored message counts (the `streamSubjects` result). */
export interface StreamSubjects {
  stream: string
  subjects: readonly { subject: string; count: number }[]
}

/** The subject patterns a stream captures (`config.subjects`). */
export interface StreamPatterns {
  name: string
  subjects: readonly string[]
}

/** What one subject (or branch) is, without its children. Slice C renders this. */
export interface SubjectInfo {
  /** Last token. */
  token: string
  /** Full subject up to and including this token. */
  path: string
  /** Path of the parent, null for a top-level node. */
  parentPath: string | null
  /** 1 for a top-level node. */
  depth: number
  /** Messages stored on exactly this subject (all streams added together). */
  own: number
  /** Messages stored on this subject and everything below it. */
  total: number
  /** Messages seen in live tails on exactly this subject (this session). */
  live: number
  /** Live messages on this subject and everything below it. */
  liveTotal: number
  /** `own > 0`: the node itself holds messages, not only its children. */
  ownsMessages: boolean
  /** Nothing is stored here or below, it was only seen in a live tail. */
  liveOnly: boolean
  /** Number of direct children. */
  childCount: number
  hasChildren: boolean
  /**
   * Streams that store, or are configured to capture, this subject or anything below it, the one
   * with the most stored messages first, then by name.
   */
  streams: string[]
  /** Streams that store, or capture by pattern, this exact subject (what "Browse" can open). */
  ownStreams: string[]
  /** Stored messages on this subject and below, per stream. */
  byStream: Record<string, number>
  /** Stored messages on exactly this subject, per stream. */
  ownByStream: Record<string, number>
  /** `streams` joined, to compare with the parent cheaply. */
  streamsKey: string
}

export interface SubjectTreeNode extends SubjectInfo {
  /** In first-seen order; use `sortedChildren` for display order. */
  children: SubjectTreeNode[]
}

export interface SubjectTree {
  roots: SubjectTreeNode[]
  byPath: Map<string, SubjectTreeNode>
  /** Stored messages in the whole tree. */
  total: number
  liveTotal: number
  nodeCount: number
  /** Nodes with stored or live messages of their own (real subjects, not only branches). */
  subjectCount: number
  /** Depth of the deepest node, 0 for an empty tree. */
  maxDepth: number
}

function emptyNode(
  token: string,
  path: string,
  parentPath: string | null,
  depth: number
): SubjectTreeNode {
  const node: SubjectTreeNode = {
    token,
    path,
    parentPath,
    depth,
    own: 0,
    total: 0,
    live: 0,
    liveTotal: 0,
    ownsMessages: false,
    liveOnly: false,
    childCount: 0,
    hasChildren: false,
    streams: [],
    ownStreams: [],
    byStream: {},
    ownByStream: {},
    streamsKey: '',
    children: []
  }
  return node
}

/** All streams whose subject patterns match this exact subject. */
export function ownersFor(subject: string, streams: readonly StreamPatterns[]): string[] {
  return streams
    .filter((s) => s.subjects.some((pattern) => subjectMatches(pattern, subject)))
    .map((s) => s.name)
}

/**
 * Builds the tree from the stored subjects of every stream plus the subjects seen live.
 * The same subject in several streams is one node whose counts are added together and whose
 * `byStream` keeps them apart. Empty subjects are ignored.
 */
export function buildTree(
  streamSubjects: readonly StreamSubjects[],
  seen: Readonly<Record<string, number>> | undefined,
  streams: readonly StreamPatterns[] = []
): SubjectTree {
  const tree: SubjectTree = {
    roots: [],
    byPath: new Map(),
    total: 0,
    liveTotal: 0,
    nodeCount: 0,
    subjectCount: 0,
    maxDepth: 0
  }

  const add = (subject: string, stream: string | null, stored: number, live: number): void => {
    if (!subject) return
    tree.total += stored
    tree.liveTotal += live
    const tokens = subject.split('.')
    let path = ''
    let parent: SubjectTreeNode | null = null
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]
      path = i === 0 ? token : `${path}.${token}`
      let node = tree.byPath.get(path)
      if (!node) {
        node = emptyNode(token, path, parent ? parent.path : null, i + 1)
        tree.byPath.set(path, node)
        ;(parent ? parent.children : tree.roots).push(node)
      }
      node.total += stored
      node.liveTotal += live
      if (stream && stored) node.byStream[stream] = (node.byStream[stream] ?? 0) + stored
      if (i === tokens.length - 1) {
        node.own += stored
        node.live += live
        if (stream && stored) node.ownByStream[stream] = (node.ownByStream[stream] ?? 0) + stored
      }
      parent = node
    }
  }

  for (const s of streamSubjects)
    for (const { subject, count } of s.subjects) add(subject, s.stream, count, 0)
  if (seen) for (const subject of Object.keys(seen)) add(subject, null, 0, seen[subject])

  const byCountThenName = (counts: Record<string, number>) => (a: string, b: string) =>
    (counts[b] ?? 0) - (counts[a] ?? 0) || (a < b ? -1 : a > b ? 1 : 0)
  tree.nodeCount = tree.byPath.size
  for (const node of tree.byPath.values()) {
    node.childCount = node.children.length
    node.hasChildren = node.childCount > 0
    node.ownsMessages = node.own > 0
    node.liveOnly = node.total <= 0 && node.liveTotal > 0
    if (node.own > 0 || node.live > 0) tree.subjectCount++
    if (node.depth > tree.maxDepth) tree.maxDepth = node.depth
    const below = `${node.path}.>`
    const all = new Set(Object.keys(node.byStream))
    const own = new Set(Object.keys(node.ownByStream))
    for (const s of streams) {
      if (s.subjects.some((p) => subjectMatches(p, node.path))) own.add(s.name)
      if (s.subjects.some((p) => subjectsOverlap(p, node.path) || subjectsOverlap(p, below)))
        all.add(s.name)
    }
    node.streams = [...all].sort(byCountThenName(node.byStream))
    node.ownStreams = [...own].sort(byCountThenName(node.ownByStream))
    node.streamsKey = node.streams.join('\n')
  }
  return tree
}

export type SubjectSort = 'messages' | 'name' | 'live'
/** Which counts keep a node: everything, stored messages, or messages seen live. */
export type SubjectSource = 'all' | 'streams' | 'live'

export interface SubjectFilters {
  /** Hide nodes with nothing stored on them or below. */
  onlyWithMessages?: boolean
  source?: SubjectSource
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const byName = (a: SubjectTreeNode, b: SubjectTreeNode): number =>
  collator.compare(a.token, b.token) || (a.token < b.token ? -1 : a.token > b.token ? 1 : 0)

const COMPARATORS: Record<SubjectSort, (a: SubjectTreeNode, b: SubjectTreeNode) => number> = {
  messages: (a, b) => b.total - a.total || byName(a, b),
  live: (a, b) => b.liveTotal - a.liveTotal || b.total - a.total || byName(a, b),
  name: byName
}

const sortCache = new WeakMap<SubjectTreeNode[], Partial<Record<SubjectSort, SubjectTreeNode[]>>>()

/** Children in display order. Sorted once per list and sort key; do not mutate the result. */
export function sortedChildren(list: SubjectTreeNode[], sort: SubjectSort): SubjectTreeNode[] {
  let cached = sortCache.get(list)
  if (!cached) {
    cached = {}
    sortCache.set(list, cached)
  }
  return (cached[sort] ??= list.length < 2 ? list : [...list].sort(COMPARATORS[sort]))
}

function makePasses(filters: SubjectFilters): (n: SubjectTreeNode) => boolean {
  const { onlyWithMessages = false, source = 'all' } = filters
  return (n) => {
    if (onlyWithMessages && n.total <= 0) return false
    if (source === 'streams') return n.total > 0
    if (source === 'live') return n.liveTotal > 0
    return true
  }
}

/** A query with a whole-token `*` or `>` is a subject pattern, anything else a substring. */
function makeMatcher(query: string): ((path: string) => boolean) | null {
  const q = query.trim()
  if (!q) return null
  if (hasWildcard(q)) return (path) => subjectMatches(q, path)
  const lower = q.toLowerCase()
  return (path) => path.toLowerCase().includes(lower)
}

export interface SearchResult {
  /** Paths that match the query themselves. */
  matched: Set<string>
  /** Paths of the ancestors of matches (kept visible and shown open while searching). */
  revealed: Set<string>
  /** Number of matching nodes. */
  count: number
}

/** Finds the nodes matching `query` (and passing `filters`) and the ancestors to keep. */
export function searchSubjects(
  tree: SubjectTree,
  query: string,
  filters: SubjectFilters = {}
): SearchResult {
  const matched = new Set<string>()
  const revealed = new Set<string>()
  const matcher = makeMatcher(query)
  if (!matcher) return { matched, revealed, count: 0 }
  const passes = makePasses(filters)
  for (const node of tree.byPath.values()) {
    if (!passes(node) || !matcher(node.path)) continue
    matched.add(node.path)
    let p = node.parentPath
    while (p !== null && !revealed.has(p)) {
      revealed.add(p)
      p = tree.byPath.get(p)?.parentPath ?? null
    }
  }
  return { matched, revealed, count: matched.size }
}

export interface FlattenOptions extends SubjectFilters {
  /** Paths the user opened. Never changed by searching. */
  expanded: ReadonlySet<string>
  /** Substring, or a subject pattern with `*` / `>`. Empty for no search. */
  query?: string
  sort?: SubjectSort
}

export interface SubjectRow {
  node: SubjectTreeNode
  path: string
  /** 1 for a top-level row (`aria-level`). */
  level: number
  /** Position among the visible siblings, from 1 (`aria-posinset`). */
  posInSet: number
  /** Number of visible siblings (`aria-setsize`). */
  setSize: number
  /** Has visible children (so `aria-expanded` applies). */
  hasChildren: boolean
  isOpen: boolean
  /** The row itself matches the search (false for ancestors kept only for context). */
  match: boolean
  /** Show the stream badge: the node has streams and they differ from its parent's. */
  showStreams: boolean
}

/**
 * The visible rows, depth first, for the given expanded set, search, sort and filters. While a
 * query is active only matches and their ancestors are listed, ancestors are shown open, and the
 * expanded set is not read for them nor modified.
 */
export function flatten(tree: SubjectTree, options: FlattenOptions): SubjectRow[] {
  const { expanded, query = '', sort = 'messages' } = options
  const passes = makePasses(options)
  const search = query.trim() ? searchSubjects(tree, query, options) : null
  const visible = search
    ? (n: SubjectTreeNode): boolean =>
        passes(n) && (search.matched.has(n.path) || search.revealed.has(n.path))
    : passes
  const rows: SubjectRow[] = []
  interface Frame {
    list: SubjectTreeNode[]
    i: number
    parentKey: string | null
  }
  const stack: Frame[] = [
    { list: sortedChildren(tree.roots, sort).filter(visible), i: 0, parentKey: null }
  ]
  while (stack.length) {
    const frame = stack[stack.length - 1]
    if (frame.i >= frame.list.length) {
      stack.pop()
      continue
    }
    const node = frame.list[frame.i++]
    const canOpen = node.children.some(visible)
    const isOpen = canOpen && (expanded.has(node.path) || !!search?.revealed.has(node.path))
    rows.push({
      node,
      path: node.path,
      level: node.depth,
      posInSet: frame.i,
      setSize: frame.list.length,
      hasChildren: canOpen,
      isOpen,
      match: search ? search.matched.has(node.path) : false,
      showStreams: node.streams.length > 0 && node.streamsKey !== frame.parentKey
    })
    if (isOpen) {
      stack.push({
        list: sortedChildren(node.children, sort).filter(visible),
        i: 0,
        parentKey: node.streamsKey
      })
    }
  }
  return rows
}

export interface ExpandResult {
  /** Paths to open, to use as the expanded set. */
  expanded: Set<string>
  /** Deepest level shown (1 = only top-level rows), 0 for an empty tree. */
  level: number
  /** The cap stopped "all" short of the deepest level. */
  capped: boolean
}

/**
 * Opens every node above `level` so that rows down to that level are visible (1 = top level only,
 * 2 = top level and its children, ...). `'all'` means the deepest level, but never more rows than
 * `maxRows` (default `EXPAND_ALL_CAP`): the deepest level that fits, at least level 1. A number is
 * not capped. Filters decide which nodes count.
 */
export function expandToLevel(
  tree: SubjectTree,
  level: number | 'all',
  filters: SubjectFilters = {},
  maxRows: number = EXPAND_ALL_CAP
): ExpandResult {
  const passes = makePasses(filters)
  const perDepth: number[] = new Array(tree.maxDepth + 1).fill(0)
  let deepest = 0
  for (const node of tree.byPath.values()) {
    if (!passes(node)) continue
    perDepth[node.depth]++
    if (node.depth > deepest) deepest = node.depth
  }
  if (deepest === 0) return { expanded: new Set(), level: 0, capped: false }
  let chosen: number
  if (level === 'all') {
    chosen = 1
    let rows = perDepth[1]
    while (chosen < deepest && rows + perDepth[chosen + 1] <= maxRows) rows += perDepth[++chosen]
  } else {
    chosen = Math.max(1, Math.min(Math.floor(level), deepest))
  }
  const expanded = new Set<string>()
  for (const node of tree.byPath.values()) {
    if (node.depth < chosen && passes(node) && node.children.some(passes)) expanded.add(node.path)
  }
  return { expanded, level: chosen, capped: level === 'all' && chosen < deepest }
}

/** "Expand all" with the row cap. */
export function expandAllPaths(
  tree: SubjectTree,
  maxRows: number = EXPAND_ALL_CAP,
  filters: SubjectFilters = {}
): ExpandResult {
  return expandToLevel(tree, 'all', filters, maxRows)
}

/** The expansion on a first visit: the top level is open (level 2). */
export function defaultExpanded(tree: SubjectTree, filters: SubjectFilters = {}): Set<string> {
  return expandToLevel(tree, 2, filters).expanded
}

export type SubjectScope = 'subject' | 'below' | 'children'

/** The subject filter a scope stands for: `a.b`, `a.b.>` (any depth) or `a.b.*` (one level). */
export function scopeFilter(path: string, scope: SubjectScope): string {
  return scope === 'below' ? `${path}.>` : scope === 'children' ? `${path}.*` : path
}

/** Publishing needs one exact subject, so only the "this subject" scope allows it. */
export function canPublish(path: string, scope: SubjectScope): boolean {
  return scope === 'subject' && validateSubject(path, false) === null
}

/** Which scopes make sense: "this subject" needs messages on it or no children. */
export function availableScopes(node: SubjectInfo): SubjectScope[] {
  const scopes: SubjectScope[] = []
  if (node.own > 0 || node.live > 0 || !node.hasChildren) scopes.push('subject')
  if (node.hasChildren) scopes.push('below', 'children')
  return scopes
}

/** The scope selected first: everything below a branch, the subject itself for a leaf. */
export function defaultScope(node: SubjectInfo): SubjectScope {
  return node.hasChildren ? 'below' : 'subject'
}
