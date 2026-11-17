import { describe, expect, it } from 'vitest'
import { subjectMatches, subjectsOverlap, validateSubject, buildSubjectTree } from '@shared/subject'
import {
  clampTestTimeoutMs,
  parseTestTimeoutSeconds,
  TEST_TIMEOUT_DEFAULT_MS,
  TEST_TIMEOUT_MAX_MS,
  TEST_TIMEOUT_MIN_MS
} from '@shared/connection'
import { formatDuration, parseDuration } from '@shared/duration'
import { compareVersions, versionAtLeast } from '@shared/semver'
import { matchesJsonPath, parseJsonPathFilter } from '@shared/jsonpath'
import { compileFilters, hasContentFilters, validateFilters } from '@shared/filters'
import { evaluateConsumerHealth } from '@shared/health'
import {
  fromBase64,
  textToBase64,
  toBase64,
  toHexDump,
  tryDecodeText,
  utf8Encode
} from '@shared/encoding'
import { formatBytes, formatLimit } from '@shared/format'
import { DEFAULT_HEALTH_THRESHOLDS, type ConsumerInfoDto } from '@shared/api'

describe('subject helpers', () => {
  it('matches wildcards the way NATS does', () => {
    expect(subjectMatches('orders.*.created', 'orders.eu.created')).toBe(true)
    expect(subjectMatches('orders.*.created', 'orders.eu.west.created')).toBe(false)
    expect(subjectMatches('orders.>', 'orders.eu.west.created')).toBe(true)
    expect(subjectMatches('orders.>', 'orders')).toBe(false)
    expect(subjectMatches('>', 'anything.at.all')).toBe(true)
    expect(subjectMatches('orders.eu', 'orders.eu')).toBe(true)
    expect(subjectMatches('orders.eu', 'orders.eu.x')).toBe(false)
  })

  it('validates subjects', () => {
    expect(validateSubject('orders.*.created')).toBeNull()
    expect(validateSubject('orders.>')).toBeNull()
    expect(validateSubject('orders..created')).toMatch(/empty/)
    expect(validateSubject('orders.>.x')).toMatch(/last token/)
    expect(validateSubject('orders.*', false)).toMatch(/not allowed/)
    expect(validateSubject('orders.>', false)).toMatch(/not allowed/)
    expect(validateSubject('has space')).toMatch(/whitespace/)
    expect(validateSubject('')).toMatch(/required/)
  })

  it('treats "*" and ">" inside a longer token as ordinary text, as NATS does', () => {
    for (const subject of ['orders.a*', 'a*b', '*a.b', 'cpu>90', 'metrics.cpu>90.eu', '>x', '**'])
      for (const allowWildcards of [true, false])
        expect(validateSubject(subject, allowWildcards), subject).toBeNull()
    // Such a token is a literal next to real wildcards too.
    expect(validateSubject('metrics.cpu>90.*.>')).toBeNull()
    expect(validateSubject('metrics.cpu>90.*', false)).toMatch(/not allowed/)
    // Only a whole-token ">" has to come last.
    expect(validateSubject('a.>b.c')).toBeNull()
    expect(validateSubject('a.>.c')).toMatch(/last token/)

    // The matching helpers agree: the token is compared as text, not expanded.
    expect(subjectMatches('orders.a*', 'orders.a*')).toBe(true)
    expect(subjectMatches('orders.a*', 'orders.abc')).toBe(false)
    expect(subjectMatches('cpu>90', 'cpu>90')).toBe(true)
    expect(subjectMatches('cpu>90', 'cpu.90')).toBe(false)
    expect(subjectMatches('alerts.*', 'alerts.cpu>90')).toBe(true)
  })

  it('detects overlapping patterns', () => {
    expect(subjectsOverlap('orders.>', 'orders.eu.created')).toBe(true)
    expect(subjectsOverlap('orders.*', 'orders.eu')).toBe(true)
    expect(subjectsOverlap('orders.eu', 'orders.us')).toBe(false)
    expect(subjectsOverlap('orders.*', 'orders.eu.created')).toBe(false)
  })

  it('builds a subject tree with rolled-up totals', () => {
    const tree = buildSubjectTree([
      { subject: 'orders.eu.created', count: 5 },
      { subject: 'orders.eu.shipped', count: 2 },
      { subject: 'orders.us.created', count: 1 },
      { subject: 'orders', count: 3 }
    ])
    const orders = tree.children.get('orders')!
    expect(orders.total).toBe(11)
    expect(orders.count).toBe(3)
    expect(orders.children.get('eu')!.total).toBe(7)
    expect(orders.children.get('eu')!.children.get('created')!.path).toBe('orders.eu.created')
  })
})

