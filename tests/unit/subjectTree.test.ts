import { describe, expect, it } from 'vitest'
import { buildSubjectTree, validateSubject, type SubjectNode } from '@shared/subject'
import {
  availableScopes,
  buildTree,
  canPublish,
  defaultExpanded,
  defaultScope,
  expandAllPaths,
  expandToLevel,
  flatten,
  ownersFor,
  scopeFilter,
  searchSubjects,
  sortedChildren,
  type StreamPatterns,
  type StreamSubjects,
  type SubjectTree
} from '../../src/renderer/src/features/subjects/subjectTree'

const ORDERS: StreamSubjects = {
  stream: 'ORDERS',
  subjects: [
    { subject: 'orders.eu.created', count: 70 },
    { subject: 'orders.eu.paid', count: 60 },
    { subject: 'orders.us.created', count: 135 },
    { subject: 'orders', count: 5 }
  ]
}
const TELE: StreamSubjects = {
  stream: 'TELEMETRY',
  subjects: [
    { subject: 'telemetry.device1', count: 10 },
    { subject: 'telemetry.device10', count: 4 },
    { subject: 'telemetry.device2', count: 6 }
  ]
}
const PATTERNS: StreamPatterns[] = [
  { name: 'ORDERS', subjects: ['orders', 'orders.>'] },
  { name: 'TELEMETRY', subjects: ['telemetry.*'] }
]

const paths = (rows: { path: string }[]): string[] => rows.map((r) => r.path)
const ex = (...p: string[]): Set<string> => new Set(p)

