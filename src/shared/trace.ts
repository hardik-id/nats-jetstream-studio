/**
 * Trace (PBI-138): follow a request across subjects and consumers.
 *
 * The types of a trace and the pure rules around them: what a match rule means as a scan filter,
 * which time window a query covers, and whether a query can be run. Nothing here reads a server
 * or touches the screen, so the renderer model and the tests share it.
 */
import type { FilterCondition, MessageDto } from './api'
import { anyItemPath, valueCondition } from './filters'
import { parseJsonPathFilter } from './jsonpath'

/** One way to recognise the value that travels with a request. Rules of a query are ORed. */
export type TraceRule =
  /** A header, such as `trace-id`. An empty value only asks that the header exists. */
  | { kind: 'header'; key: string; value: string }
  /**
   * A field of a JSON payload that equals `value`. `literal` says the value is a number, `true`,
   * `false` or `null` written as such (not a string that looks like one). With `inArray` the path
   * names an array and the rule means "the array contains the value".
   */
  | { kind: 'json'; path: string; value: string; literal?: boolean; inArray?: boolean }
  /** The value anywhere in the payload (case-insensitive). */
  | { kind: 'text'; value: string }

/**
 * The time a trace covers. `around` is centred on the time of the message the trace was started
 * from (`ms` is the half width). `last` ends now and `range` is chosen by hand.
 */
export type TraceWindow =
  | { kind: 'around'; anchor: string; ms: number }
  | { kind: 'last'; ms: number }
  | { kind: 'range'; from: string; to: string }

/** Everything a trace is made from. It is what a tab stores; results are never stored. */
export interface TraceQuery {
  rules: TraceRule[]
  window: TraceWindow
  /** Stream names to search. Absent: every stream (without system streams, see below). */
  streams?: string[]
  /** Also search the buckets of KV and Object Store (streams named `KV_x` and `OBJ_x`). */
  includeSystem?: boolean
  /** Most messages examined per stream and rule. */
  scanLimit?: number
}

/** A stored message found by a trace: the message and the stream it came from. */
export interface TraceMessage extends MessageDto {
  stream: string
  /** `time` as epoch milliseconds, for sorting and gaps. */
  ms: number
}

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

export const DEFAULT_SCAN_LIMIT = 10_000
export const MIN_SCAN_LIMIT = 100
export const MAX_SCAN_LIMIT = 1_000_000
/** Most matches kept per stream; more means the result is partial. */
export const DEFAULT_MATCH_CAP = 500

/** The scan filter that finds the messages one rule matches. */
export function ruleToCondition(rule: TraceRule): FilterCondition {
  switch (rule.kind) {
    case 'header':
      return rule.value
        ? { kind: 'header', key: rule.key.trim(), value: rule.value }
        : { kind: 'header', key: rule.key.trim() }
    case 'text':
      return { kind: 'contains', expr: rule.value }
    case 'json': {
      const value = rule.literal ? (JSON.parse(rule.value) as null) : rule.value
      return valueCondition(
        rule.inArray
          ? { path: '', arrayPath: rule.path.trim(), value }
          : { path: rule.path.trim(), value },
        false
      )
    }
  }
}

/** The rule in a few words: `Header trace-id = abc`, `$.id == "A-1"`, `Text "abc"`. */
export function describeRule(rule: TraceRule): string {
  switch (rule.kind) {
    case 'header':
      return rule.value ? `${rule.key} = ${rule.value}` : `has header ${rule.key}`
    case 'text':
      return `"${rule.value}"`
    case 'json':
      return `${rule.path} ${rule.inArray ? 'contains' : '=='} ${rule.value}`
  }
}

/** The value a rule looks for, for titles and labels. */
export function ruleValue(rule: TraceRule): string {
  return rule.kind === 'header' && !rule.value ? rule.key : rule.value
}