describe('connection test timeout', () => {
  it('has one default and one range, shared by the form and the service', () => {
    expect(TEST_TIMEOUT_DEFAULT_MS).toBe(5000)
    expect(TEST_TIMEOUT_MIN_MS).toBe(1000)
    expect(TEST_TIMEOUT_MAX_MS).toBe(60_000)
  })

  it('clamps a stored value into the range and falls back to the default', () => {
    expect(clampTestTimeoutMs(8000)).toBe(8000)
    expect(clampTestTimeoutMs(1000)).toBe(1000)
    expect(clampTestTimeoutMs(60_000)).toBe(60_000)
    expect(clampTestTimeoutMs(2500.4)).toBe(2500)
    // Out of range: the nearest end, so a test neither fails at once nor hangs.
    expect(clampTestTimeoutMs(400)).toBe(1000)
    expect(clampTestTimeoutMs(0)).toBe(1000)
    expect(clampTestTimeoutMs(-5)).toBe(1000)
    expect(clampTestTimeoutMs(600_000)).toBe(60_000)
    expect(clampTestTimeoutMs(Infinity)).toBe(5000)
    // Not a number at all: the default.
    for (const value of [undefined, null, NaN, '8000', '', 'soon', {}, [], true])
      expect(clampTestTimeoutMs(value), String(value)).toBe(5000)
  })

  it('reads typed seconds and accepts exactly what the clamp leaves unchanged', () => {
    expect(parseTestTimeoutSeconds('5')).toBe(5000)
    expect(parseTestTimeoutSeconds(' 2.5 ')).toBe(2500)
    expect(parseTestTimeoutSeconds('1')).toBe(1000)
    expect(parseTestTimeoutSeconds('60')).toBe(60_000)
    expect(parseTestTimeoutSeconds('60.0')).toBe(60_000)
    for (const text of [
      '',
      ' ',
      '0',
      '0.9',
      '0.999',
      '60.001',
      '61',
      '600',
      '-5',
      'abc',
      '1e1',
      '5s',
      '.5',
      '5.'
    ])
      expect(parseTestTimeoutSeconds(text), text).toBeNull()
    // Whatever the form accepts, the service uses as it is.
    for (const text of ['1', '1.5', '7', '59.999', '60']) {
      const ms = parseTestTimeoutSeconds(text)!
      expect(clampTestTimeoutMs(ms), text).toBe(ms)
    }
  })
})

describe('durations', () => {
  it('parses and formats', () => {
    expect(parseDuration('90s')).toBe(90e9)
    expect(parseDuration('1h30m')).toBe(5400e9)
    expect(parseDuration('2d')).toBe(172800e9)
    expect(parseDuration('250ms')).toBe(250e6)
    expect(parseDuration('30')).toBe(30e9)
    expect(parseDuration('')).toBe(0)
    expect(parseDuration('abc')).toBeNull()
    expect(parseDuration('1h x')).toBeNull()
    expect(formatDuration(5400e9)).toBe('1h30m')
    expect(formatDuration(90e9)).toBe('1m30s')
    expect(formatDuration(250e6)).toBe('250ms')
    expect(formatDuration(0)).toBe('0')
    expect(parseDuration(formatDuration(93784e9))).toBe(93784e9)
  })
})

describe('versions', () => {
  it('compares', () => {
    expect(compareVersions('2.10.22', '2.11.0')).toBe(-1)
    expect(compareVersions('v2.11.0-RC.1', '2.11.0')).toBe(0)
    expect(versionAtLeast('2.15.3', '2.11.0')).toBe(true)
    expect(versionAtLeast('2.10.9', '2.11.0')).toBe(false)
    expect(versionAtLeast(undefined, '2.11.0')).toBe(false)
  })
})