describe('buildTree', () => {
  it('has the same counts as the existing shared tree', () => {
    const tree = buildTree([ORDERS, TELE], undefined, PATTERNS)
    const old = buildSubjectTree([...ORDERS.subjects, ...TELE.subjects])
    const walk = (n: SubjectNode): void => {
      for (const c of n.children.values()) {
        const mine = tree.byPath.get(c.path)
        expect(mine?.own, c.path).toBe(c.count)
        expect(mine?.total, c.path).toBe(c.total)
        walk(c)
      }
    }
    walk(old)
    expect(tree.total).toBe(old.total)
    expect(tree.nodeCount).toBe(tree.byPath.size)
  })

  it('handles empty input', () => {
    const tree = buildTree([], undefined)
    expect(tree.roots).toEqual([])
    expect(tree.total).toBe(0)
    expect(tree.maxDepth).toBe(0)
    expect(flatten(tree, { expanded: ex() })).toEqual([])
    expect(buildTree([{ stream: 'S', subjects: [] }], {}).nodeCount).toBe(0)
    expect(expandAllPaths(tree)).toEqual({ expanded: new Set(), level: 0, capped: false })
  })

  it('ignores empty subjects', () => {
    const tree = buildTree([{ stream: 'S', subjects: [{ subject: '', count: 3 }] }], { '': 2 })
    expect(tree.nodeCount).toBe(0)
    expect(tree.total).toBe(0)
  })

  it('keeps a subject that is a prefix of another with its own messages and children', () => {
    const tree = buildTree([ORDERS], undefined, PATTERNS)
    const orders = tree.byPath.get('orders')!
    expect(orders.own).toBe(5)
    expect(orders.total).toBe(270)
    expect(orders.ownsMessages).toBe(true)
    expect(orders.hasChildren).toBe(true)
    expect(orders.childCount).toBe(2)
    expect(orders.depth).toBe(1)
    expect(tree.byPath.get('orders.eu')!.own).toBe(0)
    expect(tree.byPath.get('orders.eu')!.ownsMessages).toBe(false)
    expect(tree.byPath.get('orders.eu')!.parentPath).toBe('orders')
    expect(tree.byPath.get('orders')!.parentPath).toBeNull()
    expect(tree.subjectCount).toBe(4)
  })

  it('flags live-only nodes and keeps live counts separate', () => {
    const tree = buildTree([ORDERS], { 'orders.eu.created': 3, 'core.ping': 2, 'core.pong': 1 })
    const created = tree.byPath.get('orders.eu.created')!
    expect(created.live).toBe(3)
    expect(created.total).toBe(70)
    expect(created.liveOnly).toBe(false)
    expect(tree.byPath.get('orders.eu')!.liveTotal).toBe(3)
    const core = tree.byPath.get('core')!
    expect(core.liveOnly).toBe(true)
    expect(core.liveTotal).toBe(3)
    expect(core.total).toBe(0)
    expect(core.live).toBe(0)
    expect(tree.byPath.get('core.ping')!.liveOnly).toBe(true)
    expect(tree.liveTotal).toBe(6)
  })

  it('merges duplicate subjects across streams and keeps the breakdown', () => {
    const a: StreamSubjects = { stream: 'A', subjects: [{ subject: 'x.y', count: 4 }] }
    const b: StreamSubjects = { stream: 'B', subjects: [{ subject: 'x.y', count: 9 }] }
    const tree = buildTree([a, b], undefined, [
      { name: 'A', subjects: ['x.>'] },
      { name: 'B', subjects: ['x.y'] },
      { name: 'C', subjects: ['x.*'] },
      { name: 'D', subjects: ['other'] }
    ])
    const xy = tree.byPath.get('x.y')!
    expect(xy.own).toBe(13)
    expect(xy.ownByStream).toEqual({ A: 4, B: 9 })
    expect(xy.byStream).toEqual({ A: 4, B: 9 })
    expect(xy.streams).toEqual(['B', 'A', 'C'])
    expect(xy.ownStreams).toEqual(['B', 'A', 'C'])
    expect(tree.byPath.get('x')!.byStream).toEqual({ A: 4, B: 9 })
    expect(tree.byPath.get('x')!.streams).toEqual(['B', 'A', 'C'])
    expect(tree.byPath.get('x')!.ownStreams).toEqual([])
    expect(tree.total).toBe(13)
    expect(tree.subjectCount).toBe(1)
  })

  it('takes owners from patterns when nothing is stored, including live-only subjects', () => {
    const tree = buildTree([], { 'orders.eu.created': 1, 'telemetry.d1': 1 }, PATTERNS)
    expect(tree.byPath.get('orders.eu.created')!.ownStreams).toEqual(['ORDERS'])
    expect(tree.byPath.get('orders')!.streams).toEqual(['ORDERS'])
    expect(tree.byPath.get('orders')!.ownStreams).toEqual(['ORDERS'])
    expect(tree.byPath.get('telemetry')!.ownStreams).toEqual([])
    expect(tree.byPath.get('telemetry')!.streams).toEqual(['TELEMETRY'])
    expect(tree.byPath.get('telemetry.d1')!.ownStreams).toEqual(['TELEMETRY'])
  })

  it('treats tokens with special characters as plain text', () => {
    const subjects = [
      'a*b.c',
      'cpu>90.x',
      'ünï.cødé',
      'with-dash_and:colon.7',
      'a$b',
      'UP.up',
      'up'
    ]
    const tree = buildTree(
      [{ stream: 'S', subjects: subjects.map((subject) => ({ subject, count: 1 })) }],
      {}
    )
    for (const s of subjects) expect(tree.byPath.get(s)?.own, s).toBe(1)
    expect(tree.byPath.get('a*b')!.token).toBe('a*b')
    expect(tree.byPath.get('UP')!.own).toBe(0)
    expect(tree.byPath.get('up')!.own).toBe(1)
    expect(tree.roots).toHaveLength(7)
  })

  it('supports deep trees without recursion trouble', () => {
    const deep = Array.from({ length: 3000 }, (_, i) => `t${i}`).join('.')
    const tree = buildTree([{ stream: 'S', subjects: [{ subject: deep, count: 2 }] }], {})
    expect(tree.maxDepth).toBe(3000)
    expect(tree.total).toBe(2)
    const all = expandAllPaths(tree)
    expect(all.level).toBe(3000)
    const rows = flatten(tree, { expanded: all.expanded })
    expect(rows).toHaveLength(3000)
    expect(rows[2999].level).toBe(3000)
    expect(rows[2999].hasChildren).toBe(false)
    expect(searchSubjects(tree, 't2999').revealed.size).toBe(2999)
  })
})

