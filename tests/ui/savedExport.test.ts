import { describe, expect, it } from 'vitest'
import { MAX_FAVORITES, type Favorite } from '@renderer/lib/favorites'
import { MAX_SAVED_FILTER_NAME, MAX_SAVED_FILTERS, type SavedFilter } from '@renderer/lib/messages'
import {
  buildSavedExport,
  describeImport,
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
      conditions: [
        { kind: 'header', key: 'X-Gift', value: 'yes' },
        { kind: 'header', key: 'Nats-Msg-Id' },
        { kind: 'contains', expr: 'total' },
        { kind: 'regex', expr: '"total":\\s*\\d{4,}' },
        { kind: 'jsonPath', expr: '$.items[*].sku' },
        { kind: 'jsonPath', expr: '$.status == "cancelled"', exclude: true },
        { kind: 'header', key: 'X-Test', value: '1', exclude: true }
      ]
    }
  },
  {
    name: 'Header only',
    subject: '',
    filters: { conditions: [{ kind: 'header', key: 'X-Trace' }] }
  }
]
// The shape before PBI-126: single fields. Saved in settings and exported files look like this.
const LEGACY_FILTER = {
  name: 'Old style',
  subject: 'orders.>',
  filters: {
    headers: [{ key: 'X-Gift', value: 'yes' }, { key: 'Nats-Msg-Id' }],
    payloadContains: 'total',
    payloadRegex: '"total":\\s*\\d{4,}',
    jsonPath: '$.items[*].sku'
  }
}
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

  it('imports its own export when a subject has "*" or ">" inside a token', () => {
    // NATS reads a wildcard only in a token that is exactly "*" or ">". Inside a longer token
    // the characters are ordinary text, the studio can store such subjects, and so it has to
    // take them back from a file it wrote itself.
    const filters: SavedFilter[] = [
      {
        name: 'Hot CPUs',
        subject: 'alerts.cpu>90',
        filters: { conditions: [{ kind: 'contains', expr: 'host' }] }
      },
      { name: 'Starred', subject: 'notes.a*b.>', filters: {} },
      { name: 'Odd tokens', subject: '*a.>b.c*.**', filters: {} }
    ]
    const favorites: Favorite[] = [
      { kind: 'subject', stream: 'ALERTS', subject: 'alerts.cpu>90' },
      { kind: 'subject', stream: 'NOTES', subject: 'notes.a*b.draft' },
      { kind: 'subject', stream: 'NOTES', subject: 'notes.*.>' }
    ]
    const text = serializeSavedExport(buildSavedExport(filters, favorites))
    const parsed = parseSavedExport(text)
    expect(parsed).toEqual({ version: 1, savedFilters: filters, favorites })

    // And all the way back into a connection that has nothing yet.
    const merged = mergeSavedExport({ savedFilters: [], favorites: [] }, parsed)
    expect(merged.savedFilters).toEqual(filters)
    expect(merged.favorites).toEqual(favorites)
    expect(merged).toMatchObject({ importedFilters: 3, replacedFilters: 0, importedFavorites: 3 })
    // Exporting what was imported gives the same file again.
    expect(serializeSavedExport(buildSavedExport(merged.savedFilters, merged.favorites))).toBe(text)
  })

  it('copies only the fields it knows, out and in', () => {
    const extra = { name: 'A', subject: 'a.b', filters: { payloadContains: 'x', evil: 1 }, id: 7 }
    const starred = { kind: 'stream', stream: 'S', consumer: 'ignored', onSelect: 'alert(1)' }
    const exported = buildSavedExport(
      [extra as unknown as SavedFilter],
      [starred as unknown as Favorite]
    )
    expect(exported.savedFilters).toEqual([
      { name: 'A', subject: 'a.b', filters: { conditions: [{ kind: 'contains', expr: 'x' }] } }
    ])
    expect(exported.favorites).toEqual([{ kind: 'stream', stream: 'S' }])

    const parsed = parseSavedExport(
      JSON.stringify({ version: 1, savedFilters: [extra], favorites: [starred], other: true })
    )
    expect(parsed).toEqual({
      version: 1,
      savedFilters: [
        { name: 'A', subject: 'a.b', filters: { conditions: [{ kind: 'contains', expr: 'x' }] } }
      ],
      favorites: [{ kind: 'stream', stream: 'S' }]
    })
  })

  it('still imports a file with the filters of before PBI-126 and writes them as conditions', () => {
    const parsed = parseSavedExport(file({ savedFilters: [LEGACY_FILTER] }))
    expect(parsed.savedFilters).toEqual([
      {
        name: 'Old style',
        subject: 'orders.>',
        filters: { conditions: FILTERS[1].filters.conditions?.slice(0, 5) }
      }
    ])
    // Exporting what was imported uses the new shape only.
    const again = JSON.parse(serializeSavedExport(buildSavedExport(parsed.savedFilters, [])))
    expect(again.savedFilters[0].filters).not.toHaveProperty('jsonPath')
    expect(again.savedFilters[0].filters).toHaveProperty('conditions')
    // Old and new fields in one filter are both kept, old ones first.
    const mixed = parseSavedExport(
      file({
        savedFilters: [
          {
            name: 'M',
            subject: '',
            filters: {
              payloadContains: 'a',
              conditions: [{ kind: 'contains', expr: 'b', exclude: true }]
            }
          }
        ]
      })
    )
    expect(mixed.savedFilters[0].filters.conditions).toEqual([
      { kind: 'contains', expr: 'a' },
      { kind: 'contains', expr: 'b', exclude: true }
    ])
  })

  it('refuses a condition that is not valid', () => {
    const bad = (conditions: unknown): string =>
      file({ savedFilters: [{ name: 'A', subject: '', filters: { conditions } }] })
    expect(() => parseSavedExport(bad('x'))).toThrow('"conditions" value that is not a list')
    expect(() => parseSavedExport(bad([{ kind: 'nope', expr: 'x' }]))).toThrow(
      'unknown kind "nope"'
    )
    expect(() => parseSavedExport(bad([{ kind: 'regex', expr: '(' }]))).toThrow(
      'invalid payload regular expression'
    )
    expect(() => parseSavedExport(bad([{ kind: 'jsonPath', expr: 'nope' }]))).toThrow(
      'invalid JSONPath'
    )
    expect(() => parseSavedExport(bad([{ kind: 'contains', expr: 'x', exclude: 'yes' }]))).toThrow(
      '"exclude"'
    )
    expect(() => parseSavedExport(bad([{ kind: 'header' }]))).toThrow('without a header name')
    expect(() => parseSavedExport(bad([{ kind: 'subject', expr: 'a..b' }]))).toThrow(
      'invalid subject condition'
    )
  })

  it('keeps a subject condition (PBI-129)', () => {
    const parsed = parseSavedExport(
      file({
        savedFilters: [
          {
            name: 'A',
            subject: '',
            filters: { conditions: [{ kind: 'subject', expr: 'a.*', exclude: true }] }
          }
        ]
      })
    )
    expect(parsed.savedFilters[0].filters.conditions).toEqual([
      { kind: 'subject', expr: 'a.*', exclude: true }
    ])
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
      {
        name: 'EU paid',
        subject: 'orders.eu.paid',
        filters: { conditions: [{ kind: 'header', key: 'K' }] }
      }
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
            { kind: 'subject', stream: 'S', subject: 'a.>.b' }
          ]
        })
      )
    ).toThrow('Favourite 2 has an invalid subject. ">" is only allowed as the last token.')
    expect(() =>
      parseSavedExport(favoriteFile({ kind: 'subject', stream: 'S', subject: 'a..b' }))
    ).toThrow('Favourite 1 has an invalid subject. Subject cannot have empty tokens.')
  })

  it('refuses a name that is too long and lists that are too large, and says so', () => {
    const ok = { name: 'A', subject: '', filters: {} }
    const longest = 'n'.repeat(MAX_SAVED_FILTER_NAME)
    expect(MAX_SAVED_FILTER_NAME).toBe(120)
    expect(parseSavedExport(filterFile({ ...ok, name: longest })).savedFilters[0].name).toBe(
      longest
    )
    // The length is counted after trimming, as the name is stored.
    expect(
      parseSavedExport(filterFile({ ...ok, name: `  ${longest}  ` })).savedFilters[0].name
    ).toBe(longest)
    expect(() =>
      parseSavedExport(file({ savedFilters: [ok, { ...ok, name: longest + 'n' }] }))
    ).toThrow('Saved filter 2 has a name of 121 characters. A name can have at most 120.')
    // The message does not repeat a name of any length back to the user.
    const huge = (): void => {
      parseSavedExport(filterFile({ ...ok, name: 'x'.repeat(5000) }))
    }
    expect(huge).toThrow('Saved filter 1 has a name of 5,000 characters.')
    expect(huge).not.toThrow(/xxxxx/)

    const manyFilters = (n: number): unknown[] =>
      Array.from({ length: n }, (_, i) => ({ ...ok, name: `F${i}` }))
    const manyFavorites = (n: number): unknown[] =>
      Array.from({ length: n }, (_, i) => ({ kind: 'stream', stream: `S${i}` }))
    expect(MAX_SAVED_FILTERS).toBe(500)
    expect(MAX_FAVORITES).toBe(2000)
    expect(parseSavedExport(file({ savedFilters: manyFilters(500) })).savedFilters).toHaveLength(
      500
    )
    expect(parseSavedExport(file({ favorites: manyFavorites(2000) })).favorites).toHaveLength(2000)
    expect(() => parseSavedExport(file({ savedFilters: manyFilters(501) }))).toThrow(
      'This file has 501 saved filters. At most 500 can be imported.'
    )
    expect(() => parseSavedExport(file({ favorites: manyFavorites(2001) }))).toThrow(
      'This file has 2,001 favourites. At most 2,000 can be imported.'
    )
    // The size is checked before the entries, so nonsense in a huge list is never looked at.
    expect(() => parseSavedExport(file({ favorites: Array(50_000).fill(null) }))).toThrow(
      'This file has 50,000 favourites. At most 2,000 can be imported.'
    )
  })

  it('refuses an import that would take a connection over its limits', () => {
    const filter = (i: number): SavedFilter => ({ name: `F${i}`, subject: '', filters: {} })
    const star = (i: number): Favorite => ({ kind: 'stream', stream: `S${i}` })
    const range = <T>(from: number, to: number, make: (i: number) => T): T[] =>
      Array.from({ length: to - from }, (_, i) => make(from + i))

    const existing = { savedFilters: range(0, 400, filter), favorites: range(0, 1990, star) }
    // 400 + 100 new = 500 and 1,990 + 10 new = 2,000: exactly at the limits.
    const fits = mergeSavedExport(
      existing,
      buildSavedExport(range(350, 500, filter), range(1980, 2000, star))
    )
    expect(fits.savedFilters).toHaveLength(500)
    expect(fits.favorites).toHaveLength(2000)
    expect(fits).toMatchObject({ importedFilters: 150, replacedFilters: 50, importedFavorites: 10 })

    expect(() => mergeSavedExport(existing, buildSavedExport(range(350, 501, filter), []))).toThrow(
      'This import would give the connection 501 saved filters. It can have at most 500.'
    )
    expect(() => mergeSavedExport(existing, buildSavedExport([], range(1980, 2001, star)))).toThrow(
      'This import would give the connection 2,001 favourites. It can have at most 2,000.'
    )
    // Nothing was changed by the refused imports.
    expect(existing.savedFilters).toHaveLength(400)
    expect(existing.favorites).toHaveLength(1990)

    // A connection that is already over a limit can still import what does not add to that list.
    const over = { savedFilters: range(0, 510, filter), favorites: range(0, 2005, star) }
    const replaced = mergeSavedExport(
      over,
      buildSavedExport([{ ...filter(3), subject: 'new.>' }], [star(7)])
    )
    expect(replaced.savedFilters).toHaveLength(510)
    expect(replaced.savedFilters[3].subject).toBe('new.>')
    expect(replaced).toMatchObject({ importedFilters: 1, replacedFilters: 1, importedFavorites: 0 })
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
    // "EU paid" was there before; "Mine" is not in the file, so it is neither.
    expect(merged.replacedFilters).toBe(1)
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
    // The file overwrote its own first entry, not a filter the connection had.
    expect(merged.replacedFilters).toBe(0)
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
    expect(again).toMatchObject({ importedFilters: 3, replacedFilters: 3 })
    expect(mergeSavedExport(once, buildSavedExport([], FAVORITES))).toMatchObject({
      importedFilters: 0,
      replacedFilters: 0,
      importedFavorites: 0
    })
  })

  it('describes what was exported or imported', () => {
    expect(describeSaved(2, 1)).toBe('2 saved filters and 1 favourite')
    expect(describeSaved(1, 3)).toBe('1 saved filter and 3 favourites')
    expect(describeSaved(3, 0)).toBe('3 saved filters')
    expect(describeSaved(0, 1)).toBe('1 favourite')
    expect(describeSaved(0, 0)).toBe('')
    expect(describeSaved(1200, 2000)).toBe('1,200 saved filters and 2,000 favourites')

    const imported = (
      importedFilters: number,
      replacedFilters: number,
      favorites: number
    ): string => describeImport({ importedFilters, replacedFilters, importedFavorites: favorites })
    expect(imported(3, 1, 2)).toBe('Imported 3 saved filters (1 replaced) and 2 favourites')
    expect(imported(3, 0, 2)).toBe('Imported 3 saved filters and 2 favourites')
    expect(imported(1, 1, 0)).toBe('Imported 1 saved filter (1 replaced)')
    expect(imported(2, 2, 1)).toBe('Imported 2 saved filters (2 replaced) and 1 favourite')
    expect(imported(0, 0, 4)).toBe('Imported 4 favourites')
  })
})