describe('jsonpath filter', () => {
  const doc = {
    order: {
      id: 'A-1',
      total: 150,
      items: [
        { sku: 'x', qty: 2 },
        { sku: 'y', qty: 0 }
      ]
    },
    tags: ['urgent', 'eu'],
    customer: { email: 'jo@example.com' },
    ok: false
  }
  const match = (expr: string): boolean => matchesJsonPath(parseJsonPathFilter(expr), doc)

  it('evaluates comparisons', () => {
    expect(match('$.order.total > 100')).toBe(true)
    expect(match('$.order.total > 150')).toBe(false)
    expect(match('$.order.total >= 150')).toBe(true)
    expect(match('$.order.id == "A-1"')).toBe(true)
    expect(match("$.order.id != 'A-1'")).toBe(false)
    expect(match('$.order.items[*].sku == "y"')).toBe(true)
    expect(match('$.order.items[0].qty == 2')).toBe(true)
    expect(match('$.order.items[-1].sku == "y"')).toBe(true)
    expect(match('$..sku == "x"')).toBe(true)
    expect(match('$..qty > 5')).toBe(false)
    expect(match('$.tags contains "urgent"')).toBe(true)
    expect(match('$.customer.email contains "example"')).toBe(true)
    expect(match('$.customer.email =~ /@EXAMPLE\\.com$/i')).toBe(true)
    expect(match('$.customer.email =~ "^nobody"')).toBe(false)
    expect(match("$['order']['total'] < 200")).toBe(true)
  })

  it('treats a bare path as an existence check', () => {
    expect(match('$.order.id')).toBe(true)
    expect(match('$.missing')).toBe(false)
    expect(match('$.ok')).toBe(false)
  })

  it('reports syntax errors with a position', () => {
    expect(() => parseJsonPathFilter('order.total > 1')).toThrow(/start with \$/)
    expect(() => parseJsonPathFilter('$.order.total >')).toThrow(/Expected a value/)
    expect(() => parseJsonPathFilter('$.order.total > abc')).toThrow(/Expected a number/)
    expect(() => parseJsonPathFilter('$.order[')).toThrow(/Expected/)
    expect(() => parseJsonPathFilter('$.a =~ /(/')).toThrow(/Invalid regular expression/)
    expect(() => parseJsonPathFilter('$.a ?? 1')).toThrow(/comparison/)
  })
})

describe('content filters', () => {
  const json = utf8Encode(JSON.stringify({ order: { total: 150 }, note: 'Hello World' }))

  it('combines filters with AND', () => {
    const f = compileFilters({
      headers: [{ key: 'Trace-Id' }, { key: 'region', value: 'eu' }],
      payloadContains: 'hello',
      jsonPath: '$.order.total > 100'
    })
    const headers: [string, string][] = [
      ['trace-id', 'abc'],
      ['Region', 'eu']
    ]
    expect(f(headers, json)).toEqual({ match: true, nonJson: false })
    expect(f([['trace-id', 'abc']], json).match).toBe(false)
    expect(
      f(
        [
          ['trace-id', 'abc'],
          ['region', 'us']
        ],
        json
      ).match
    ).toBe(false)
  })

  it('skips non-JSON payloads for JSONPath filters and says so', () => {
    const f = compileFilters({ jsonPath: '$.a == 1' })
    expect(f([], utf8Encode('not json'))).toEqual({ match: false, nonJson: true })
  })

  it('supports regular expressions', () => {
    const f = compileFilters({ payloadRegex: 'W[a-z]+d' })
    expect(f([], json).match).toBe(true)
    expect(compileFilters({ payloadRegex: '^nope' })([], json).match).toBe(false)
  })

  it('validates before scanning', () => {
    expect(validateFilters({ payloadRegex: '(' })[0].message).toBeTruthy()
    expect(validateFilters({ jsonPath: 'nope' })[0].message).toBeTruthy()
    expect(validateFilters({ payloadRegex: 'a+', jsonPath: '$.a' })).toEqual([])
    expect(hasContentFilters({})).toBe(false)
    expect(hasContentFilters({ headers: [{ key: ' ' }] })).toBe(false)
    expect(hasContentFilters({ payloadContains: 'x' })).toBe(true)
  })
})

