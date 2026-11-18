import { describe, expect, it } from 'vitest'
import { compileFilters } from '@shared/filters'
import { utf8Encode } from '@shared/encoding'
import {
  DAY,
  headerRule,
  HOUR,
  jsonRule,
  MINUTE,
  ruleToCondition,
  scanLimitOf,
  traceTitle,
  validateTraceQuery,
  windowFor,
  type TraceQuery
} from '@shared/trace'

const T0 = Date.parse('2026-03-01T10:00:00.000Z')
const at = (ms: number): string => new Date(T0 + ms).toISOString()

describe('PBI-138 trace rules and windows', () => {
  it('maps each rule to an existing scan condition', () => {
    expect(ruleToCondition(headerRule('trace-id', 'abc'))).toEqual({
      kind: 'header',
      key: 'trace-id',
      value: 'abc'
    })
    expect(ruleToCondition({ kind: 'header', key: 'trace-id', value: '' })).toEqual({
      kind: 'header',
      key: 'trace-id'
    })
    expect(ruleToCondition({ kind: 'text', value: 'ABC' })).toEqual({
      kind: 'contains',
      expr: 'ABC'
    })
    expect(ruleToCondition({ kind: 'json', path: '$.id', value: 'A-1' })).toEqual({
      kind: 'jsonPath',
      expr: '$.id == "A-1"'
    })
    expect(ruleToCondition({ kind: 'json', path: '$.n', value: '42', literal: true })).toEqual({
      kind: 'jsonPath',
      expr: '$.n == 42'
    })
    expect(
      ruleToCondition({ kind: 'json', path: '$.items[*]', value: 'x', inArray: true })
    ).toEqual({ kind: 'jsonPath', expr: '$.items[*] contains "x"' })
  })

  it('builds the rule for a followed JSON value', () => {
    expect(jsonRule({ path: '$.order.id', value: 'A-1' })).toEqual({
      kind: 'json',
      path: '$.order.id',
      value: 'A-1'
    })
    expect(jsonRule({ path: '$.items[0].sku', value: 7 })).toEqual({
      kind: 'json',
      path: '$.items[*].sku',
      value: '7',
      literal: true
    })
    expect(jsonRule({ path: '$.tags[1]', arrayPath: '$.tags', value: 'urgent' })).toMatchObject({
      path: '$.tags',
      inArray: true
    })
    // The condition finds the value, a string that looks like a number stays a string.
    const test = compileFilters({
      conditions: [ruleToCondition(jsonRule({ path: '$.id', value: '42' }))]
    })
    expect(test([], utf8Encode('{"id":"42"}')).match).toBe(true)
    expect(test([], utf8Encode('{"id":42}')).match).toBe(false)
  })

  it('computes the window of each kind', () => {
    const now = T0
    expect(windowFor({ kind: 'last', ms: HOUR }, now)).toEqual({ from: at(-HOUR) })
    expect(windowFor({ kind: 'around', anchor: at(0), ms: 15 * MINUTE }, now)).toEqual({
      from: at(-15 * MINUTE),
      to: at(15 * MINUTE)
    })
    expect(windowFor({ kind: 'range', from: at(-DAY), to: at(0) }, now)).toEqual({
      from: at(-DAY),
      to: at(0)
    })
  })

  it('says why a query cannot run', () => {
    const ok: TraceQuery = {
      rules: [headerRule('trace-id', 'a')],
      window: { kind: 'last', ms: HOUR }
    }
    expect(validateTraceQuery(ok)).toBeUndefined()
    expect(validateTraceQuery({ ...ok, rules: [] })).toMatch(/match/i)
    expect(validateTraceQuery({ ...ok, rules: [headerRule(' ', 'a')] })).toMatch(/header/i)
    expect(
      validateTraceQuery({ ...ok, rules: [{ kind: 'json', path: '$.a', value: '' }] })
    ).toMatch(/value/i)
    expect(validateTraceQuery({ ...ok, rules: [{ kind: 'json', path: 'a', value: '1' }] })).toMatch(
      /\$/
    )
    expect(
      validateTraceQuery({
        ...ok,
        rules: [{ kind: 'json', path: '$.a', value: 'x1', literal: true }]
      })
    ).toMatch(/number/)
    expect(validateTraceQuery({ ...ok, streams: [] })).toMatch(/stream/i)
    expect(
      validateTraceQuery({ ...ok, window: { kind: 'range', from: at(0), to: at(-1) } })
    ).toMatch(/after/)
    expect(validateTraceQuery({ ...ok, window: { kind: 'range', from: '', to: at(0) } })).toMatch(
      /start/
    )
    expect(validateTraceQuery({ ...ok, window: { kind: 'around', anchor: 'x', ms: 1 } })).toMatch(
      /time/
    )
  })

  it('names the tab and keeps the scan limit in bounds', () => {
    const w = { kind: 'last', ms: HOUR } as const
    expect(traceTitle()).toBe('Trace')
    expect(traceTitle({ rules: [headerRule('trace-id', '')], window: w })).toBe('Trace trace-id')
    expect(traceTitle({ rules: [headerRule('trace-id', 'abc')], window: w })).toBe('Trace abc')
    expect(traceTitle({ rules: [{ kind: 'text', value: 'x'.repeat(40) }], window: w })).toBe(
      `Trace ${'x'.repeat(24)}...`
    )
    expect(scanLimitOf({ rules: [], window: w })).toBe(10_000)
    expect(scanLimitOf({ rules: [], window: w, scanLimit: 5 })).toBe(100)
    expect(scanLimitOf({ rules: [], window: w, scanLimit: 1e12 })).toBe(1_000_000)
  })
})
