import { describe, expect, it } from 'vitest'
import {
  fitDepth,
  formatPath,
  maxDepth,
  searchJson,
  valueText,
  SEARCH_MAX_MATCHES
} from '@shared/jsonTree'

describe('formatPath', () => {
  it('uses dots for identifiers and brackets for indexes and other keys', () => {
    expect(formatPath([])).toBe('$')
    expect(formatPath(['order', 'items', 0, 'sku'])).toBe('$.order.items[0].sku')
    expect(formatPath(['a b', 'x.y', 'ok_1'])).toBe('$["a b"]["x.y"].ok_1')
    expect(formatPath(['1abc'])).toBe('$["1abc"]')
    expect(formatPath(['quo"te'])).toBe('$["quo\\"te"]')
  })
})

describe('valueText', () => {
  it('copies strings as they are and everything else as JSON', () => {
    expect(valueText('hi')).toBe('hi')
    expect(valueText(12)).toBe('12')
    expect(valueText(null)).toBe('null')
    expect(valueText({ a: [1] })).toBe('{\n  "a": [\n    1\n  ]\n}')
  })
})

describe('searchJson', () => {
  const doc = { order: { id: 'A-1', items: [{ sku: 'x1' }, { sku: 'urgent-2' }], note: 'Urgent' } }

  it('finds keys and values, not case sensitive, and says what to open', () => {
    const r = searchJson(doc, 'URGENT')
    expect(r.matches.map((m) => m.id)).toEqual(['$.order.items[1].sku', '$.order.note'])
    expect(r.matches[0]).toMatchObject({ inKey: false, inValue: true })
    expect([...r.reveal].sort()).toEqual(['$', '$.order', '$.order.items', '$.order.items[1]'])
    expect([...r.need.get('$.order.items')!]).toEqual([1])
    expect(r.truncated).toBe(false)
  })

  it('matches keys too, and the empty query matches nothing', () => {
    expect(searchJson(doc, 'items').matches).toEqual([
      { id: '$.order.items', inKey: true, inValue: false }
    ])
    expect(searchJson(doc, '').matches).toEqual([])
  })

  it('matches numbers, booleans and null by their text', () => {
    expect(searchJson({ a: 10, b: true, c: null }, 'true').matches.map((m) => m.id)).toEqual([
      '$.b'
    ])
    expect(searchJson({ a: 10, b: true, c: null }, 'null').matches.map((m) => m.id)).toEqual([
      '$.c'
    ])
  })

  it('stops at the match limit and at the node limit', () => {
    const many = Array.from({ length: 2000 }, () => 'hit')
    const r = searchJson(many, 'hit')
    expect(r.matches).toHaveLength(SEARCH_MAX_MATCHES)
    expect(r.truncated).toBe(true)
    const visited = searchJson(many, 'zzz', { maxVisits: 100 })
    expect(visited.truncated).toBe(true)
    // A 1 MB-sized document is walked in a blink.
    const big = Array.from({ length: 20_000 }, (_, i) => ({
      id: i,
      name: `customer-${i}`,
      tags: ['a', 'b']
    }))
    const t = performance.now()
    searchJson(big, 'customer-19999')
    expect(performance.now() - t).toBeLessThan(500)
  })
})

describe('depth', () => {
  it('counts levels', () => {
    expect(maxDepth(1)).toBe(0)
    expect(maxDepth({})).toBe(1)
    expect(maxDepth({ a: [{ b: 1 }] })).toBe(3)
  })

  it('keeps the open tree to a budget of rows', () => {
    const small = { a: { b: { c: 1 } } }
    expect(fitDepth(small, 3, 200)).toBe(3)
    const wide = Array.from({ length: 200 }, () => Array.from({ length: 200 }, () => ({ x: 1 })))
    expect(fitDepth(wide, 3, 200, 4000)).toBeLessThan(3)
    expect(fitDepth(wide, 1, 200, 4000)).toBe(1)
  })
})
