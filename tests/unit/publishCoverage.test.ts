import { describe, expect, it } from 'vitest'
import { capturedBy, coverageHint, coverageSentence } from '@renderer/features/publish/coverage'

const STREAMS = [
  { name: 'ORDERS', subjects: ['orders.>'] },
  { name: 'AUDIT', subjects: ['audit.*.login', 'security.>'] },
  { name: 'MIRROR', subjects: [] }
]

describe('which stream stores a subject (PBI-062 publish hints)', () => {
  it('names the stream whose pattern matches, and that pattern', () => {
    expect(capturedBy('orders.eu.new', STREAMS)).toEqual({ stream: 'ORDERS', pattern: 'orders.>' })
    expect(capturedBy('audit.eu.login', STREAMS)).toEqual({
      stream: 'AUDIT',
      pattern: 'audit.*.login'
    })
    expect(capturedBy('security.alerts.high', STREAMS)).toEqual({
      stream: 'AUDIT',
      pattern: 'security.>'
    })
  })

  it('matches a subject exactly, and a full wildcard matches everything', () => {
    expect(capturedBy('orders', [{ name: 'ORDERS', subjects: ['orders'] }])).toEqual({
      stream: 'ORDERS',
      pattern: 'orders'
    })
    expect(capturedBy('any.thing.at.all', [{ name: 'ALL', subjects: ['>'] }])).toEqual({
      stream: 'ALL',
      pattern: '>'
    })
  })

  it('is null when no stream captures the subject', () => {
    expect(capturedBy('publish.eu.new', STREAMS)).toBeNull()
    // `>` needs at least one token below `orders`, and `*` exactly one token.
    expect(capturedBy('orders', STREAMS)).toBeNull()
    expect(capturedBy('audit.login', STREAMS)).toBeNull()
    expect(capturedBy('orders.eu.new', [])).toBeNull()
  })

  it('never matches a stream without patterns, such as a mirror', () => {
    expect(capturedBy('mirror.x', [{ name: 'MIRROR', subjects: [] }])).toBeNull()
  })
})

describe('wording of the publish hints', () => {
  const orders = { stream: 'ORDERS', pattern: 'orders.>' }

  it('names the stream under the Subject field', () => {
    expect(coverageHint(orders, false)).toBe('Stored by ORDERS (orders.>).')
    expect(coverageHint(orders, true)).toBe('Stored by ORDERS (orders.>).')
  })

  it('says when no stream stores the subject, and what that means in JetStream mode', () => {
    expect(coverageHint(null, false)).toBe(
      'No stream stores this subject. Only live subscribers see it.'
    )
    expect(coverageHint(null, true)).toBe(
      'No stream stores this subject, so a JetStream publish will fail.'
    )
  })

  it('tells a core publish whether a stream should keep the message', () => {
    expect(coverageSentence(orders)).toBe(
      'ORDERS captures this subject (orders.>), so it should be stored.'
    )
    expect(coverageSentence(null)).toBe(
      'No stream captures this subject, so only live subscribers can receive it.'
    )
  })
})
