import { describe, expect, it } from 'vitest'
import type { ContentFilters, FilterCondition } from '@shared/api'
import { utf8Encode } from '@shared/encoding'
import {
  addCondition,
  canonicalFilters,
  compileFilters,
  hasContentFilters,
  normalizeFilters,
  removeCondition,
  toggleCondition,
  validateFilters,
  valueCondition
} from '@shared/filters'
import { jsonPathLiteral, matchesJsonPath, parseJsonPathFilter } from '@shared/jsonpath'
import { formatPath } from '@shared/jsonTree'

const bytes = (doc: unknown): Uint8Array => utf8Encode(JSON.stringify(doc))
const test = (filters: ContentFilters, doc: unknown, headers: [string, string][] = []): boolean =>
  compileFilters(filters)(headers, typeof doc === 'string' ? utf8Encode(doc) : bytes(doc)).match

describe('PBI-126 normalising filters', () => {
  it('turns the single fields of older filters into conditions, in the order they were checked', () => {
    const old: ContentFilters = {
      jsonPath: ' $.a == 1 ',
      payloadRegex: 'x+',
      payloadContains: 'hi',
      headers: [{ key: ' Trace-Id ', value: 'abc' }, { key: 'Region' }, { key: ' ' }]
    }
    expect(normalizeFilters(old)).toEqual([
      { kind: 'header', key: 'Trace-Id', value: 'abc' },
      { kind: 'header', key: 'Region' },
      { kind: 'contains', expr: 'hi' },
      { kind: 'regex', expr: 'x+' },
      { kind: 'jsonPath', expr: '$.a == 1' }
    ])
  })

  it('appends the new list after the old fields and drops blank conditions', () => {
    const mixed: ContentFilters = {
      payloadContains: 'a',
      conditions: [
        { kind: 'jsonPath', expr: '  ' },
        { kind: 'header', key: '', value: 'x' },
        { kind: 'contains', expr: 'b', exclude: true },
        { kind: 'header', key: 'K', value: '' }
      ]
    }
    expect(normalizeFilters(mixed)).toEqual([
      { kind: 'contains', expr: 'a' },
      { kind: 'contains', expr: 'b', exclude: true },
      { kind: 'header', key: 'K' }
    ])
  })

  it('writes the current shape: conditions only, or nothing', () => {
    expect(canonicalFilters({ jsonPath: '$.a', headers: [] })).toEqual({
      conditions: [{ kind: 'jsonPath', expr: '$.a' }]
    })
    expect(canonicalFilters({ headers: [{ key: ' ' }] })).toEqual({})
    expect(canonicalFilters(undefined)).toEqual({})
    // Normalising twice changes nothing.
    const once = canonicalFilters({ payloadRegex: 'a', conditions: [{ kind: 'regex', expr: 'b' }] })
    expect(canonicalFilters(once)).toEqual(once)
  })

  it('old and new shapes of the same filter scan alike', () => {
    const old: ContentFilters = { payloadContains: 'urgent', jsonPath: '$.n > 1' }
    const current = canonicalFilters(old)
    for (const doc of [{ n: 2, t: 'Urgent' }, { n: 0, t: 'urgent' }, { n: 5 }]) {
      expect(test(current, doc)).toBe(test(old, doc))
    }
  })

  it('counts conditions for hasContentFilters', () => {
    expect(hasContentFilters({ conditions: [] })).toBe(false)
    expect(hasContentFilters({ conditions: [{ kind: 'contains', expr: '' }] })).toBe(false)
    expect(hasContentFilters({ conditions: [{ kind: 'contains', expr: 'x' }] })).toBe(true)
    expect(hasContentFilters({ jsonPath: '$.a' })).toBe(true)
  })
})