describe('flatten', () => {
  const tree = buildTree([ORDERS, TELE], { 'core.ping': 1 }, PATTERNS)

  it('lists top-level rows when nothing is expanded', () => {
    const rows = flatten(tree, { expanded: ex() })
    expect(paths(rows)).toEqual(['orders', 'telemetry', 'core'])
    expect(rows[0]).toMatchObject({
      level: 1,
      posInSet: 1,
      setSize: 3,
      hasChildren: true,
      isOpen: false
    })
    expect(rows[2].posInSet).toBe(3)
  })

  it('shows children of expanded nodes only, depth first, with set positions', () => {
    const rows = flatten(tree, { expanded: ex('orders', 'orders.eu') })
    expect(paths(rows)).toEqual([
      'orders',
      'orders.us',
      'orders.eu',
      'orders.eu.created',
      'orders.eu.paid',
      'telemetry',
      'core'
    ])
    const us = rows[1]
    expect(us).toMatchObject({ level: 2, posInSet: 1, setSize: 2, isOpen: false })
    expect(rows[3]).toMatchObject({ level: 3, posInSet: 1, setSize: 2, hasChildren: false })
    expect(rows[2].isOpen).toBe(true)
  })

  it('ignores expanded paths that do not exist or that have no children', () => {
    const rows = flatten(tree, { expanded: ex('nope', 'orders.eu.created') })
    expect(rows).toHaveLength(3)
    expect(rows.every((r) => !r.isOpen)).toBe(true)
  })

  it('sorts by messages (default), name and live', () => {
    const open = ex('telemetry', 'core', 'orders')
    const kids = (sort: 'messages' | 'name' | 'live'): string[] =>
      paths(flatten(tree, { expanded: open, sort }))
    expect(kids('messages').slice(0, 3)).toEqual(['orders', 'orders.us', 'orders.eu'])
    expect(kids('name').filter((p) => p.startsWith('telemetry.'))).toEqual([
      'telemetry.device1',
      'telemetry.device2',
      'telemetry.device10'
    ])
    expect(paths(flatten(tree, { expanded: open, sort: 'name' })).slice(0, 3)).toEqual([
      'core',
      'core.ping',
      'orders'
    ])
    expect(kids('live')[0]).toBe('core')
    expect(kids('messages').filter((p) => p.startsWith('telemetry.'))).toEqual([
      'telemetry.device1',
      'telemetry.device2',
      'telemetry.device10'
    ])
  })

  it('caches sorted children and does not mutate the original order', () => {
    const before = tree.roots.map((n) => n.path)
    const a = sortedChildren(tree.roots, 'name')
    expect(sortedChildren(tree.roots, 'name')).toBe(a)
    expect(tree.roots.map((n) => n.path)).toEqual(before)
  })

  it('filters with only-with-messages and source, keeping ancestors of what stays', () => {
    const open = ex('orders', 'telemetry', 'core')
    expect(paths(flatten(tree, { expanded: open, onlyWithMessages: true }))).not.toContain('core')
    expect(paths(flatten(tree, { expanded: open, source: 'streams' }))).not.toContain('core.ping')
    const live = flatten(tree, { expanded: open, source: 'live' })
    expect(paths(live)).toEqual(['core', 'core.ping'])
    const eu = buildTree(
      [
        {
          stream: 'S',
          subjects: [
            { subject: 'a.b', count: 1 },
            { subject: 'a.c', count: 0 }
          ]
        }
      ],
      undefined
    )
    expect(paths(flatten(eu, { expanded: ex('a'), onlyWithMessages: true }))).toEqual(['a', 'a.b'])
    // a collapsed node whose only children are filtered out has no chevron
    const none = flatten(tree, { expanded: ex(), source: 'live' })
    expect(none[0]).toMatchObject({ path: 'core', hasChildren: true })
    const withoutLive = flatten(buildTree([ORDERS], { 'orders.zz': 1 }, PATTERNS), {
      expanded: ex('orders.zz'),
      onlyWithMessages: true
    })
    expect(withoutLive[0].hasChildren).toBe(true)
    expect(paths(withoutLive)).toEqual(['orders'])
  })

  it('shows the stream badge only where the owners change', () => {
    const rows = flatten(tree, { expanded: ex('orders', 'orders.eu') })
    const byPath = Object.fromEntries(rows.map((r) => [r.path, r.showStreams]))
    expect(byPath['orders']).toBe(true)
    expect(byPath['orders.eu']).toBe(false)
    expect(byPath['orders.eu.created']).toBe(false)
    expect(byPath['core']).toBe(false)
    const multi = buildTree(
      [{ stream: 'A', subjects: [{ subject: 'x.y', count: 1 }] }],
      undefined,
      [
        { name: 'A', subjects: ['x.y'] },
        { name: 'B', subjects: ['x.>'] }
      ]
    )
    expect(flatten(multi, { expanded: ex('x') }).map((x) => x.showStreams)).toEqual([true, false])
    const split = buildTree(
      [{ stream: 'A', subjects: [{ subject: 'x.y', count: 1 }] }],
      undefined,
      [
        { name: 'A', subjects: ['x.y'] },
        { name: 'B', subjects: ['x.z'] }
      ]
    )
    expect(flatten(split, { expanded: ex('x') }).map((x) => x.showStreams)).toEqual([true, true])
  })
})

