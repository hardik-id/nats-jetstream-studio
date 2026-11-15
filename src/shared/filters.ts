import type { ContentFilters, Header } from './api'
import { utf8Decode } from './encoding'
import { type JsonPathFilter, matchesJsonPath, parseJsonPathFilter } from './jsonpath'

export type FilterErrors = Partial<Record<'payloadRegex' | 'jsonPath' | 'headers', string>>

export function hasContentFilters(filters: ContentFilters | undefined): boolean {
  if (!filters) return false
  return Boolean(
    (filters.headers && filters.headers.some((h) => h.key.trim() !== '')) ||
    filters.payloadContains ||
    filters.payloadRegex ||
    filters.jsonPath
  )
}

/** Checks filter expressions before a scan starts. An empty object means everything is valid. */
export function validateFilters(filters: ContentFilters): FilterErrors {
  const errors: FilterErrors = {}
  if (filters.payloadRegex) {
    try {
      new RegExp(filters.payloadRegex)
    } catch (err) {
      errors.payloadRegex = (err as Error).message
    }
  }
  if (filters.jsonPath) {
    try {
      parseJsonPathFilter(filters.jsonPath)
    } catch (err) {
      errors.jsonPath = (err as Error).message
    }
  }
  return errors
}

export interface FilterVerdict {
  match: boolean
  /** True when a JSONPath filter was skipped because the payload is not JSON. */
  nonJson: boolean
}

export type CompiledFilter = (headers: Header[], payload: Uint8Array) => FilterVerdict

/** Compiles filters once so a scan does not re-parse them per message. Throws on invalid input. */
export function compileFilters(filters: ContentFilters): CompiledFilter {
  const headerFilters = (filters.headers ?? [])
    .filter((h) => h.key.trim() !== '')
    .map((h) => ({ key: h.key.trim().toLowerCase(), value: h.value }))
  const contains = filters.payloadContains ? filters.payloadContains.toLowerCase() : null
  const regex = filters.payloadRegex ? new RegExp(filters.payloadRegex) : null
  const jsonPath: JsonPathFilter | null = filters.jsonPath
    ? parseJsonPathFilter(filters.jsonPath)
    : null

  return (headers, payload) => {
    for (const filter of headerFilters) {
      const found = headers.filter(([key]) => key.toLowerCase() === filter.key)
      if (found.length === 0) return { match: false, nonJson: false }
      if (
        filter.value !== undefined &&
        filter.value !== '' &&
        !found.some(([, v]) => v === filter.value)
      ) {
        return { match: false, nonJson: false }
      }
    }
    if (!contains && !regex && !jsonPath) return { match: true, nonJson: false }

    const text = utf8Decode(payload)
    if (contains && !text.toLowerCase().includes(contains)) return { match: false, nonJson: false }
    if (regex && !regex.test(text)) return { match: false, nonJson: false }
    if (jsonPath) {
      let doc: unknown
      try {
        doc = JSON.parse(text)
      } catch {
        return { match: false, nonJson: true }
      }
      if (!matchesJsonPath(jsonPath, doc)) return { match: false, nonJson: false }
    }
    return { match: true, nonJson: false }
  }
}