describe('PBI-126 compiling conditions', () => {
  const doc = { type: 'order', status: 'ok', n: 5, tags: ['a', 'b'] }

  it('ANDs includes and excludes', () => {
    const f = (conditions: FilterCondition[]): boolean => test({ conditions }, doc)
    expect(f([{ kind: 'jsonPath', expr: '$.type == "order"' }])).toBe(true)
    expect(f([{ kind: 'jsonPath', expr: '$.type == "order"', exclude: true }])).toBe(false)
    expect(f([{ kind: 'jsonPath', expr: '$.type == "nope"', exclude: true }])).toBe(true)
    expect(
      f([
        { kind: 'jsonPath', expr: '$.type == "order"' },
        { kind: 'jsonPath', expr: '$.status == "bad"', exclude: true }
      ])
    ).toBe(true)
    expect(
      f([
        { kind: 'jsonPath', expr: '$.type == "order"' },
        { kind: 'jsonPath', expr: '$.status == "ok"', exclude: true }
      ])
    ).toBe(false)
    expect(
      f([
        { kind: 'jsonPath', expr: '$.type == "order"' },
        { kind: 'contains', expr: 'NOPE' }
      ])
    ).toBe(false)
    expect(f([{ kind: 'regex', expr: '"n":\\d', exclude: true }])).toBe(false)
    expect(f([{ kind: 'contains', expr: 'ORDER', exclude: true }])).toBe(false)
  })

  it('excludes by header, with or without a value', () => {
    const headers: [string, string][] = [['Region', 'eu']]
    const f = (c: FilterCondition): boolean => test({ conditions: [c] }, doc, headers)
    expect(f({ kind: 'header', key: 'region', value: 'eu' })).toBe(true)
    expect(f({ kind: 'header', key: 'region', value: 'eu', exclude: true })).toBe(false)
    expect(f({ kind: 'header', key: 'region', value: 'us', exclude: true })).toBe(true)
    expect(f({ kind: 'header', key: 'Region', exclude: true })).toBe(false)
    expect(f({ kind: 'header', key: 'Other', exclude: true })).toBe(true)
  })

  it('an exclude JSONPath does not reject a payload that is not JSON; an include does', () => {
    const exclude = compileFilters({
      conditions: [{ kind: 'jsonPath', expr: '$.a == 1', exclude: true }]
    })
    expect(exclude([], utf8Encode('plain text'))).toEqual({ match: true, nonJson: false })
    const include = compileFilters({ conditions: [{ kind: 'jsonPath', expr: '$.a == 1' }] })
    expect(include([], utf8Encode('plain text'))).toEqual({ match: false, nonJson: true })
  })

  it('still rejects a non-JSON payload that an exclude on text matches', () => {
    const f = compileFilters({
      conditions: [
        { kind: 'jsonPath', expr: '$.a == 1', exclude: true },
        { kind: 'contains', expr: 'secret', exclude: true }
      ]
    })
    expect(f([], utf8Encode('a secret')).match).toBe(false)
    expect(f([], utf8Encode('hello')).match).toBe(true)
  })

  it('validates each condition and says which one is wrong', () => {
    const errors = validateFilters({
      conditions: [
        { kind: 'jsonPath', expr: '$.a' },
        { kind: 'regex', expr: '(' },
        { kind: 'contains', expr: 'x' },
        { kind: 'jsonPath', expr: 'nope', exclude: true }
      ]
    })
    expect(errors.map((e) => e.index)).toEqual([1, 3])
    expect(() => compileFilters({ conditions: [{ kind: 'regex', expr: '(' }] })).toThrow()
  })
})

