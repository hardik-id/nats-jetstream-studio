import { describe, expect, it } from 'vitest'
import type { Favorite } from '@renderer/lib/favorites'
import type { SavedFilter } from '@renderer/lib/messages'
import {
  buildSavedExport,
  describeSaved,
  mergeSavedExport,
  parseSavedExport,
  serializeSavedExport
} from '@renderer/lib/savedExport'

const FILTERS: SavedFilter[] = [
  { name: 'EU paid', subject: 'orders.eu.paid', filters: {} },
  {
    name: 'Big gifts',
    subject: 'orders.>',
    filters: {
      headers: [{ key: 'X-Gift', value: 'yes' }, { key: 'Nats-Msg-Id' }],
      payloadContains: 'total',
      payloadRegex: '"total":\\s*\\d{4,}',
      jsonPath: '$.items[*].sku'
    }
  },
  { name: 'Header only', subject: '', filters: { headers: [{ key: 'X-Trace' }] } }
]
const FAVORITES: Favorite[] = [
  { kind: 'stream', stream: 'ORDERS' },
  { kind: 'consumer', stream: 'ORDERS', consumer: 'billing' },
  { kind: 'subject', stream: 'ORDERS', subject: 'orders.eu.paid' }
]

/** A valid document with one part replaced, as the text of a file. */
const file = (patch: Record<string, unknown>): string =>
  JSON.stringify({ version: 1, savedFilters: [], favorites: [], ...patch })
const filterFile = (filter: unknown): string => file({ savedFilters: [filter] })
const favoriteFile = (favorite: unknown): string => file({ favorites: [favorite] })

