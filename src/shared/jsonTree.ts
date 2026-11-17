import { quoteJsonPath } from './jsonpath'

/** Pure helpers for the JSON tree view: paths, search, and how deep a tree may open. */

export type PathSegment = string | number

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** The text to add to a path for one more step: `.key`, `["a b"]` or `[0]`. */
export function appendSegment(segment: PathSegment): string {
  if (typeof segment === 'number') return `[${segment}]`
  return IDENT.test(segment) ? `.${segment}` : `[${quoteJsonPath(segment)}]`
}

/** `$.order.items[0]`; keys that are not identifiers use bracket notation: `$["a b"]`. */
export function formatPath(segments: readonly PathSegment[]): string {
  let out = '$'
  for (const s of segments) out += appendSegment(s)
  return out
}

/** What "Copy value" puts on the clipboard: a string as it is, anything else as JSON. */
export function valueText(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? String(value))
}

export interface JsonMatch {
  /** The path of the node, which is also its id in the tree. */
  id: string
  inKey: boolean
  inValue: boolean
}

export interface JsonSearch {
  matches: JsonMatch[]
  /** Containers that have to be open to show every match. */
  reveal: Set<string>
  /** For each container, the indexes of the children that lead to a match. */
  need: Map<string, Set<number>>
  /** The search stopped early: too many matches or too many nodes visited. */
  truncated: boolean
}

export const SEARCH_MAX_MATCHES = 500
export const SEARCH_MAX_VISITS = 200_000

/**
 * Finds keys and primitive values that contain `query` (not case sensitive). The walk stops after
 * `maxMatches` matches or `maxVisits` nodes, so a payload of a megabyte or more cannot freeze the
 * panel; `truncated` says it did.
 */
export function searchJson(
  root: unknown,
  query: string,
  limits: { maxMatches?: number; maxVisits?: number } = {}
): JsonSearch {
  const result: JsonSearch = { matches: [], reveal: new Set(), need: new Map(), truncated: false }
  const q = query.toLowerCase()
  if (!q) return result
  const maxMatches = limits.maxMatches ?? SEARCH_MAX_MATCHES
  const maxVisits = limits.maxVisits ?? SEARCH_MAX_VISITS
  let visits = 0
  // The containers above the node being visited, and the index of the child taken in each.
  const trail: { id: string; index: number }[] = []

  const visit = (id: string, key: string | undefined, value: unknown): boolean => {
    if (++visits > maxVisits) {
      result.truncated = true
      return false
    }
    const isContainer = value !== null && typeof value === 'object'
    const inKey = key !== undefined && key.toLowerCase().includes(q)
    const inValue = !isContainer && String(value).toLowerCase().includes(q)
    if (inKey || inValue) {
      if (result.matches.length >= maxMatches) {
        result.truncated = true
        return false
      }
      result.matches.push({ id, inKey, inValue })
      for (const t of trail) {
        result.reveal.add(t.id)
        const set = result.need.get(t.id) ?? new Set<number>()
        set.add(t.index)
        result.need.set(t.id, set)
      }
    }
    if (isContainer) {
      const isArray = Array.isArray(value)
      const entries: [string | undefined, unknown][] = isArray
        ? (value as unknown[]).map((v) => [undefined, v])
        : Object.entries(value as object)
      for (let i = 0; i < entries.length; i++) {
        const [k, v] = entries[i]
        trail.push({ id, index: i })
        const go = visit(id + appendSegment(isArray ? i : (k as string)), k, v)
        trail.pop()
        if (!go) return false
      }
    }
    return true
  }
  visit('$', undefined, root)
  return result
}

/** The number of rows shown when the tree is open to `depth` (containers are listed in chunks). */
function visibleRows(value: unknown, depth: number, chunk: number, cap: number): number {
  let rows = 0
  const walk = (v: unknown, d: number): void => {
    if (rows > cap) return
    rows++
    if (v === null || typeof v !== 'object' || d >= depth) return
    const children = Array.isArray(v) ? v : Object.values(v as object)
    const n = Math.min(children.length, chunk)
    for (let i = 0; i < n; i++) walk(children[i], d + 1)
    rows++ // the closing bracket
  }
  walk(value, 0)
  return rows
}

/**
 * The deepest level, at most `requested`, that keeps the open tree to about `budget` rows. "All"
 * on a large payload would otherwise create a very large number of elements.
 */
export function fitDepth(value: unknown, requested: number, chunk: number, budget = 4000): number {
  for (let d = requested; d > 0; d--) {
    if (visibleRows(value, d, chunk, budget) <= budget) return d
  }
  return 0
}

/** How many levels a value has (a primitive has 0, `{}` has 1). */
export function maxDepth(value: unknown, cap = 64): number {
  if (value === null || typeof value !== 'object' || cap <= 0) return 0
  let deepest = 0
  const children = Array.isArray(value) ? value : Object.values(value as object)
  for (const c of children) deepest = Math.max(deepest, maxDepth(c, cap - 1))
  return deepest + 1
}
