import type { ContentFilters, HeaderFilter } from '@shared/api'
import { validateFilters } from '@shared/filters'
import { validateSubject } from '@shared/subject'
import { favoriteKey, type Favorite } from './favorites'
import type { SavedFilter } from './messages'

/**
 * The saved filters and favourites of one connection as a JSON file (PBI-091), to move them to
 * another computer or to share them with a colleague.
 */
export interface SavedExport {
  version: 1
  savedFilters: SavedFilter[]
  favorites: Favorite[]
}

const FAVORITE_KINDS = ['stream', 'consumer', 'subject'] as const

// Only the fields the studio knows are copied, on the way out and on the way in.
function copyFilters(filters: ContentFilters): ContentFilters {
  const out: ContentFilters = {}
  if (filters.headers !== undefined)
    out.headers = filters.headers.map((h): HeaderFilter =>
      h.value === undefined ? { key: h.key } : { key: h.key, value: h.value }
    )
  if (filters.payloadContains !== undefined) out.payloadContains = filters.payloadContains
  if (filters.payloadRegex !== undefined) out.payloadRegex = filters.payloadRegex
  if (filters.jsonPath !== undefined) out.jsonPath = filters.jsonPath
  return out
}

function copyFavorite(f: Favorite): Favorite {
  if (f.kind === 'stream') return { kind: 'stream', stream: f.stream }
  if (f.kind === 'consumer') return { kind: 'consumer', stream: f.stream, consumer: f.consumer }
  return { kind: 'subject', stream: f.stream, subject: f.subject }
}

export function buildSavedExport(savedFilters: SavedFilter[], favorites: Favorite[]): SavedExport {
  return {
    version: 1,
    savedFilters: savedFilters.map((s) => ({
      name: s.name,
      subject: s.subject,
      filters: copyFilters(s.filters)
    })),
    favorites: favorites.map(copyFavorite)
  }
}