describe('search', () => {
  const tree = buildTree([ORDERS, TELE], { 'core.ping': 1 }, PATTERNS)

  it('keeps ancestors, opens them and flags matches, without touching the expanded set', () => {
    const expanded = ex('telemetry')
    const rows = flatten(tree, { expanded, query: 'created' })
    expect(paths(rows)).toEqual([
      'orders',
      'orders.us',
      'orders.us.created',
      'orders.eu',
      'orders.eu.created'
    ])
    expect(rows.map((r) => r.match)).toEqual([false, false, true, false, true])
    expect(rows.every((r) => r.isOpen === r.hasChildren)).toBe(true)
    expect([...expanded]).toEqual(['telemetry'])
    // clearing restores the user's own view
    expect(paths(flatten(tree, { expanded, query: '  ' }))).toEqual(
      paths(flatten(tree, { expanded }))
    )
  })

  it('matches case-insensitively on the full path', () => {
    expect(searchSubjects(tree, 'ORDERS.EU.PAID').count).toBe(1)
    expect(searchSubjects(tree, 'eu.pa').matched).toEqual(ex('orders.eu.paid'))
    expect(searchSubjects(tree, 'zzz').count).toBe(0)
    expect(flatten(tree, { expanded: ex(), query: 'zzz' })).toEqual([])
  })

  it('does not list non-matching children of a matching branch', () => {
    const rows = flatten(tree, { expanded: ex('orders'), query: 'orders.eu' })
    expect(paths(rows)).toEqual(['orders', 'orders.eu', 'orders.eu.created', 'orders.eu.paid'])
    expect(rows[1].match).toBe(true)
    const branch = flatten(tree, { expanded: ex('orders'), query: 'orders.us' })
    expect(branch.find((r) => r.path === 'orders.us')).toMatchObject({
      match: true,
      hasChildren: true
    })
  })

  it('accepts wildcard patterns through subjectMatches', () => {
    expect(searchSubjects(tree, 'orders.*.created').matched).toEqual(
      ex('orders.eu.created', 'orders.us.created')
    )
    expect(searchSubjects(tree, 'orders.>').count).toBe(5)
    expect(searchSubjects(tree, 'orders.>').matched.has('orders')).toBe(false)
    expect(searchSubjects(tree, 'telemetry.*').count).toBe(3)
    expect(searchSubjects(tree, '>').count).toBe(tree.nodeCount)
    // wildcard patterns are case sensitive like NATS
    expect(searchSubjects(tree, 'ORDERS.*').count).toBe(0)
    const rows = flatten(tree, { expanded: ex(), query: 'orders.*.paid' })
    expect(paths(rows)).toEqual(['orders', 'orders.eu', 'orders.eu.paid'])
  })

  it('treats * and > inside a token as text', () => {
    const t = buildTree(
      [
        {
          stream: 'S',
          subjects: [
            { subject: 'a*b.c', count: 1 },
            { subject: 'axb.c', count: 1 }
          ]
        }
      ],
      {}
    )
    expect(searchSubjects(t, 'a*b').matched).toEqual(ex('a*b', 'a*b.c'))
  })

  it('applies the filters to matches', () => {
    expect(searchSubjects(tree, 'ping', { source: 'streams' }).count).toBe(0)
    expect(searchSubjects(tree, 'ping', { source: 'live' }).count).toBe(1)
    expect(
      paths(flatten(tree, { expanded: ex(), query: 'o', onlyWithMessages: true }))
    ).not.toContain('core')
  })
})

