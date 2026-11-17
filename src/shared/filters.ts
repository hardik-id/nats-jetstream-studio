import type { ContentFilters, FilterCondition, Header } from './api'
import { utf8Decode } from './encoding'
import {
  jsonPathLiteral,
  type JsonPathFilter,
  matchesJsonPath,
  parseJsonPathFilter
} from './jsonpath'

/**
 * Content filters are a list of conditions that all have to hold (PBI-126). A condition with
 * `exclude` set rejects the messages it matches. This file is the one place that knows both the
 * list and the older single fields (`headers`, `payloadContains`, `payloadRegex`, `jsonPath`).
 */

/** The most conditions a filter can have (a limit for imported files and the panel). */
export const MAX_CONDITIONS = 50

/** The conditions of a filter, older single fields first (in the order the old scan checked them). */
export function normalizeFilters(filters: ContentFilters | undefined): FilterCondition[] {
  if (!filters) return []
  const out: FilterCondition[] = []
  for (const h of filters.headers ?? []) {
    if (h.key.trim() !== '')
      out.push(cleanCondition({ kind: 'header', key: h.key, value: h.value }))
  }
  if (filters.payloadContains) out.push({ kind: 'contains', expr: filters.payloadContains })
  if (filters.payloadRegex) out.push({ kind: 'regex', expr: filters.payloadRegex })
  if (filters.jsonPath?.trim()) out.push({ kind: 'jsonPath', expr: filters.jsonPath.trim() })
  for (const c of filters.conditions ?? []) {
    if (isBlank(c)) continue
    out.push(cleanCondition(c))
  }
  return out
}

function isBlank(c: FilterCondition): boolean {
  return c.kind === 'header'
    ? c.key.trim() === ''
    : c.kind === 'jsonPath'
      ? !c.expr.trim()
      : !c.expr
}

/** A copy with only the known fields, trimmed where trimming is harmless. */
function cleanCondition(c: FilterCondition): FilterCondition {
  const exclude = c.exclude ? { exclude: true } : {}
  if (c.kind === 'header')
    return {
      kind: 'header',
      key: c.key.trim(),
      ...(c.value ? { value: c.value } : {}),
      ...exclude
    }
  return { kind: c.kind, expr: c.kind === 'jsonPath' ? c.expr.trim() : c.expr, ...exclude }
}

/** The current shape of a filter: `{ conditions }` only, or `{}` when there is nothing to apply. */
export function canonicalFilters(filters: ContentFilters | undefined): ContentFilters {
  const conditions = normalizeFilters(filters)
  return conditions.length ? { conditions } : {}
}

export function hasContentFilters(filters: ContentFilters | undefined): boolean {
  return normalizeFilters(filters).length > 0
}

/** What a condition tests, without whether it includes or excludes: two with the same key clash. */
export function conditionKey(c: FilterCondition): string {
  return c.kind === 'header'
    ? `header\u0000${c.key.trim().toLowerCase()}\u0000${c.value ?? ''}`
    : `${c.kind}\u0000${c.kind === 'jsonPath' ? c.expr.trim() : c.expr}`
}

/**
 * Adds a condition to a filter. The same test is never added twice: the same condition again
 * changes nothing, and the opposite one (include where there is an exclude, or the reverse) flips
 * the one that is there.
 */
export function addCondition(
  filters: ContentFilters | undefined,
  condition: FilterCondition
): ContentFilters {
  const list = normalizeFilters(filters)
  const wanted = cleanCondition(condition)
  const key = conditionKey(wanted)
  const at = list.findIndex((c) => conditionKey(c) === key)
  if (at < 0) return { conditions: [...list, wanted] }
  list[at] = { ...list[at], exclude: wanted.exclude ? true : undefined }
  return { conditions: list.map(cleanCondition) }
}

/** The condition at `index` of `normalizeFilters`, turned around. */
export function toggleCondition(
  filters: ContentFilters | undefined,
  index: number
): ContentFilters {
  const list = normalizeFilters(filters)
  if (!list[index]) return canonicalFilters(filters)
  list[index] = cleanCondition({ ...list[index], exclude: !list[index].exclude })
  return { conditions: list }
}

export function removeCondition(
  filters: ContentFilters | undefined,
  index: number
): ContentFilters {
  return canonicalFilters({ conditions: normalizeFilters(filters).filter((_, i) => i !== index) })
}

/**
 * The condition for "this field has this value": `<path> == <literal>`, or for a value inside an
 * array `<array path> contains <literal>` (an index is not a stable way to find a value).
 */
