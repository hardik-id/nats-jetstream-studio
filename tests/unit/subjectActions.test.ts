import { describe, expect, it, vi } from 'vitest'
import {
  describeActions,
  resolveScope,
  rowMenuItems,
  runBrowse,
  runPublish,
  runTail,
  scopeStreams,
  storedInScope,
  type ActionTabs
} from '../../src/renderer/src/features/subjects/subjectActions'
import {
  buildTree,
  type StreamPatterns
} from '../../src/renderer/src/features/subjects/subjectTree'

const PATTERNS: StreamPatterns[] = [
  { name: 'ORDERS', subjects: ['orders.>'] },
  { name: 'AUDIT', subjects: ['orders.*.created'] },
  { name: 'EMPTY', subjects: ['orders.>'] },
  { name: 'OTHER', subjects: ['telemetry.>'] }
]

const tree = buildTree(
  [
    {
      stream: 'ORDERS',
      subjects: [
        { subject: 'orders', count: 5 },
        { subject: 'orders.eu.created', count: 70 }
      ]
    },
    { stream: 'AUDIT', subjects: [{ subject: 'orders.eu.created', count: 10 }] }
  ],
  { 'live.only': 3, 'a..b': 1 },
  PATTERNS
)
const node = (p: string) => tree.byPath.get(p)!

function fakeTabs() {
  return { open: vi.fn(), openNew: vi.fn() } satisfies ActionTabs
}

describe('subjectActions', () => {
  it('resolves the scope: chosen if offered, else the default, none when invalid', () => {
    expect(resolveScope(node('orders'))).toBe('below')
    expect(resolveScope(node('orders'), 'subject')).toBe('subject')
    expect(resolveScope(node('orders.eu.created'), 'below')).toBe('subject')
    expect(resolveScope(node('a..b'))).toBeNull()
  })

  it('describes a branch with its own messages (below scope)', () => {
    const a = describeActions(node('orders'), 'below', PATTERNS, false)
    expect(a.filter).toBe('orders.>')
    expect(a.browse).toMatchObject({ enabled: true, subject: 'orders.>', defaultStream: 'ORDERS' })
    expect(a.tail).toMatchObject({ enabled: true, subject: 'orders.>' })
    expect(a.publish.enabled).toBe(false)
    expect(a.publish.reason).toMatch(/one exact subject/)
    expect(a.copyFilter.subject).toBe('orders.>')
  })

  it('subject scope can publish; read-only disables it with the reason', () => {
    const ok = describeActions(node('orders'), 'subject', PATTERNS, false)
    expect(ok.publish).toMatchObject({ enabled: true, subject: 'orders' })
    const ro = describeActions(node('orders'), 'subject', PATTERNS, true)
    expect(ro.publish.enabled).toBe(false)
    expect(ro.publish.reason).toMatch(/read-only/)
    expect(ro.browse.enabled).toBe(true)
    expect(ro.tail.enabled).toBe(true)
    const both = describeActions(node('orders'), 'below', PATTERNS, true)
    expect(both.publish.reason).toMatch(/exact subject/)
    expect(both.publish.reason).toMatch(/read-only/)
  })

  it('lists several streams, most messages first, and browses the chosen one', () => {
    const a = describeActions(node('orders.eu.created'), 'subject', PATTERNS, false)
    expect(a.browse.streams).toEqual(['ORDERS', 'AUDIT'])
    const tabs = fakeTabs()
    runBrowse(tabs, 'c1', a.browse, 'AUDIT')
    expect(tabs.open).toHaveBeenCalledWith({
      kind: 'stream',
      connId: 'c1',
      stream: 'AUDIT',
      section: 'messages',
      subject: 'orders.eu.created',
      seq: undefined
    })
    runBrowse(tabs, 'c1', a.browse)
    expect(tabs.open).toHaveBeenLastCalledWith(expect.objectContaining({ stream: 'ORDERS' }))
  })

  it('disables Browse with a reason when no stream holds the subject', () => {
    const a = describeActions(node('live.only'), 'subject', PATTERNS, false)
    expect(a.browse.enabled).toBe(false)
    expect(a.browse.reason).toMatch(/No stream/)
    const tabs = fakeTabs()
    runBrowse(tabs, 'c1', a.browse)
    expect(tabs.open).not.toHaveBeenCalled()
    expect(a.tail.enabled).toBe(true)
  })

  it('opens tail and publish tabs only when enabled', () => {
    const tabs = fakeTabs()
    const below = describeActions(node('orders'), 'below', PATTERNS, false)
    runTail(tabs, 'c1', below.tail)
    expect(tabs.openNew).toHaveBeenCalledWith('tail', 'c1', 'orders.>')
    runPublish(tabs, 'c1', below.publish)
    expect(tabs.openNew).toHaveBeenCalledTimes(1)
    const subj = describeActions(node('orders'), 'subject', PATTERNS, false)
    runPublish(tabs, 'c1', subj.publish)
    expect(tabs.openNew).toHaveBeenLastCalledWith('publish', 'c1', 'orders')
  })

  it('an invalid subject offers nothing but Copy subject', () => {
    const a = describeActions(node('a..b'), null, PATTERNS, false)
    expect(a.filter).toBeNull()
    for (const x of [a.browse, a.tail, a.publish, a.copyFilter]) {
      expect(x.enabled).toBe(false)
      expect(x.reason).toMatch(/not a valid subject/)
    }
    expect(a.copySubject.enabled).toBe(true)
    const tabs = fakeTabs()
    runTail(tabs, 'c1', a.tail)
    expect(tabs.openNew).not.toHaveBeenCalled()
  })

  it('counts stored messages per scope and lists capturing streams without data', () => {
    const n = node('orders')
    expect(storedInScope(n, 'subject', 'ORDERS')).toBe(5)
    expect(storedInScope(n, 'below', 'ORDERS')).toBe(70)
    expect(storedInScope(n, 'children', 'ORDERS')).toBe(0)
    const names = scopeStreams(n, 'below', PATTERNS)
    expect(names.map((s) => s.name)).toEqual(['ORDERS', 'AUDIT', 'EMPTY'])
    expect(names.find((s) => s.name === 'EMPTY')?.stored).toBe(0)
    expect(names.find((s) => s.name === 'OTHER')).toBeUndefined()
    expect(names.find((s) => s.name === 'AUDIT')?.stored).toBe(10)
  })

  it('row menu items carry the filter and run the same actions', () => {
    const tabs = fakeTabs()
    const items = rowMenuItems(node('orders'), {
      connId: 'c1',
      tabs,
      streams: PATTERNS,
      readOnly: true
    })
    const labels = items.map((i) => i.label)
    expect(labels).toContain('Start live tail on orders.>')
    expect(labels).toContain('Copy filter (orders.>)')
    const publish = items.find((i) => i.label.startsWith('Publish message'))!
    expect(publish.disabled).toBe(true)
    items.find((i) => i.label === 'Start live tail on orders.>')!.onSelect()
    expect(tabs.openNew).toHaveBeenCalledWith('tail', 'c1', 'orders.>')
    const multi = rowMenuItems(node('orders.eu.created'), {
      connId: 'c1',
      tabs,
      streams: PATTERNS,
      readOnly: false
    })
    expect(multi.filter((i) => i.label.startsWith('Browse stored messages'))).toHaveLength(2)
  })
})
