import type { ContentFilters, FilterCondition, HeaderFilter } from '@shared/api'
import {
  canonicalFilters,
  MAX_CONDITIONS,
  normalizeFilters,
  validateCondition
} from '@shared/filters'
import { formatCount } from '@shared/format'
import { validateSubject } from '@shared/subject'
import { favoriteKey, MAX_FAVORITES, type Favorite } from './favorites'
import { MAX_SAVED_FILTER_NAME, MAX_SAVED_FILTERS, type SavedFilter } from './messages'

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

// Only the fields the studio knows are copied, on the way out and on the way in. A filter is
// always written as a list of conditions; the single fields of older files are read on import.
function copyFilters(filters: ContentFilters): ContentFilters {
  return canonicalFilters(filters)
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

function parseCondition(c: unknown, where: string): FilterCondition {
  if (!isRecord(c)) throw new Error(`${where} has a condition that is not an object.`)
  if (c.exclude !== undefined && typeof c.exclude !== 'boolean')
    throw new Error(`${where} has a condition with an "exclude" value that is not true or false.`)
  const exclude = c.exclude === true ? { exclude: true } : {}
  if (c.kind === 'header') {
    if (!isText(c.key) || c.key.trim() === '')
      throw new Error(`${where} has a header condition without a header name.`)
    if (c.value !== undefined && !isText(c.value))
      throw new Error(`${where} has a header condition with a value that is not text.`)
    return {
      kind: 'header',
      key: c.key.trim(),
      ...(c.value === undefined ? {} : { value: c.value }),
      ...exclude
    }
  }
  if (c.kind !== 'jsonPath' && c.kind !== 'contains' && c.kind !== 'regex' && c.kind !== 'subject')
    throw new Error(
      `${where} has a condition ${isText(c.kind) ? `of the unknown kind "${c.kind}"` : 'without a kind'}. ` +
        'The kind must be "jsonPath", "contains", "regex", "subject" or "header".'
    )
  if (!isText(c.expr)) throw new Error(`${where} has a ${c.kind} condition without text.`)
  return { kind: c.kind, expr: c.expr, ...exclude }
}

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
  if (value.conditions !== undefined) {
    if (!Array.isArray(value.conditions))
      throw new Error(`${where} has a "conditions" value that is not a list.`)
    if (value.conditions.length > MAX_CONDITIONS)
      throw new Error(`${where} has more than ${MAX_CONDITIONS} conditions.`)
    out.conditions = value.conditions.map((c: unknown) => parseCondition(c, where))
  }
  for (const c of normalizeFilters(out)) {
    const message = validateCondition(c)
    if (!message) continue
    if (c.kind === 'subject')
      throw new Error(`${where} has an invalid subject condition. ${withStop(message)}`)
    if (c.kind === 'regex')
      throw new Error(`${where} has an invalid payload regular expression. ${withStop(message)}`)
    throw new Error(`${where} has an invalid JSONPath. ${withStop(message)}`)
  }
  return canonicalFilters(out)
}

function parseSavedFilter(value: unknown, index: number): SavedFilter {
  if (!isRecord(value)) throw new Error(`Saved filter ${index + 1} is not an object.`)
  if (!isText(value.name) || value.name.trim() === '')
    throw new Error(`Saved filter ${index + 1} has no name.`)
  const name = value.name.trim()
  if (name.length > MAX_SAVED_FILTER_NAME)
    throw new Error(
      `Saved filter ${index + 1} has a name of ${formatCount(name.length)} characters. ` +
        `A name can have at most ${MAX_SAVED_FILTER_NAME}.`
    )
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
  // Checked before the entries are read, so a huge list is refused without walking through it.
  if (doc.savedFilters.length > MAX_SAVED_FILTERS)
    throw new Error(
      `This file has ${formatCount(doc.savedFilters.length)} saved filters. ` +
        `At most ${formatCount(MAX_SAVED_FILTERS)} can be imported.`
    )
  if (doc.favorites.length > MAX_FAVORITES)
    throw new Error(
      `This file has ${formatCount(doc.favorites.length)} favourites. ` +
        `At most ${formatCount(MAX_FAVORITES)} can be imported.`
    )
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
  /** How many of those took the place of a saved filter that was already there. */
  replacedFilters: number
  /** Favourites from the file that were not there before. */
  importedFavorites: number
}

/**
 * Adds an imported document to what a connection already has. A saved filter replaces an
 * existing one with the same name (in place, so the menu keeps its order); a favourite that is
 * already there is left alone.
 *
 * Throws an Error that says why when the import would leave the connection with more saved
 * filters or favourites than it can have.
 */
export function mergeSavedExport(
  existing: { savedFilters: SavedFilter[]; favorites: Favorite[] },
  imported: SavedExport
): SavedMerge {
  const existingNames = new Set(existing.savedFilters.map((s) => s.name))
  const byName = new Map(existing.savedFilters.map((s) => [s.name, s]))
  const importedNames = new Set<string>()
  for (const filter of imported.savedFilters) {
    byName.set(filter.name, filter)
    importedNames.add(filter.name)
  }
  const replacedFilters = [...importedNames].filter((name) => existingNames.has(name)).length

  const favorites = [...existing.favorites]
  const keys = new Set(favorites.map(favoriteKey))
  for (const favorite of imported.favorites) {
    const key = favoriteKey(favorite)
    if (keys.has(key)) continue
    keys.add(key)
    favorites.push(favorite)
  }
  const importedFavorites = favorites.length - existing.favorites.length

  // Only what the file adds can push a list over its limit; replacing never does.
  if (importedNames.size > replacedFilters && byName.size > MAX_SAVED_FILTERS)
    throw new Error(
      `This import would give the connection ${formatCount(byName.size)} saved filters. ` +
        `It can have at most ${formatCount(MAX_SAVED_FILTERS)}.`
    )
  if (importedFavorites > 0 && favorites.length > MAX_FAVORITES)
    throw new Error(
      `This import would give the connection ${formatCount(favorites.length)} favourites. ` +
        `It can have at most ${formatCount(MAX_FAVORITES)}.`
    )

  return {
    savedFilters: [...byName.values()],
    favorites,
    importedFilters: importedNames.size,
    replacedFilters,
    importedFavorites
  }
}

const countOf = (n: number, one: string): string => `${formatCount(n)} ${one}${n === 1 ? '' : 's'}`

/** "2 saved filters and 1 favourite", for confirmations. Empty when both counts are zero. */
export function describeSaved(filters: number, favorites: number): string {
  return [
    ...(filters ? [countOf(filters, 'saved filter')] : []),
    ...(favorites ? [countOf(favorites, 'favourite')] : [])
  ].join(' and ')
}

/**
 * "Imported 3 saved filters (1 replaced) and 2 favourites": what an import did, including how
 * many saved filters that were already there it replaced.
 */
export function describeImport(
  merge: Pick<SavedMerge, 'importedFilters' | 'replacedFilters' | 'importedFavorites'>
): string {
  const replaced = merge.replacedFilters ? ` (${formatCount(merge.replacedFilters)} replaced)` : ''
  return `Imported ${[
    ...(merge.importedFilters ? [countOf(merge.importedFilters, 'saved filter') + replaced] : []),
    ...(merge.importedFavorites ? [countOf(merge.importedFavorites, 'favourite')] : [])
  ].join(' and ')}`
}