export function valueCondition(
  target: { path: string; value: string | number | boolean | null; arrayPath?: string },
  exclude: boolean
): FilterCondition {
  const expr = target.arrayPath
    ? `${target.arrayPath} contains ${jsonPathLiteral(target.value)}`
    : `${target.path} == ${jsonPathLiteral(target.value)}`
  return exclude ? { kind: 'jsonPath', expr, exclude: true } : { kind: 'jsonPath', expr }
}

/** Checks one condition before a scan starts: an error message, or undefined when it is valid. */
export function validateCondition(c: FilterCondition): string | undefined {
  try {
    if (c.kind === 'regex' && c.expr) new RegExp(c.expr)
    else if (c.kind === 'jsonPath' && c.expr.trim()) parseJsonPathFilter(c.expr)
  } catch (err) {
    return (err as Error).message
  }
  return undefined
}

export interface ConditionError {
  /** The position in `normalizeFilters(filters)`. */
  index: number
  message: string
}

/** Checks filter expressions before a scan starts, one error per invalid condition. */
export function validateFilters(filters: ContentFilters): ConditionError[] {
  const errors: ConditionError[] = []
  normalizeFilters(filters).forEach((c, index) => {
    const message = validateCondition(c)
    if (message) errors.push({ index, message })
  })
  return errors
}

const KIND_LABEL = { jsonPath: 'JSONPath', contains: 'Payload contains', regex: 'Payload matches' }

/** Short text for a chip or a list: "JSONPath $.a == 1", "Header X = y". Without the "not". */
export function describeCondition(c: FilterCondition): string {
  if (c.kind === 'header') return c.value ? `Header ${c.key} = ${c.value}` : `Has header ${c.key}`
  if (c.kind === 'contains') return `${KIND_LABEL.contains} "${c.expr}"`
  if (c.kind === 'regex') return `${KIND_LABEL.regex} /${c.expr}/`
  return `${KIND_LABEL.jsonPath} ${c.expr}`
}

export interface FilterVerdict {
  match: boolean
  /** True when a (non-excluding) JSONPath condition rejected the message because it is not JSON. */
  nonJson: boolean
}

export type CompiledFilter = (headers: Header[], payload: Uint8Array) => FilterVerdict

type Outcome = 'yes' | 'no' | 'nonJson'

interface Subject {
  headers: Header[]
  text: () => string
  json: () => { ok: true; doc: unknown } | { ok: false }
}

/**
 * Compiles filters once so a scan does not re-parse them per message. Throws on invalid input.
 *
 * Conditions are checked in order and the first one that fails ends the check. An include
 * condition fails when it does not match; an exclude condition fails when it matches. A JSONPath
 * condition on a payload that is not JSON does not match, so as an include it rejects the message
 * (and counts it in `nonJson`) and as an exclude it lets the message through.
 */
export function compileFilters(filters: ContentFilters): CompiledFilter {
  const tests = normalizeFilters(filters).map((c): [boolean, (s: Subject) => Outcome] => {
    const exclude = c.exclude === true
    if (c.kind === 'header') {
      const key = c.key.trim().toLowerCase()
      const value = c.value
      return [
        exclude,
        ({ headers }) => {
          const found = headers.filter(([k]) => k.toLowerCase() === key)
          if (found.length === 0) return 'no'
          return !value || found.some(([, v]) => v === value) ? 'yes' : 'no'
        }
      ]
    }
    if (c.kind === 'contains') {
      const needle = c.expr.toLowerCase()
      return [exclude, (s) => (s.text().toLowerCase().includes(needle) ? 'yes' : 'no')]
    }
    if (c.kind === 'regex') {
      const regex = new RegExp(c.expr)
      return [exclude, (s) => (regex.test(s.text()) ? 'yes' : 'no')]
    }
    const path: JsonPathFilter = parseJsonPathFilter(c.expr)
    return [
      exclude,
      (s) => {
        const parsed = s.json()
        if (!parsed.ok) return 'nonJson'
        return matchesJsonPath(path, parsed.doc) ? 'yes' : 'no'
      }
    ]
  })

  return (headers, payload) => {
    if (tests.length === 0) return { match: true, nonJson: false }
    let text: string | undefined
    let json: ReturnType<Subject['json']> | undefined
    const subject: Subject = {
      headers,
      text: () => (text ??= utf8Decode(payload)),
      json: () => {
        if (json) return json
        try {
          json = { ok: true, doc: JSON.parse(subject.text()) }
        } catch {
          json = { ok: false }
        }
        return json
      }
    }
    for (const [exclude, test] of tests) {
      const outcome = test(subject)
      if (exclude) {
        if (outcome === 'yes') return { match: false, nonJson: false }
      } else if (outcome === 'no') return { match: false, nonJson: false }
      else if (outcome === 'nonJson') return { match: false, nonJson: true }
    }
    return { match: true, nonJson: false }
  }
}
