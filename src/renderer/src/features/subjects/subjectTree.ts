/**
 * Pure model of the Subjects screen (PBI-127): a token tree with stored and live counts, search,
 * sorting, filters, a flat list of visible rows for virtualisation, expansion helpers and the
 * scope -> filter mapping. No React, no gateway, no DOM.
 *
 * Complexity (N = nodes, A = patterns still compatible with a node, usually a handful):
 * `buildTree` is O(subjects x depth + N x A), because stream ownership is computed top down in one
 * walk with the patterns split once (a pattern that cannot match a parent cannot match its
 * children); `flatten` is O(visible rows + children of every open node), plus one O(N) pass while
 * a search is active; children are sorted once per list and sort key; `expandToLevel` is O(N).
 * Nothing recurses, so very deep subjects cannot overflow the stack.
 *
 * Counts: a message stored in two streams (a mirror or a source) is counted in both, so `total`
 * can exceed what the server holds once. The per-stream counts (`byStream`, `ownByStream`) are
 * exact, and the screen can show them where this matters.
 */
import { hasWildcard, subjectMatches, validateSubject } from '@shared/subject'

/** Maximum number of rows "Expand all" may produce. */
export const EXPAND_ALL_CAP = 5000

/** Subjects of one stream with their stored message counts (the `streamSubjects` result). */
export interface StreamSubjects {
  stream: string
  subjects: readonly { subject: string; count: number }[]
}

/** The subject patterns a stream captures (`config.subjects`; empty for a mirror). */
export interface StreamPatterns {
  name: string
  subjects: readonly string[]
}

/** KV and Object Store buckets are streams named `KV_<bucket>` and `OBJ_<bucket>`. */
export function isSystemStream(name: string): boolean {
  return name.startsWith('KV_') || name.startsWith('OBJ_')
}

/** The stream names without KV and Object Store buckets (the Subjects screen leaves them out). */
export function excludeSystemStreams(names: readonly string[]): string[] {
  return names.filter((n) => !isSystemStream(n))
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
  /**
   * The path is a valid literal subject (`validateSubject(path, false)`): no empty token, no
   * whitespace, no wildcard token. Invalid paths can come from odd data (`a..b`); they are shown
   * but offer no scope.
   */
  valid: boolean
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
  /** Streams that store, or capture by pattern, this exact subject. */
  ownStreams: string[]
  /** Stored messages on this subject and below, per stream. Do not modify. */
  byStream: Record<string, number>
  /** Stored messages on exactly this subject, per stream. Do not modify. */
  ownByStream: Record<string, number>
  /** Stored messages exactly one level below, per stream. Do not modify. */
  childByStream: Record<string, number>
  /** `streams` joined, to compare with the parent cheaply. */
  streamsKey: string
}

export interface SubjectTreeNode extends SubjectInfo {
  /** In first-seen order and frozen; use `sortedChildren` for display order. */
  children: readonly SubjectTreeNode[]
}

export interface SubjectTree {
  roots: readonly SubjectTreeNode[]
  byPath: Map<string, SubjectTreeNode>
  /** Stored messages in the whole tree (a mirrored message counts once per stream). */
  total: number
  liveTotal: number
  nodeCount: number
  /** Nodes with stored or live messages of their own (real subjects, not only branches). */
  subjectCount: number
  /** Depth of the deepest node, 0 for an empty tree. */
  maxDepth: number
}

const EMPTY: Record<string, number> = Object.freeze({}) as Record<string, number>

type MutableNode = Omit<SubjectTreeNode, 'children'> & { children: SubjectTreeNode[] }

function emptyNode(
  token: string,
  path: string,
  parent: SubjectTreeNode | null,
  depth: number
): MutableNode {
  const tokenOk = token !== '' && token !== '*' && token !== '>' && !/\s/.test(token)
  return {
    token,
    path,
    parentPath: parent ? parent.path : null,
    depth,
    valid: tokenOk && (parent ? parent.valid : true),
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
    byStream: EMPTY,
    ownByStream: EMPTY,
    childByStream: EMPTY,
    streamsKey: '',
    children: []
  }
}