export function serializeSavedExport(doc: SavedExport): string {
  return JSON.stringify(doc, null, 2) + '\n'
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isText = (value: unknown): value is string => typeof value === 'string'

const withStop = (sentence: string): string => (/[.!?]$/.test(sentence) ? sentence : `${sentence}.`)

function parseFilters(value: unknown, where: string): ContentFilters {
  if (!isRecord(value)) throw new Error(`${where} has no "filters" object.`)
  const out: ContentFilters = {}
  if (value.headers !== undefined) {
    if (!Array.isArray(value.headers))
      throw new Error(`${where} has a "headers" value that is not a list.`)
    out.headers = value.headers.map((h: unknown): HeaderFilter => {
      if (!isRecord(h)) throw new Error(`${where} has a header filter that is not an object.`)
      if (!isText(h.key) || h.key.trim() === '')
        throw new Error(`${where} has a header filter without a header name.`)
      if (h.value !== undefined && !isText(h.value))
        throw new Error(`${where} has a header filter with a value that is not text.`)
      return h.value === undefined ? { key: h.key.trim() } : { key: h.key.trim(), value: h.value }
    })
  }
  for (const key of ['payloadContains', 'payloadRegex', 'jsonPath'] as const) {
    const text = value[key]
    if (text === undefined) continue
    if (!isText(text)) throw new Error(`${where} has a "${key}" value that is not text.`)
    out[key] = text
  }
  const errors = validateFilters(out)
  if (errors.payloadRegex)
    throw new Error(
      `${where} has an invalid payload regular expression. ${withStop(errors.payloadRegex)}`
    )
  if (errors.jsonPath)
    throw new Error(`${where} has an invalid JSONPath. ${withStop(errors.jsonPath)}`)
  return out
}

function parseSavedFilter(value: unknown, index: number): SavedFilter {
  if (!isRecord(value)) throw new Error(`Saved filter ${index + 1} is not an object.`)
  if (!isText(value.name) || value.name.trim() === '')
    throw new Error(`Saved filter ${index + 1} has no name.`)
  const name = value.name.trim()
  const where = `Saved filter "${name}"`
  if (!isText(value.subject)) throw new Error(`${where} has no "subject" text.`)
  const subject = value.subject.trim()
  const subjectError = subject ? validateSubject(subject) : null
  if (subjectError) throw new Error(`${where} has an invalid subject. ${withStop(subjectError)}`)
  return { name, subject, filters: parseFilters(value.filters, where) }
}

function parseFavorite(value: unknown, index: number): Favorite {
  const where = `Favourite ${index + 1}`
  if (!isRecord(value)) throw new Error(`${where} is not an object.`)
  const kind = FAVORITE_KINDS.find((k) => k === value.kind)
  if (!kind)
    throw new Error(
      `${where} has ${isText(value.kind) ? `the unknown kind "${value.kind}"` : 'no kind'}. ` +
        'The kind must be "stream", "consumer" or "subject".'
    )
  const name = (key: 'stream' | 'consumer' | 'subject', label: string): string => {
    const text = value[key]
    if (!isText(text) || text.trim() === '') throw new Error(`${where} has no ${label}.`)
    return text.trim()
  }
  const stream = name('stream', 'stream name')
  if (kind === 'stream') return { kind, stream }
  if (kind === 'consumer') return { kind, stream, consumer: name('consumer', 'consumer name') }
  const subject = name('subject', 'subject')
  const subjectError = validateSubject(subject)
  if (subjectError) throw new Error(`${where} has an invalid subject. ${withStop(subjectError)}`)
  return { kind, stream, subject }
}

/**
 * Reads an exported file. The file is not trusted: anything that is not exactly the export
 * format is refused with an Error whose message says what is wrong, and unknown fields are
 * dropped.
 */
export function parseSavedExport(text: string): SavedExport {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    throw new Error('This file is not valid JSON.')
  }
  if (!isRecord(doc)) throw new Error('This file is not an export of saved filters and favourites.')
  if (doc.version === undefined)
    throw new Error(
      'This file has no version number, so it is not an export of saved filters and favourites.'
    )
  if (doc.version !== 1)
    throw new Error(
      `This file has version ${JSON.stringify(doc.version)}. Only version 1 can be imported.`
    )
  if (!Array.isArray(doc.savedFilters)) throw new Error('"savedFilters" must be a list.')
  if (!Array.isArray(doc.favorites)) throw new Error('"favorites" must be a list.')
  return {
    version: 1,
    savedFilters: doc.savedFilters.map(parseSavedFilter),
    favorites: doc.favorites.map(parseFavorite)
  }
}

export interface SavedMerge {
  savedFilters: SavedFilter[]
  favorites: Favorite[]
  /** Saved filters taken from the file, counting the ones that replaced an existing filter. */
  importedFilters: number
  /** Favourites from the file that were not there before. */
  importedFavorites: number
}

/**
 * Adds an imported document to what a connection already has. A saved filter replaces an
 * existing one with the same name (in place, so the menu keeps its order); a favourite that is
 * already there is left alone.
 */
export function mergeSavedExport(
  existing: { savedFilters: SavedFilter[]; favorites: Favorite[] },
  imported: SavedExport
): SavedMerge {
  const byName = new Map(existing.savedFilters.map((s) => [s.name, s]))
  const importedNames = new Set<string>()
  for (const filter of imported.savedFilters) {
    byName.set(filter.name, filter)
    importedNames.add(filter.name)
  }

  const favorites = [...existing.favorites]
  const keys = new Set(favorites.map(favoriteKey))
  for (const favorite of imported.favorites) {
    const key = favoriteKey(favorite)
    if (keys.has(key)) continue
    keys.add(key)
    favorites.push(favorite)
  }

  return {
    savedFilters: [...byName.values()],
    favorites,
    importedFilters: importedNames.size,
    importedFavorites: favorites.length - existing.favorites.length
  }
}

/** "2 saved filters and 1 favourite", for confirmations. Empty when both counts are zero. */
export function describeSaved(filters: number, favorites: number): string {
  const count = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`
  return [
    ...(filters ? [count(filters, 'saved filter')] : []),
    ...(favorites ? [count(favorites, 'favourite')] : [])
  ].join(' and ')
}