describe('expansion', () => {
  const tree = buildTree([ORDERS, TELE], { 'core.ping': 1 }, PATTERNS)

  it('expands to a level', () => {
    expect(expandToLevel(tree, 1)).toEqual({ expanded: new Set(), level: 1, capped: false })
    const two = expandToLevel(tree, 2)
    expect([...two.expanded].sort()).toEqual(['core', 'orders', 'telemetry'])
    expect(flatten(tree, { expanded: two.expanded })).toHaveLength(3 + 2 + 3 + 1)
    const three = expandToLevel(tree, 3)
    expect(three.expanded).toEqual(ex('core', 'orders', 'telemetry', 'orders.eu', 'orders.us'))
    expect(three.level).toBe(3)
    expect(expandToLevel(tree, 99).level).toBe(3)
    expect(expandToLevel(tree, 0).level).toBe(1)
    expect(defaultExpanded(tree)).toEqual(two.expanded)
  })

  it('expands all when under the cap', () => {
    const all = expandAllPaths(tree)
    expect(all).toMatchObject({ level: 3, capped: false })
    expect(flatten(tree, { expanded: all.expanded })).toHaveLength(tree.nodeCount)
  })

  it('respects filters when counting levels and picking nodes', () => {
    const r = expandToLevel(tree, 'all', { source: 'live' })
    expect(r.level).toBe(2)
    expect(r.expanded).toEqual(ex('core'))
  })

  it('caps expand all at the deepest level that fits', () => {
    const subjects: { subject: string; count: number }[] = []
    for (let a = 0; a < 10; a++)
      for (let b = 0; b < 10; b++)
        for (let c = 0; c < 10; c++) subjects.push({ subject: `a${a}.b${b}.c${c}`, count: 1 })
    const big = buildTree([{ stream: 'S', subjects }], {})
    // levels hold 10, 100, 1000 nodes: cumulative 10, 110, 1110
    expect(expandAllPaths(big, 5000)).toMatchObject({ level: 3, capped: false })
    const capped = expandAllPaths(big, 1000)
    expect(capped).toMatchObject({ level: 2, capped: true })
    expect(capped.expanded.size).toBe(10)
    expect(flatten(big, { expanded: capped.expanded })).toHaveLength(110)
    expect(expandAllPaths(big, 110)).toMatchObject({ level: 2, capped: true })
    expect(expandAllPaths(big, 1109)).toMatchObject({ level: 2, capped: true })
    expect(expandAllPaths(big, 1110)).toMatchObject({ level: 3, capped: false })
    // the first level is always shown, even when it exceeds the cap
    expect(expandAllPaths(big, 3)).toMatchObject({ level: 1, capped: true })
    // an explicit level is not capped
    expect(expandToLevel(big, 3, {}, 5).level).toBe(3)
  })
})