type CountField = 'byStream' | 'ownByStream' | 'childByStream'

function bump(
  node: MutableNode | SubjectTreeNode,
  field: CountField,
  key: string,
  n: number
): void {
  let o = node[field]
  if (o === EMPTY) {
    o = {}
    node[field] = o
  }
  o[key] = (o[key] ?? 0) + n
}

const clamp = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0)

interface SplitPattern {
  stream: string
  tokens: string[]
}

function splitPatterns(streams: readonly StreamPatterns[]): SplitPattern[] {
  const out: SplitPattern[] = []
  for (const s of streams)
    for (const p of s.subjects) out.push({ stream: s.name, tokens: p.split('.') })
  return out
}

/** Can two subject patterns match a common subject? (As `subjectsOverlap`, on split tokens.) */
function overlapTokens(x: readonly string[], y: readonly string[]): boolean {
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i]
    const q = y[i]
    if (p === '>' || q === '>') return p !== undefined && q !== undefined
    if (p === undefined || q === undefined) return false
    if (p !== '*' && q !== '*' && p !== q) return false
  }
  return true
}

const byCountThenName = (counts: Record<string, number>) => (a: string, b: string) =>
  (counts[b] ?? 0) - (counts[a] ?? 0) || (a < b ? -1 : a > b ? 1 : 0)

/**
 * Builds the tree from the stored subjects of every stream plus the subjects seen live.
 * The same subject in several streams is one node whose counts are added together and whose
 * `byStream` keeps them apart. Empty subjects are ignored; NaN, negative and infinite counts
 * count as 0; a live entry of 0 is skipped.
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
  const roots: MutableNode[] = []

  const add = (subject: string, stream: string | null, stored: number, live: number): void => {
    if (!subject) return
    tree.total += stored
    tree.liveTotal += live
    const tokens = subject.split('.')
    let path = ''
    let parent: MutableNode | null = null
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]
      path = i === 0 ? token : `${path}.${token}`
      let node = tree.byPath.get(path) as MutableNode | undefined
      if (!node) {
        node = emptyNode(token, path, parent as SubjectTreeNode | null, i + 1)
        tree.byPath.set(path, node as SubjectTreeNode)
        ;(parent ? parent.children : roots).push(node as SubjectTreeNode)
      }
      node.total += stored
      node.liveTotal += live
      if (stream && stored) bump(node, 'byStream', stream, stored)
      if (i === tokens.length - 1) {
        node.own += stored
        node.live += live
        if (stream && stored) {
          bump(node, 'ownByStream', stream, stored)
          if (parent) bump(parent, 'childByStream', stream, stored)
        }
      }
      parent = node
    }
  }

  for (const s of streamSubjects)
    for (const { subject, count } of s.subjects) add(subject, s.stream, clamp(count), 0)
  if (seen) {
    for (const subject of Object.keys(seen)) {
      const n = clamp(seen[subject])
      if (n > 0) add(subject, null, 0, n)
    }
  }
  tree.roots = roots

  // Ownership, top down: `alive` holds the patterns still compatible with the path so far. A
  // pattern that fails at a parent fails below it too, so each node only looks at its parent's
  // survivors. A survivor shorter than the path ended with `>` and so captures everything below.
  const patterns = splitPatterns(streams)
  const all = patterns.map((_, i) => i)
  const stack: { node: MutableNode; alive: number[] }[] = []
  const visit = (node: MutableNode, parentAlive: number[]): void => {
    const d = node.depth
    const alive: number[] = []
    for (const idx of parentAlive) {
      const t = patterns[idx].tokens
      let ok: boolean
      if (t.length < d) ok = t[t.length - 1] === '>'
      else ok = t[d - 1] === '>' || t[d - 1] === '*' || t[d - 1] === node.token
      if (ok) alive.push(idx)
    }
    const names = new Set(Object.keys(node.byStream))
    const own = new Set(Object.keys(node.ownByStream))
    for (const idx of alive) {
      names.add(patterns[idx].stream)
      if (patterns[idx].tokens.length <= d) own.add(patterns[idx].stream)
    }
    node.streams = [...names].sort(byCountThenName(node.byStream))
    node.ownStreams = [...own].sort(byCountThenName(node.ownByStream))
    node.streamsKey = node.streams.join('\n')
    node.childCount = node.children.length
    node.hasChildren = node.childCount > 0
    node.ownsMessages = node.own > 0
    node.liveOnly = node.total <= 0 && node.liveTotal > 0
    if (node.own > 0 || node.live > 0) tree.subjectCount++
    if (d > tree.maxDepth) tree.maxDepth = d
    Object.freeze(node.children)
    for (const c of node.children) stack.push({ node: c as MutableNode, alive })
  }
  for (const r of roots) stack.push({ node: r, alive: all })
  while (stack.length) {
    const { node, alive } = stack.pop()!
    visit(node, alive)
  }
  Object.freeze(roots)
  tree.nodeCount = tree.byPath.size
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

const sortCache = new WeakMap<
  readonly SubjectTreeNode[],
  Partial<Record<SubjectSort, readonly SubjectTreeNode[]>>
>()

/**
 * Children in display order, sorted once per list and sort key. The result is read-only: the tree
 * and its lists are frozen, which keeps the cache valid.
 */