describe('consumer health', () => {
  const base: ConsumerInfoDto = {
    stream_name: 'S',
    name: 'c',
    created: '2026-01-01T00:00:00Z',
    config: { max_ack_pending: 100 },
    delivered: { consumer_seq: 10, stream_seq: 10, last_active: '2026-01-01T00:59:50Z' },
    ack_floor: { consumer_seq: 10, stream_seq: 10 },
    num_ack_pending: 0,
    num_redelivered: 0,
    num_waiting: 0,
    num_pending: 0
  }
  const now = Date.parse('2026-01-01T01:00:00Z')
  const t = DEFAULT_HEALTH_THRESHOLDS

  it('is healthy by default', () => {
    expect(evaluateConsumerHealth(base, [], t, now)).toEqual([])
  })

  it('flags growing lag only when every sample grows', () => {
    const grow = Array.from({ length: 7 }, (_, i) => ({
      t: i,
      pending: i * 10,
      ackPending: 0,
      redelivered: 0
    }))
    expect(evaluateConsumerHealth({ ...base, num_pending: 60 }, grow, t, now)).toContain(
      'lag_growing'
    )
    const flat = grow.map((s, i) => (i === 3 ? { ...s, pending: 0 } : s))
    expect(evaluateConsumerHealth({ ...base, num_pending: 60 }, flat, t, now)).not.toContain(
      'lag_growing'
    )
    expect(evaluateConsumerHealth(base, grow.slice(0, 5), t, now)).not.toContain('lag_growing')
  })

  it('flags redeliveries, stalled, ack pending at max and missing leader', () => {
    expect(evaluateConsumerHealth({ ...base, num_redelivered: 101 }, [], t, now)).toEqual([
      'redeliveries'
    ])
    const stalled = {
      ...base,
      num_pending: 5,
      delivered: { consumer_seq: 1, stream_seq: 1, last_active: '2026-01-01T00:50:00Z' }
    }
    expect(evaluateConsumerHealth(stalled, [], t, now)).toEqual(['stalled'])
    expect(evaluateConsumerHealth({ ...stalled, paused: true }, [], t, now)).toEqual([])
    expect(evaluateConsumerHealth({ ...base, num_ack_pending: 100 }, [], t, now)).toContain(
      'ack_pending_max'
    )
    const noLeader = {
      ...base,
      cluster: { name: 'c1', replicas: [{ name: 'n2', current: false, active: 0 }] }
    }
    expect(evaluateConsumerHealth(noLeader, [], t, now)).toEqual(['no_leader'])
  })
})

describe('encoding and formatting', () => {
  it('round-trips base64', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255])
    expect(Array.from(fromBase64(toBase64(bytes)))).toEqual([0, 1, 2, 250, 255])
    expect(textToBase64('héllo')).toBe('aMOpbGxv')
  })

  it('detects text and renders hex', () => {
    expect(tryDecodeText(utf8Encode('plain text\n'))).toBe('plain text\n')
    expect(tryDecodeText(new Uint8Array([0xff, 0xfe, 0x00]))).toBeNull()
    expect(tryDecodeText(new Uint8Array([0x08, 0x01, 0x12]))).toBeNull()
    expect(toHexDump(utf8Encode('AB'))).toContain('41 42')
    expect(toHexDump(utf8Encode('AB'))).toContain('|AB|')
  })

  it('formats sizes and limits', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.50 KiB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.00 MiB')
    expect(formatLimit(-1)).toBe('unlimited')
    expect(formatLimit(1024, true)).toBe('1.00 KiB')
  })
})

describe('duration round trip', () => {
  it('never changes a value when formatted and parsed back', () => {
    for (const ns of [
      1,
      999,
      1500,
      1_234_567_891,
      90.5e9,
      93784e9,
      2 * 86400e9 + 5e6,
      30e9,
      3600e9
    ]) {
      expect(parseDuration(formatDuration(ns))).toBe(ns)
    }
  })
})

describe('byte sizes', () => {
  it('parses sizes and writes them back without changing the value', async () => {
    const { parseBytes, bytesToInput } = await import('@shared/format')
    expect(parseBytes('512')).toBe(512)
    expect(parseBytes('10MB')).toBe(10 * 1024 * 1024)
    expect(parseBytes('1.5 GiB')).toBe(1.5 * 1024 ** 3)
    expect(parseBytes('64k')).toBe(65536)
    expect(parseBytes('ten')).toBeNull()
    expect(parseBytes('10XB')).toBeNull()
    for (const n of [1, 1000, 1024, 65536, 10 * 1024 * 1024, 1024 ** 3, 1_000_000, 123_456_789]) {
      expect(parseBytes(bytesToInput(n))).toBe(n)
    }
    expect(bytesToInput(10 * 1024 * 1024)).toBe('10MiB')
  })
})