/** The tab title: "Trace", or "Trace <value>" once there is something to follow. */
export function traceTitle(query?: TraceQuery): string {
  const first = query?.rules.find((r) => ruleValue(r).trim() !== '')
  if (!first) return 'Trace'
  const value = ruleValue(first)
  return `Trace ${value.length > 24 ? value.slice(0, 24) + '...' : value}`
}

/** The window as the times a scan needs: `from` always, `to` unless the window runs to now. */
export function windowFor(window: TraceWindow, now: number): { from: string; to?: string } {
  switch (window.kind) {
    case 'around': {
      const at = new Date(window.anchor).getTime()
      return {
        from: new Date(at - window.ms).toISOString(),
        to: new Date(at + window.ms).toISOString()
      }
    }
    case 'last':
      return { from: new Date(now - window.ms).toISOString() }
    case 'range':
      return { from: new Date(window.from).toISOString(), to: new Date(window.to).toISOString() }
  }
}

/** The scan limit a query asks for, kept within bounds. */
export function scanLimitOf(query: TraceQuery): number {
  const n = Math.floor(query.scanLimit ?? DEFAULT_SCAN_LIMIT)
  return Math.min(Math.max(n, MIN_SCAN_LIMIT), MAX_SCAN_LIMIT)
}

function validateRule(rule: TraceRule): string | undefined {
  switch (rule.kind) {
    case 'header':
      return rule.key.trim() ? undefined : 'Enter the name of the header'
    case 'text':
      return rule.value.trim() ? undefined : 'Enter the text to look for'
    case 'json':
      if (!rule.path.trim()) return 'Enter the JSON path, for example $.order.id'
      if (rule.value === '') return 'Enter the value the field must have'
      try {
        // The scan parses the condition; doing it here reports a typo before anything runs.
        const condition = ruleToCondition(rule)
        if (condition.kind === 'jsonPath') parseJsonPathFilter(condition.expr)
      } catch (err) {
        return rule.literal
          ? 'The value is not a number, true, false or null'
          : (err as Error).message
      }
      return undefined
  }
}

/** Why a query cannot run yet, or undefined when it can. */
export function validateTraceQuery(query: TraceQuery): string | undefined {
  if (query.rules.length === 0) return 'Add something to match'
  if (query.streams && query.streams.length === 0) return 'Choose at least one stream'
  for (const rule of query.rules) {
    const problem = validateRule(rule)
    if (problem) return problem
  }
  const w = query.window
  if (w.kind === 'around') {
    if (Number.isNaN(new Date(w.anchor).getTime()))
      return 'The time to centre the window on is not valid'
    if (!(w.ms > 0)) return 'The window must be longer than zero'
  } else if (w.kind === 'last') {
    if (!(w.ms > 0)) return 'The window must be longer than zero'
  } else {
    const from = new Date(w.from).getTime()
    const to = new Date(w.to).getTime()
    if (Number.isNaN(from) || Number.isNaN(to)) return 'Choose a start and an end for the window'
    if (to <= from) return 'The window must end after it starts'
  }
  return undefined
}

/** The rule for "follow this header": the header and its value. */
export function headerRule(key: string, value: string): TraceRule {
  return { kind: 'header', key, value }
}

/**
 * The rule for "follow this JSON value". Array steps of the path become `[*]` (any item), as in the
 * filter buttons; a value that is directly in an array is found with "the array contains it".
 */
export function jsonRule(target: {
  path: string
  value: string | number | boolean | null
  arrayPath?: string
}): TraceRule {
  const inArray = target.arrayPath !== undefined
  const path = anyItemPath(inArray ? target.arrayPath! : target.path)
  const text = typeof target.value === 'string' ? target.value : JSON.stringify(target.value)
  const literal = typeof target.value !== 'string'
  return {
    kind: 'json',
    path,
    value: text,
    ...(literal ? { literal: true } : {}),
    ...(inArray ? { inArray: true } : {})
  }
}
