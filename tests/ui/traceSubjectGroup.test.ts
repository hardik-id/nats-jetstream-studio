import { describe, expect, it } from 'vitest'
import { groupSubject, isIdToken } from '@renderer/features/trace/model/subjectGroup'

describe('PBI-138 subject grouping', () => {
  it('collapses numbers, UUIDs, hex and base62-looking ids, and keeps words', () => {
    expect(isIdToken('123')).toBe(true)
    expect(isIdToken('7')).toBe(true)
    expect(isIdToken('0007')).toBe(true)
    expect(isIdToken('9f1c2e7a-4b3d-4e8a-9c1d-0123456789ab')).toBe(true)
    expect(isIdToken('9F1C2E7A-4B3D-4E8A-9C1D-0123456789AB')).toBe(true)
    expect(isIdToken('3fa85f6457174562b3fc2c963f66afa6')).toBe(true)
    expect(isIdToken('a1b2c3d4')).toBe(true)
    expect(isIdToken('01HZX3J5K7M9N2P4Q6R8S0T1V2')).toBe(true) // ULID
    expect(isIdToken('Xk3j9QzLmP1a')).toBe(true) // base62
    expect(isIdToken('2026-03-01')).toBe(true)
    expect(isIdToken('orders')).toBe(false)
    expect(isIdToken('captured')).toBe(false)
    expect(isIdToken('')).toBe(false)
  })

  it('keeps versions, short names with digits, words that are only hex letters and wildcards', () => {
    for (const word of ['v2', 'v10', 'v1beta1', 's3', 'ipv4', 'oauth2', 'h264', 'base64', 'utf8'])
      expect(isIdToken(word), word).toBe(false)
    // Hex letters only: a word, not an id.
    for (const word of ['deadbeef', 'facade', 'decaffed', 'accede'])
      expect(isIdToken(word)).toBe(false)
    // Long words without digits, and long names with a dash, are words.
    expect(isIdToken('internationalization')).toBe(false)
    expect(isIdToken('payment-processed')).toBe(false)
    expect(isIdToken('kubernetes2')).toBe(false) // long, but one digit and one case
    expect(isIdToken('*')).toBe(false)
    expect(isIdToken('>')).toBe(false)
  })

  it('collapses prefixed ids but not ordinary hyphenated words', () => {
    for (const id of ['order-1234', 'cust_0001', 'usr_8f3a9c21', 'ord_01HZXABCDEF', 'Order-98765'])
      expect(isIdToken(id), id).toBe(true)
    expect(isIdToken('order-9f1c2e7a-4b3d-4e8a-9c1d-0123456789ab')).toBe(true)
    for (const word of [
      'eu-west',
      'order-created',
      'us-east-1', // a judgement call: kept
      'sha-256',
      'utf-8',
      'cust_vip',
      'order-v2',
      'payment-processed'
    ])
      expect(isIdToken(word), word).toBe(false)
    expect(groupSubject('billing.cust_0001.invoice.order-1234')).toBe('billing.*.invoice.*')
    expect(groupSubject('region.us-east-1.up')).toBe('region.us-east-1.up')
  })

  it('groups a subject: id-like tokens become *, the first token stays', () => {
    expect(groupSubject('orders.123.paid')).toBe('orders.*.paid')
    expect(groupSubject('orders.456.paid')).toBe('orders.*.paid')
    expect(groupSubject('orders.9f1c2e7a-4b3d-4e8a-9c1d-0123456789ab.shipped')).toBe(
      'orders.*.shipped'
    )
    expect(groupSubject('api.v2.users.42.get')).toBe('api.v2.users.*.get')
    expect(groupSubject('payments.captured')).toBe('payments.captured')
    // The first token is a namespace, even when it looks like an id.
    expect(groupSubject('2026.events.7')).toBe('2026.events.*')
    expect(groupSubject('orders.*.paid')).toBe('orders.*.paid')
    expect(groupSubject('orders.>')).toBe('orders.>')
    expect(groupSubject('single')).toBe('single')
  })
})