describe('PBI-091 export and import of saved filters and favourites', () => {
  it('round trips through the exported file', () => {
    const text = serializeSavedExport(buildSavedExport(FILTERS, FAVORITES))
    expect(JSON.parse(text)).toEqual({ version: 1, savedFilters: FILTERS, favorites: FAVORITES })
    expect(text.endsWith('\n')).toBe(true)
    expect(parseSavedExport(text)).toEqual({
      version: 1,
      savedFilters: FILTERS,
      favorites: FAVORITES
    })
    expect(parseSavedExport(serializeSavedExport(buildSavedExport([], [])))).toEqual({
      version: 1,
      savedFilters: [],
      favorites: []
    })
  })

  it('copies only the fields it knows, out and in', () => {
    const extra = { name: 'A', subject: 'a.b', filters: { payloadContains: 'x', evil: 1 }, id: 7 }
    const starred = { kind: 'stream', stream: 'S', consumer: 'ignored', onSelect: 'alert(1)' }
    const exported = buildSavedExport(
      [extra as unknown as SavedFilter],
      [starred as unknown as Favorite]
    )
    expect(exported.savedFilters).toEqual([
      { name: 'A', subject: 'a.b', filters: { payloadContains: 'x' } }
    ])
    expect(exported.favorites).toEqual([{ kind: 'stream', stream: 'S' }])

    const parsed = parseSavedExport(
      JSON.stringify({ version: 1, savedFilters: [extra], favorites: [starred], other: true })
    )
    expect(parsed).toEqual({
      version: 1,
      savedFilters: [{ name: 'A', subject: 'a.b', filters: { payloadContains: 'x' } }],
      favorites: [{ kind: 'stream', stream: 'S' }]
    })
  })

  it('trims names and subjects, as the studio does when they are typed', () => {
    const parsed = parseSavedExport(
      file({
        savedFilters: [
          {
            name: '  EU paid ',
            subject: ' orders.eu.paid ',
            filters: { headers: [{ key: ' K ' }] }
          }
        ],
        favorites: [{ kind: 'consumer', stream: ' ORDERS ', consumer: ' billing ' }]
      })
    )
    expect(parsed.savedFilters).toEqual([
      { name: 'EU paid', subject: 'orders.eu.paid', filters: { headers: [{ key: 'K' }] } }
    ])
    expect(parsed.favorites).toEqual([{ kind: 'consumer', stream: 'ORDERS', consumer: 'billing' }])
  })

  it('refuses a file that is not an export, and says why', () => {
    expect(() => parseSavedExport('{"version": 1,')).toThrow('This file is not valid JSON.')
    for (const text of ['[]', 'null', '"text"', '42'])
      expect(() => parseSavedExport(text)).toThrow(
        'This file is not an export of saved filters and favourites.'
      )
    expect(() => parseSavedExport('{"savedFilters": [], "favorites": []}')).toThrow(
      /has no version number/
    )
    expect(() => parseSavedExport(file({ version: 2 }))).toThrow(
      'This file has version 2. Only version 1 can be imported.'
    )
    expect(() => parseSavedExport(file({ version: '1' }))).toThrow(/has version "1"/)
    expect(() => parseSavedExport('{"version": 1, "favorites": []}')).toThrow(
      '"savedFilters" must be a list.'
    )
    expect(() => parseSavedExport(file({ savedFilters: { name: 'x' } }))).toThrow(
      '"savedFilters" must be a list.'
    )
    expect(() => parseSavedExport('{"version": 1, "savedFilters": []}')).toThrow(
      '"favorites" must be a list.'
    )
    expect(() => parseSavedExport(file({ favorites: 'ORDERS' }))).toThrow(
      '"favorites" must be a list.'
    )
  })

  it('refuses saved filters of the wrong shape', () => {
    const ok = { name: 'A', subject: '', filters: {} }
    expect(parseSavedExport(filterFile(ok)).savedFilters).toEqual([ok])

    expect(() => parseSavedExport(filterFile('A'))).toThrow('Saved filter 1 is not an object.')
    expect(() => parseSavedExport(filterFile(null))).toThrow('Saved filter 1 is not an object.')
    expect(() => parseSavedExport(file({ savedFilters: [ok, ['A']] }))).toThrow(
      'Saved filter 2 is not an object.'
    )
    for (const name of [undefined, '', '   ', 7, null, ['A']])
      expect(() => parseSavedExport(filterFile({ ...ok, name }))).toThrow(
        'Saved filter 1 has no name.'
      )
    for (const subject of [undefined, 7, null, ['a']])
      expect(() => parseSavedExport(filterFile({ ...ok, subject }))).toThrow(
        'Saved filter "A" has no "subject" text.'
      )
    expect(() => parseSavedExport(filterFile({ ...ok, subject: 'orders..paid' }))).toThrow(
      'Saved filter "A" has an invalid subject. Subject cannot have empty tokens.'
    )
    expect(() => parseSavedExport(filterFile({ ...ok, subject: 'orders.>.paid' }))).toThrow(
      'Saved filter "A" has an invalid subject. ">" is only allowed as the last token.'
    )
    expect(() => parseSavedExport(filterFile({ ...ok, subject: 'orders eu' }))).toThrow(
      /invalid subject\. Subject cannot contain whitespace\./
    )
    for (const filters of [undefined, null, 'x', []])
      expect(() => parseSavedExport(filterFile({ ...ok, filters }))).toThrow(
        'Saved filter "A" has no "filters" object.'
      )
  })

  it('refuses content filters of the wrong shape or that the studio could not run', () => {
    const withFilters = (filters: unknown): string =>
      filterFile({ name: 'A', subject: 'a.>', filters })

    expect(() => parseSavedExport(withFilters({ headers: 'X-Gift' }))).toThrow(
      'Saved filter "A" has a "headers" value that is not a list.'
    )
    expect(() => parseSavedExport(withFilters({ headers: ['X-Gift'] }))).toThrow(
      'Saved filter "A" has a header filter that is not an object.'
    )
    for (const key of [undefined, '', ' ', 5])
      expect(() => parseSavedExport(withFilters({ headers: [{ key }] }))).toThrow(
        'Saved filter "A" has a header filter without a header name.'
      )
    expect(() => parseSavedExport(withFilters({ headers: [{ key: 'K', value: 5 }] }))).toThrow(
      'Saved filter "A" has a header filter with a value that is not text.'
    )
    for (const key of ['payloadContains', 'payloadRegex', 'jsonPath'])
      for (const value of [5, null, ['x'], { a: 1 }])
        expect(() => parseSavedExport(withFilters({ [key]: value }))).toThrow(
          `Saved filter "A" has a "${key}" value that is not text.`
        )
    expect(() => parseSavedExport(withFilters({ payloadRegex: '(' }))).toThrow(
      /^Saved filter "A" has an invalid payload regular expression\. .+\.$/
    )
    expect(() => parseSavedExport(withFilters({ jsonPath: 'items[' }))).toThrow(
      /^Saved filter "A" has an invalid JSONPath\. .+\.$/
    )
  })

  it('refuses favourites of the wrong shape', () => {
    expect(() => parseSavedExport(favoriteFile('ORDERS'))).toThrow('Favourite 1 is not an object.')
    expect(() => parseSavedExport(favoriteFile({ kind: 'bucket', stream: 'S' }))).toThrow(
      'Favourite 1 has the unknown kind "bucket". The kind must be "stream", "consumer" or "subject".'
    )
    for (const kind of [undefined, 3, null])
      expect(() => parseSavedExport(favoriteFile({ kind, stream: 'S' }))).toThrow(
        'Favourite 1 has no kind. The kind must be "stream", "consumer" or "subject".'
      )
    for (const stream of [undefined, '', ' ', 9])
      for (const kind of ['stream', 'consumer', 'subject'])
        expect(() =>
          parseSavedExport(favoriteFile({ kind, stream, consumer: 'c', subject: 's' }))
        ).toThrow('Favourite 1 has no stream name.')
    for (const consumer of [undefined, '', 9])
      expect(() =>
        parseSavedExport(favoriteFile({ kind: 'consumer', stream: 'S', consumer }))
      ).toThrow('Favourite 1 has no consumer name.')
    for (const subject of [undefined, '', 9])
      expect(() =>
        parseSavedExport(favoriteFile({ kind: 'subject', stream: 'S', subject }))
      ).toThrow('Favourite 1 has no subject.')
    expect(() =>
      parseSavedExport(
        file({
          favorites: [
            { kind: 'stream', stream: 'S' },
            { kind: 'subject', stream: 'S', subject: 'a.*b' }
          ]
        })
      )
    ).toThrow('Favourite 2 has an invalid subject. Wildcards must be a whole token.')
  })

  it('merges: a saved filter replaces one with the same name, favourites are not duplicated', () => {
    const existing = {
      savedFilters: [
        { name: 'EU paid', subject: 'orders.eu.old', filters: { payloadContains: 'old' } },
        { name: 'Mine', subject: 'mine.>', filters: {} }
      ],
      favorites: [
        { kind: 'stream', stream: 'JOBS' },
        { kind: 'consumer', stream: 'ORDERS', consumer: 'billing' }
      ] satisfies Favorite[]
    }
    const snapshot = structuredClone(existing)
    const merged = mergeSavedExport(existing, buildSavedExport(FILTERS, FAVORITES))

    // The replaced filter keeps its place; new ones follow in the order of the file.
    expect(merged.savedFilters).toEqual([
      FILTERS[0],
      existing.savedFilters[1],
      FILTERS[1],
      FILTERS[2]
    ])
    expect(merged.importedFilters).toBe(3)
    expect(merged.favorites).toEqual([...existing.favorites, FAVORITES[0], FAVORITES[2]])
    expect(merged.importedFavorites).toBe(2)
    // The lists that were passed in are not changed.
    expect(existing).toEqual(snapshot)
  })

  it('merges a file that repeats itself only once', () => {
    const twice = buildSavedExport(
      [FILTERS[0], { ...FILTERS[0], subject: 'orders.eu.later' }],
      [FAVORITES[0], FAVORITES[0], FAVORITES[1]]
    )
    const merged = mergeSavedExport({ savedFilters: [], favorites: [] }, twice)
    expect(merged.savedFilters).toEqual([{ ...FILTERS[0], subject: 'orders.eu.later' }])
    expect(merged.importedFilters).toBe(1)
    expect(merged.favorites).toEqual([FAVORITES[0], FAVORITES[1]])
    expect(merged.importedFavorites).toBe(2)
  })

  it('importing the same file again adds no favourites', () => {
    const doc = buildSavedExport(FILTERS, FAVORITES)
    const once = mergeSavedExport({ savedFilters: [], favorites: [] }, doc)
    const again = mergeSavedExport(once, doc)
    expect(again.savedFilters).toEqual(FILTERS)
    expect(again.favorites).toEqual(FAVORITES)
    expect(again.importedFavorites).toBe(0)
    expect(mergeSavedExport(once, buildSavedExport([], FAVORITES))).toMatchObject({
      importedFilters: 0,
      importedFavorites: 0
    })
  })

  it('describes what was exported or imported', () => {
    expect(describeSaved(2, 1)).toBe('2 saved filters and 1 favourite')
    expect(describeSaved(1, 3)).toBe('1 saved filter and 3 favourites')
    expect(describeSaved(3, 0)).toBe('3 saved filters')
    expect(describeSaved(0, 1)).toBe('1 favourite')
    expect(describeSaved(0, 0)).toBe('')
  })
})