describe('scopes', () => {
  it('maps a scope to the filter subject', () => {
    expect(scopeFilter('orders.eu', 'subject')).toBe('orders.eu')
    expect(scopeFilter('orders.eu', 'below')).toBe('orders.eu.>')
    expect(scopeFilter('orders.eu', 'children')).toBe('orders.eu.*')
    for (const scope of ['subject', 'below', 'children'] as const) {
      for (const path of ['a', 'a.b.c', 'a*b.c', 'ünï']) {
        expect(validateSubject(scopeFilter(path, scope)), `${path} ${scope}`).toBeNull()
      }
    }
  })

  it('allows publishing only for the exact subject', () => {
    expect(canPublish('orders.eu', 'subject')).toBe(true)
    expect(canPublish('orders.eu', 'below')).toBe(false)
    expect(canPublish('orders.eu', 'children')).toBe(false)
    expect(canPublish('a.*', 'subject')).toBe(false)
    expect(canPublish('', 'subject')).toBe(false)
    expect(canPublish('a b', 'subject')).toBe(false)
  })

  it('offers scopes by what the node is', () => {
    const tree = buildTree([ORDERS, TELE], { 'core.ping': 1 })
    const node = (p: string) => tree.byPath.get(p)!
    expect(availableScopes(node('orders'))).toEqual(['subject', 'below', 'children'])
    expect(defaultScope(node('orders'))).toBe('below')
    expect(availableScopes(node('orders.eu'))).toEqual(['below', 'children'])
    expect(availableScopes(node('orders.eu.paid'))).toEqual(['subject'])
    expect(defaultScope(node('orders.eu.paid'))).toBe('subject')
    expect(availableScopes(node('core'))).toEqual(['below', 'children'])
    expect(availableScopes(node('core.ping'))).toEqual(['subject'])
  })

  it('finds every owning stream of a subject', () => {
    const streams: StreamPatterns[] = [
      { name: 'A', subjects: ['x.>'] },
      { name: 'B', subjects: ['x.y', 'q'] },
      { name: 'M', subjects: [] }
    ]
    expect(ownersFor('x.y', streams)).toEqual(['A', 'B'])
    expect(ownersFor('x', streams)).toEqual([])
    expect(ownersFor('q', streams)).toEqual(['B'])
  })
})

describe('large trees', () => {
  it('flattens 10,000 subjects, all expanded, quickly and correctly', () => {
    const subjects: { subject: string; count: number }[] = []
    for (let i = 0; i < 10_000; i++) {
      subjects.push({ subject: `svc${i % 20}.region${i % 7}.item${i}`, count: (i % 50) + 1 })
    }
    const t0 = performance.now()
    const tree: SubjectTree = buildTree([{ stream: 'BIG', subjects }], undefined, [
      { name: 'BIG', subjects: ['svc*.>', 'svc0.>'] }
    ])
    const t1 = performance.now()
    const all = expandToLevel(tree, 'all', {}, Infinity)
    const rows = flatten(tree, { expanded: all.expanded })
    const t2 = performance.now()
    const searched = flatten(tree, { expanded: new Set(), query: 'item99' })
    const t3 = performance.now()
    console.log(
      `build ${(t1 - t0).toFixed(0)} ms, expand+flatten ${(t2 - t1).toFixed(0)} ms, search ${(t3 - t2).toFixed(0)} ms`
    )
    expect(rows).toHaveLength(tree.nodeCount)
    expect(tree.subjectCount).toBe(10_000)
    expect(tree.roots).toHaveLength(20)
    expect(tree.total).toBe(subjects.reduce((n, s) => n + s.count, 0))
    expect(rows.filter((r) => !r.hasChildren)).toHaveLength(10_000)
    expect(searched.some((r) => r.path.endsWith('item9999') && r.match)).toBe(true)
    expect(t2 - t1).toBeLessThan(1000)
  })
})