export function sortedChildren(
  list: readonly SubjectTreeNode[],
  sort: SubjectSort
): readonly SubjectTreeNode[] {
  let cached = sortCache.get(list)
  if (!cached) {
    cached = {}
    sortCache.set(list, cached)
  }
  return (cached[sort] ??=
    list.length < 2 ? list : Object.freeze([...list].sort(COMPARATORS[sort])))
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

const lowerCache = new WeakMap<SubjectTreeNode, string>()
function lowerPath(node: SubjectTreeNode): string {
  let l = lowerCache.get(node)
  if (l === undefined) {
    l = node.path.toLowerCase()
    lowerCache.set(node, l)
  }
  return l
}

/** Highlight range inside the node's own token: `[start, end)`. */
export type HighlightRange = readonly [number, number]

type Matcher = (node: SubjectTreeNode) => HighlightRange | true | null

/**
 * A query with a whole-token `*` or `>` is a subject pattern (case sensitive, as in NATS), anything
 * else a case-insensitive substring. A node matches itself when the match reaches into its own
 * token, so the query `orders` matches `orders` but not each of its descendants.
 */
function makeMatcher(query: string): Matcher | null {
  const q = query.trim()
  if (!q) return null
  if (hasWildcard(q)) return (n) => (subjectMatches(q, n.path) ? [0, n.token.length] : null)
  const lower = q.toLowerCase()
  return (n) => {
    const idx = lowerPath(n).lastIndexOf(lower)
    if (idx < 0) return null
    const tokenStart = n.path.length - n.token.length
    const end = idx + lower.length
    if (end < tokenStart) return null
    const s = Math.max(idx, tokenStart) - tokenStart
    const e = end - tokenStart
    return e > s ? [s, e] : true
  }
}

export interface SearchResult {
  /** Paths that match the query themselves. */
  matched: Set<string>
  /** Paths of the ancestors of matches. */
  revealed: Set<string>
  /** Number of matching nodes. */
  count: number
  /** Where the query matched inside the token of each matching node (substring queries). */
  ranges: Map<string, HighlightRange>
}

/** Finds the nodes matching `query` (and passing `filters`) and the ancestors to keep. */
export function searchSubjects(
  tree: SubjectTree,
  query: string,
  filters: SubjectFilters = {}
): SearchResult {
  const matched = new Set<string>()
  const revealed = new Set<string>()
  const ranges = new Map<string, HighlightRange>()
  const matcher = makeMatcher(query)
  if (!matcher) return { matched, revealed, count: 0, ranges }
  const passes = makePasses(filters)
  for (const node of tree.byPath.values()) {
    if (!passes(node)) continue
    const m = matcher(node)
    if (!m) continue
    matched.add(node.path)
    if (m !== true) ranges.set(node.path, m)
    let p = node.parentPath
    while (p !== null && !revealed.has(p)) {
      revealed.add(p)
      p = tree.byPath.get(p)?.parentPath ?? null
    }
  }
  return { matched, revealed, count: matched.size, ranges }
}

export interface FlattenOptions extends SubjectFilters {
  /** Paths the user opened. Never changed here. */
  expanded: ReadonlySet<string>
  /** Substring, or a subject pattern with `*` / `>`. Empty for no search. */
  query?: string
  /** A result of `searchSubjects` for this tree and these filters; used instead of `query`. */
  search?: SearchResult
  sort?: SubjectSort
  /**
   * While searching: ancestors of matches are open by default; list the ones the user closed.
   */
  searchCollapsed?: ReadonlySet<string>
  /**
   * While searching: matches are closed by default; list the ones the user opened (they then show
   * all their descendants that pass the filters). Also opens unmatched nodes inside those.
   */
  searchExpanded?: ReadonlySet<string>
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
  /** Has children that pass the filters (so `aria-expanded` applies). */
  hasChildren: boolean
  isOpen: boolean
  /** The row itself matches the search (false for ancestors kept only for context). */
  match: boolean
  /** Where the match is inside the token, when the query is a substring. */
  highlight: HighlightRange | null
  /** Show the stream badge: the node has streams and they differ from its parent's. */
  showStreams: boolean
  /** Largest `total` among the visible siblings, to scale a bar. */
  siblingMaxTotal: number
}

/**
 * The visible rows, depth first, for the expanded set, search, sort and filters.
 *
 * Without a query a node is open when its path is in `expanded`. With a query only matches and
 * their ancestors are listed: ancestors are open unless in `searchCollapsed`, a match is closed
 * unless in `searchExpanded`, and an opened match lists all its descendants that pass the filters
 * (those open from `expanded` or `searchExpanded`). The expanded set is read, never modified.
 */
export function flatten(tree: SubjectTree, options: FlattenOptions): SubjectRow[] {
  const { expanded, query = '', sort = 'messages', searchCollapsed, searchExpanded } = options
  const passes = makePasses(options)
  const search = options.search ?? (query.trim() ? searchSubjects(tree, query, options) : null)
  const inSearch = (n: SubjectTreeNode): boolean =>
    search!.matched.has(n.path) || search!.revealed.has(n.path)
  const rows: SubjectRow[] = []
  interface Frame {
    list: readonly SubjectTreeNode[]
    i: number
    parentKey: string | null
    /** Inside an opened match: all children that pass the filters are listed. */
    all: boolean
    max: number
  }
  const frame = (
    nodes: readonly SubjectTreeNode[],
    parentKey: string | null,
    all: boolean
  ): Frame => {
    const list = sortedChildren(nodes, sort).filter(
      search && !all ? (n) => passes(n) && inSearch(n) : passes
    )
    let max = 0
    for (const n of list) if (n.total > max) max = n.total
    return { list, i: 0, parentKey, all, max }
  }
  const stack: Frame[] = [frame(tree.roots, null, false)]
  while (stack.length) {
    const f = stack[stack.length - 1]
    if (f.i >= f.list.length) {
      stack.pop()
      continue
    }
    const node = f.list[f.i++]
    const p = node.path
    const hasKids = node.children.some(passes)
    let isOpen = false
    let childAll = f.all
    if (hasKids) {
      if (!search || f.all) {
        isOpen = expanded.has(p) || (!!search && !!searchExpanded?.has(p))
      } else if (search.revealed.has(p)) {
        isOpen = !searchCollapsed?.has(p)
        childAll = search.matched.has(p) && !!searchExpanded?.has(p)
      } else {
        isOpen = !!searchExpanded?.has(p)
        childAll = true
      }
    }
    rows.push({
      node,
      path: p,
      level: node.depth,
      posInSet: f.i,
      setSize: f.list.length,
      hasChildren: hasKids,
      isOpen,
      match: search ? search.matched.has(p) : false,
      highlight: search?.ranges.get(p) ?? null,
      showStreams: node.streams.length > 0 && node.streamsKey !== f.parentKey,
      siblingMaxTotal: f.max
    })
    if (isOpen) stack.push(frame(node.children, node.streamsKey, childAll))
  }
  return rows
}

export interface ExpandOptions extends SubjectFilters {
  /** Only nodes shown by this search (matches and their ancestors) count and are opened. */
  search?: SearchResult
  /** Row cap for `'all'`, default `EXPAND_ALL_CAP`. */
  maxRows?: number
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
 * `maxRows`: the deepest level that fits, at least level 1. A number is not capped; NaN counts as
 * 1 and Infinity as the deepest level. Filters (and a search) decide which nodes count.
 */
export function expandToLevel(
  tree: SubjectTree,
  level: number | 'all',
  options: ExpandOptions = {}
): ExpandResult {
  const { search, maxRows = EXPAND_ALL_CAP } = options
  const base = makePasses(options)
  const passes = search
    ? (n: SubjectTreeNode): boolean =>
        base(n) && (search.matched.has(n.path) || search.revealed.has(n.path))
    : base
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
    const n = Number.isNaN(level) ? 1 : Math.floor(level)
    chosen = Math.max(1, Math.min(n, deepest))
  }
  const expanded = new Set<string>()
  for (const node of tree.byPath.values()) {
    if (node.depth < chosen && passes(node) && node.children.some(passes)) expanded.add(node.path)
  }
  return { expanded, level: chosen, capped: level === 'all' && chosen < deepest }
}

export interface ExpandAllOptions extends SubjectFilters {
  /**
   * Only nodes shown by this search count and are opened: matches, their ancestors and everything
   * below a match ("expand all" on a match opens its subtree too).
   */
  search?: SearchResult
  /** Nodes that are open now; they stay open. */
  current?: ReadonlySet<string>
}

export interface ExpandAllResult extends ExpandResult {
  /** Every branch (node with children) that passes the filters and the search. */
  branches: number
  /** Branches that are open in `expanded` (the ones that exist). */
  open: number
}

/**
 * "Expand all": opens branches breadth first (shallow ones first) while fewer than `maxRows` rows
 * are visible, so the last branch may go past the cap by its own children and the last level
 * may be opened only in part. Nodes that are open already stay open and are never closed, whatever
 * the cap says. `capped` says some branch stayed closed. `level` is the deepest level that is
 * visible afterwards. Nothing recurses.
 */
export function expandAllPaths(
  tree: SubjectTree,
  maxRows: number = EXPAND_ALL_CAP,
  options: ExpandAllOptions = {}
): ExpandAllResult {
  const { search, current } = options
  const base = makePasses(options)
  // Below a match: the node has a matching ancestor (memoised, walked upwards, no recursion).
  const below = new Map<string, boolean>()
  const underMatch = (n: SubjectTreeNode): boolean => {
    const chain: string[] = []
    let p: string | null = n.parentPath
    let found = false
    while (p !== null) {
      const known = below.get(p)
      if (known !== undefined) {
        found = known
        break
      }
      chain.push(p)
      if (search!.matched.has(p)) {
        found = true
        break
      }
      p = tree.byPath.get(p)?.parentPath ?? null
    }
    for (const c of chain) below.set(c, found)
    return found
  }
  const passes = search
    ? (n: SubjectTreeNode): boolean =>
        base(n) && (search.matched.has(n.path) || search.revealed.has(n.path) || underMatch(n))
    : base
  const expanded = new Set<string>(current ?? [])
  const roots = tree.roots.filter(passes)
  let rows = roots.length
  let level = roots.length ? 1 : 0
  let capped = false
  const queue: SubjectTreeNode[] = roots
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i]
    const kids = node.children.filter(passes)
    if (kids.length === 0) continue
    if (!expanded.has(node.path)) {
      if (capped || rows >= maxRows) {
        capped = true
        continue
      }
      expanded.add(node.path)
    }
    rows += kids.length
    if (node.depth + 1 > level) level = node.depth + 1
    for (const k of kids) queue.push(k)
  }
  // The total is counted over the whole tree: branches behind a closed one count too.
  let branches = 0
  for (const node of tree.byPath.values()) {
    if (passes(node) && node.children.some(passes)) branches++
  }
  let open = 0
  for (const p of expanded) if (tree.byPath.get(p)?.hasChildren) open++
  return { expanded, level, capped, branches, open }
}