describe('PBI-126 adding conditions', () => {
  const inc: FilterCondition = { kind: 'jsonPath', expr: '$.a == 1' }
  it('does not add the same condition twice', () => {
    const once = addCondition({}, inc)
    expect(addCondition(once, inc)).toEqual(once)
    expect(addCondition(once, { ...inc, expr: ' $.a == 1 ' })).toEqual(once)
  })
  it('flips an existing condition instead of adding its opposite', () => {
    const once = addCondition({}, inc)
    const flipped = addCondition(once, { ...inc, exclude: true })
    expect(flipped).toEqual({ conditions: [{ ...inc, exclude: true }] })
    expect(addCondition(flipped, inc)).toEqual({ conditions: [inc] })
  })
  it('adds to the old single fields, which become conditions', () => {
    expect(addCondition({ payloadContains: 'x' }, inc)).toEqual({
      conditions: [{ kind: 'contains', expr: 'x' }, inc]
    })
  })
  it('toggles and removes by position', () => {
    const f = canonicalFilters({ conditions: [inc, { kind: 'contains', expr: 'b' }] })
    expect(toggleCondition(f, 1).conditions?.[1]).toEqual({
      kind: 'contains',
      expr: 'b',
      exclude: true
    })
    expect(toggleCondition(toggleCondition(f, 1), 1)).toEqual(f)
    expect(removeCondition(f, 0)).toEqual({ conditions: [{ kind: 'contains', expr: 'b' }] })
    expect(removeCondition(removeCondition(f, 0), 0)).toEqual({})
  })
})

describe('PBI-126 JSONPath literals round-trip', () => {
  const awkward = [
    'plain',
    'with space',
    'say "hi"',
    "it's",
    'back\\slash',
    'trailing\\',
    'new\nline\ttab',
    '=~ contains == $.x',
    '  padded  ',
    'ünïcödé 日本語 😀',
    '',
    '0',
    'true',
    'null',
    '/slash/'
  ]

  type Primitive = string | number | boolean | null

  /** Every primitive in the doc, with the target the tree would hand to the filter buttons. */
  function* primitives(
    value: unknown,
    segments: (string | number)[] = [],
    inArray?: (string | number)[]
  ): Generator<{ path: string; value: Primitive; arrayPath?: string }> {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) yield* primitives(value[i], [...segments, i], segments)
    } else if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) yield* primitives(v, [...segments, k])
    } else {
      yield {
        path: formatPath(segments),
        value: value as Primitive,
        arrayPath: inArray ? formatPath(inArray) : undefined
      }
    }
  }

  it('every generated expression parses and matches its source message', () => {
    const doc = {
      s: awkward,
      'key with "quotes" and \\ and\nnewline': 'v',
      'a.b': { 'c d': 1.5, e: -2, big: 1e21, small: 1e-7, zero: 0, f: false, n: null, t: true },
      list: [[1, 2], ['x', null, true], [{ k: 'in-object' }]],
      ...Object.fromEntries(awkward.map((a, i) => [`k${i}`, a]))
    }
    let seen = 0
    for (const target of primitives(doc)) {
      for (const exclude of [false, true]) {
        const c = valueCondition(target, exclude)
        expect(c.kind).toBe('jsonPath')
        const expr = (c as { expr: string }).expr
        const parsed = parseJsonPathFilter(expr)
        expect(matchesJsonPath(parsed, doc), expr).toBe(true)
        expect(c.exclude === true).toBe(exclude)
        // The compiled filter agrees: an include keeps the message, an exclude drops it.
        expect(test({ conditions: [c] }, doc), expr).toBe(!exclude)
      }
      seen++
    }
    expect(seen).toBeGreaterThan(40)
  })

  it('uses contains for an item of an array and == for a field', () => {
    const inArray = valueCondition({ path: '$.tags[1]', value: 'b', arrayPath: '$.tags' }, false)
    const field = valueCondition({ path: '$.type', value: 'x' }, true)
    expect(inArray).toEqual({ kind: 'jsonPath', expr: '$.tags contains "b"' })
    expect(field).toEqual({ kind: 'jsonPath', expr: '$.type == "x"', exclude: true })
  })

  it('does not match a different value', () => {
    for (const s of awkward) {
      const c = valueCondition({ path: '$.v', value: s }, false) as { expr: string }
      expect(matchesJsonPath(parseJsonPathFilter(c.expr), { v: s + 'x' })).toBe(false)
    }
  })

  it('writes primitives as JSON would', () => {
    expect(jsonPathLiteral(12.5)).toBe('12.5')
    expect(jsonPathLiteral(true)).toBe('true')
    expect(jsonPathLiteral(null)).toBe('null')
    expect(jsonPathLiteral('a"b')).toBe('"a\\"b"')
  })
})
