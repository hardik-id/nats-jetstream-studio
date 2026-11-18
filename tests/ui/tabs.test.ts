import { beforeEach, describe, expect, it } from 'vitest'
import { openMessages, openNav } from '@renderer/features/shell/nav'
import { messagesSpec, migrateTabs, tabId, tabTitle, useTabs } from '@renderer/state/tabs'

beforeEach(() => {
  localStorage.clear()
  useTabs.setState({ tabs: [], activeId: null, counter: 1 })
})

describe('PBI-128 Messages tab model', () => {
  it('has one id per connection and names the chosen stream', () => {
    expect(tabId({ kind: 'messages', connId: 'dev' })).toBe('messages:dev')
    expect(tabId({ kind: 'messages', connId: 'dev', stream: 'ORDERS' })).toBe('messages:dev')
    expect(tabTitle({ kind: 'messages', connId: 'dev' })).toBe('Messages')
    expect(tabTitle({ kind: 'messages', connId: 'dev', stream: 'ORDERS' })).toBe('ORDERS messages')
  })

  it('reuses the tab and clears a stale subject or sequence when opened for a stream', () => {
    openMessages('dev', { stream: 'ORDERS', subject: 'orders.eu' })
    openMessages('dev', { stream: 'AUDIT', seq: 7 })
    let { tabs } = useTabs.getState()
    expect(tabs).toHaveLength(1)
    expect(tabs[0].spec).toEqual({
      kind: 'messages',
      connId: 'dev',
      stream: 'AUDIT',
      subject: undefined,
      seq: 7
    })
    openMessages('dev', { stream: 'AUDIT', subject: 'audit.>' })
    expect(useTabs.getState().tabs[0].spec).toMatchObject({ subject: 'audit.>', seq: undefined })

    // From the left panel (no stream), the tab keeps what it shows.
    openMessages('dev')
    ;({ tabs } = useTabs.getState())
    expect(tabs).toHaveLength(1)
    expect(tabs[0].spec).toMatchObject({ stream: 'AUDIT', subject: 'audit.>' })
    expect(useTabs.getState().activeId).toBe('messages:dev')

    // Another connection has its own tab.
    openMessages('prod', { stream: 'ORDERS' })
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['messages:dev', 'messages:prod'])
  })

  it('builds a spec without stream keys when no stream is given', () => {
    expect(messagesSpec('dev')).toEqual({ kind: 'messages', connId: 'dev' })
    expect(Object.keys(messagesSpec('dev', { stream: 'S' })).sort()).toEqual(
      ['connId', 'kind', 'seq', 'stream', 'subject'].sort()
    )
  })
})

describe('PBI-128 stored tabs of an older version', () => {
  const old = {
    tabs: [
      {
        id: 'stream:dev:ORDERS',
        spec: {
          kind: 'stream',
          connId: 'dev',
          stream: 'ORDERS',
          section: 'messages',
          subject: 'orders.>',
          seq: 4
        }
      },
      {
        id: 'stream:dev:AUDIT',
        spec: { kind: 'stream', connId: 'dev', stream: 'AUDIT', section: 'config' }
      },
      { id: 'tail:dev:1', spec: { kind: 'tail', connId: 'dev', subject: 'a.>', n: 1 } }
    ],
    activeId: 'stream:dev:ORDERS',
    counter: 2
  }

  it('turns a stream tab on its Messages section into one on Overview', () => {
    const migrated = migrateTabs(old, 0) as typeof old
    expect(migrated.tabs[0].spec).toEqual({
      kind: 'stream',
      connId: 'dev',
      stream: 'ORDERS',
      section: 'overview'
    })
    expect(migrated.tabs[1].spec).toEqual(old.tabs[1].spec)
    expect(migrated.tabs[2]).toEqual(old.tabs[2])
    expect(migrated.activeId).toBe('stream:dev:ORDERS')
    // Current state and odd input are left alone.
    expect(migrateTabs(old, 1)).toBe(old)
    expect(migrateTabs(null, 0)).toBeNull()
    expect(migrateTabs({ tabs: 'x' }, 0)).toEqual({ tabs: 'x' })
  })

  it('migrates what is in storage when the store loads', async () => {
    localStorage.setItem('studio.tabs.v1', JSON.stringify({ state: old, version: 0 }))
    await useTabs.persist.rehydrate()
    const { tabs, activeId } = useTabs.getState()
    expect(tabs[0].spec).toEqual({
      kind: 'stream',
      connId: 'dev',
      stream: 'ORDERS',
      section: 'overview'
    })
    expect(activeId).toBe('stream:dev:ORDERS')
    expect(JSON.parse(localStorage.getItem('studio.tabs.v1')!).version).toBe(1)
  })
})

describe('PBI-138 Trace tab model', () => {
  it('is numbered like Live tail, titled by its value, and reused by the left panel', () => {
    openNav('dev', 'trace')
    openNav('dev', 'trace')
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['trace:dev:1'])
    expect(tabTitle({ kind: 'trace', connId: 'dev', n: 1 })).toBe('Trace')
    const query = {
      rules: [{ kind: 'header' as const, key: 'trace-id', value: 'abc' }],
      window: { kind: 'last' as const, ms: 3_600_000 }
    }
    expect(tabTitle({ kind: 'trace', connId: 'dev', n: 2, query })).toBe('Trace abc')
    useTabs.getState().openNew({ kind: 'trace', connId: 'dev', query })
    useTabs.getState().openNew({ kind: 'tail', connId: 'dev', subject: 'a.>' })
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual([
      'trace:dev:1',
      'trace:dev:2',
      'tail:dev:3'
    ])
    expect(useTabs.getState().tabs[2].spec).toEqual({
      kind: 'tail',
      connId: 'dev',
      subject: 'a.>',
      n: 3
    })
  })

  it('keeps tabs stored before Trace existed (version 1) as they are', () => {
    const stored = {
      tabs: [
        { id: 'tail:dev:1', spec: { kind: 'tail', connId: 'dev', n: 1 } },
        { id: 'stream:dev:S', spec: { kind: 'stream', connId: 'dev', stream: 'S' } }
      ]
    }
    expect(migrateTabs(stored, 1)).toBe(stored)
  })
})