/** The expansion on a first visit: the top level is open (level 2). */
export function defaultExpanded(tree: SubjectTree, filters: SubjectFilters = {}): Set<string> {
  return expandToLevel(tree, 2, filters).expanded
}

/** Keeps the paths that still exist and have children (after a refresh). */
export function pruneExpanded(tree: SubjectTree, expanded: Iterable<string>): Set<string> {
  const out = new Set<string>()
  for (const p of expanded) if (tree.byPath.get(p)?.hasChildren) out.add(p)
  return out
}

/** The ancestors of a path, outermost first: `a.b.c` gives `a`, `a.b`. */
export function ancestorPaths(path: string): string[] {
  const out: string[] = []
  let i = path.indexOf('.')
  while (i >= 0) {
    out.push(path.slice(0, i))
    i = path.indexOf('.', i + 1)
  }
  return out
}

/** A copy of `expanded` with every ancestor of `path` added, to make the node visible. */
export function revealPath(expanded: ReadonlySet<string>, path: string): Set<string> {
  const out = new Set(expanded)
  for (const a of ancestorPaths(path)) out.add(a)
  return out
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

/**
 * Which scopes make sense, in display order. "This subject" needs messages on it or no children;
 * the two wildcard scopes need children; a path that is not a valid subject offers none.
 */
export function availableScopes(node: SubjectInfo): SubjectScope[] {
  if (!node.valid) return []
  const scopes: SubjectScope[] = []
  if (node.own > 0 || node.live > 0 || !node.hasChildren) scopes.push('subject')
  if (node.hasChildren) scopes.push('below', 'children')
  return scopes
}

/** The scope selected first: everything below a branch, the subject itself for a leaf. */
export function defaultScope(node: SubjectInfo): SubjectScope {
  return node.hasChildren ? 'below' : 'subject'
}

/**
 * The text for a scope. `a.b.>` does not include `a.b` itself, and the label says so when the node
 * has messages of its own, so the user can pick "This subject" for those.
 */
export function scopeLabel(node: SubjectInfo, scope: SubjectScope): string {
  if (scope === 'subject') return `This subject (${node.path})`
  if (scope === 'children') return `One level below ${node.path}`
  return node.own > 0 || node.live > 0
    ? `Everything below ${node.path} (not ${node.path} itself)`
    : `Everything below ${node.path}`
}

/**
 * The streams that can hold messages for the filter of a scope, most messages first.
 * Streams that store messages in that scope are returned (`subject`: on the subject; `below`: strictly
 * below it; `children`: exactly one level below). When nothing is stored there (a subject seen only
 * live) the streams whose patterns overlap the filter are returned instead, in the given order.
 * A mirror has no patterns but is found through its stored data.
 */
export function streamsForScope(
  node: SubjectInfo,
  scope: SubjectScope,
  streams: readonly StreamPatterns[]
): string[] {
  const counts: Record<string, number> = {}
  if (scope === 'subject') Object.assign(counts, node.ownByStream)
  else if (scope === 'children') Object.assign(counts, node.childByStream)
  else {
    for (const s of Object.keys(node.byStream)) {
      const below = node.byStream[s] - (node.ownByStream[s] ?? 0)
      if (below > 0) counts[s] = below
    }
  }
  const stored = Object.keys(counts).sort(byCountThenName(counts))
  if (stored.length) return stored
  const filter = scopeFilter(node.path, scope).split('.')
  return streams
    .filter((s) => s.subjects.some((p) => overlapTokens(p.split('.'), filter)))
    .map((s) => s.name)
}
