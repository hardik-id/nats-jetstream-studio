import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type StreamSection = 'overview' | 'consumers' | 'subjects' | 'config'

/** What a tab shows. Everything needed to rebuild the tab after a restart lives here. */
export type TabSpec =
  | { kind: 'overview'; connId: string }
  | { kind: 'streams'; connId: string }
  | {
      kind: 'stream'
      connId: string
      stream: string
      section?: StreamSection
    }
  /** The message browser of a connection (PBI-128): one per connection, reused for any stream. */
  | { kind: 'messages'; connId: string; stream?: string; subject?: string; seq?: number }
  | { kind: 'consumers'; connId: string }
  | { kind: 'consumer'; connId: string; stream: string; consumer: string }
  | { kind: 'subjects'; connId: string }
  | { kind: 'tail'; connId: string; subject?: string; n: number }
  | { kind: 'publish'; connId: string; subject?: string; n: number }
  | { kind: 'kv'; connId: string }
  | { kind: 'kvBucket'; connId: string; bucket: string }
  | { kind: 'objects'; connId: string }
  | { kind: 'objBucket'; connId: string; bucket: string }
  | { kind: 'alerts'; connId: string }
  | { kind: 'decoders'; connId: string }
  | { kind: 'audit'; connId: string }

export interface Tab {
  id: string
  spec: TabSpec
}

/** Tabs with the same id are the same tab, so opening a stream twice focuses the first one. */
export function tabId(spec: TabSpec): string {
  switch (spec.kind) {
    case 'stream':
      return `stream:${spec.connId}:${spec.stream}`
    case 'consumer':
      return `consumer:${spec.connId}:${spec.stream}:${spec.consumer}`
    case 'kvBucket':
      return `kvBucket:${spec.connId}:${spec.bucket}`
    case 'objBucket':
      return `objBucket:${spec.connId}:${spec.bucket}`
    case 'tail':
    case 'publish':
      return `${spec.kind}:${spec.connId}:${spec.n}`
    default:
      return `${spec.kind}:${spec.connId}`
  }
}

export function tabTitle(spec: TabSpec): string {
  switch (spec.kind) {
    case 'overview':
      return 'Overview'
    case 'streams':
      return 'Streams'
    case 'stream':
      return spec.stream
    case 'messages':
      return spec.stream ? `${spec.stream} messages` : 'Messages'
    case 'consumers':
      return 'Consumers'
    case 'consumer':
      return `${spec.consumer}`
    case 'subjects':
      return 'Subjects'
    case 'tail':
      return spec.subject ? `Tail ${spec.subject}` : 'Live tail'
    case 'publish':
      return 'Publish'
    case 'kv':
      return 'KV buckets'
    case 'kvBucket':
      return spec.bucket
    case 'objects':
      return 'Object stores'
    case 'objBucket':
      return spec.bucket
    case 'alerts':
      return 'Alerts'
    case 'decoders':
      return 'Decoders'
    case 'audit':
      return 'Audit log'
  }
}

/** What to show in the Messages tab: a stream, and a subject filter or a sequence to start at. */
export interface MessagesTarget {
  stream?: string
  subject?: string
  seq?: number
}

/**
 * The spec that opens the Messages tab of a connection. With a stream, the subject and sequence
 * are always set (undefined included) so a stale filter of the previous visit is replaced; without
 * one, the open tab keeps what it shows.
 */
export function messagesSpec(connId: string, target: MessagesTarget = {}): TabSpec {
  if (!target.stream) return { kind: 'messages', connId }
  return {
    kind: 'messages',
    connId,
    stream: target.stream,
    subject: target.subject,
    seq: target.seq
  }
}

/** The version of the stored tabs. 1: the Messages sub-tab of a stream became its own tab. */
export const TABS_VERSION = 1

/**
 * Brings tabs stored by an older version up to date. A stream tab left on its Messages section
 * (version 0) opens on Overview, without the subject and sequence that only served that section.
 */
export function migrateTabs(persisted: unknown, version: number): unknown {
  if (version >= 1 || !persisted || typeof persisted !== 'object') return persisted
  const state = persisted as { tabs?: unknown }
  if (!Array.isArray(state.tabs)) return persisted
  return {
    ...state,
    tabs: state.tabs.map((tab: unknown) => {
      const t = tab as { spec?: Record<string, unknown> } | null
      const spec = t?.spec
      if (!spec || spec.kind !== 'stream') return tab
      const { subject: _subject, seq: _seq, ...rest } = spec
      return {
        ...t,
        spec: { ...rest, section: spec.section === 'messages' ? 'overview' : spec.section }
      }
    })
  }
}

interface TabsState {
  tabs: Tab[]
  activeId: string | null
  counter: number
  open(spec: TabSpec): void
  /** Opens another tail or publish tab even when one exists. */
  openNew(kind: 'tail' | 'publish', connId: string, subject?: string): void
  close(id: string): void
  closeOthers(id: string): void
  activate(id: string): void
  move(from: number, to: number): void
  patch(id: string, patch: Partial<TabSpec>): void
  closeConnection(connId: string): void
  cycle(delta: number): void
}

export const useTabs = create<TabsState>()(
  persist(
    (set, get) => ({
      tabs: [],
      activeId: null,
      counter: 1,
      open(spec) {
        const id = tabId(spec)
        const existing = get().tabs.find((t) => t.id === id)
        if (existing) {
          // Re-opening with new details (a subject to filter on, say) updates the open tab.
          set({
            activeId: id,
            tabs: get().tabs.map((t) =>
              t.id === id ? { id, spec: { ...t.spec, ...spec } as TabSpec } : t
            )
          })
        } else {
          set({ tabs: [...get().tabs, { id, spec }], activeId: id })
        }
      },
      openNew(kind, connId, subject) {
        const n = get().counter
        const spec = { kind, connId, subject, n } as TabSpec
        set({
          counter: n + 1,
          tabs: [...get().tabs, { id: tabId(spec), spec }],
          activeId: tabId(spec)
        })
      },
      close(id) {
        const { tabs, activeId } = get()
        const index = tabs.findIndex((t) => t.id === id)
        if (index < 0) return
        const next = tabs.filter((t) => t.id !== id)
        set({
          tabs: next,
          activeId:
            activeId === id ? (next[Math.min(index, next.length - 1)]?.id ?? null) : activeId
        })
      },
      closeOthers(id) {
        set({ tabs: get().tabs.filter((t) => t.id === id), activeId: id })
      },
      activate(id) {
        if (get().tabs.some((t) => t.id === id)) set({ activeId: id })
      },
      move(from, to) {
        const tabs = [...get().tabs]
        if (from < 0 || from >= tabs.length || to < 0 || to >= tabs.length) return
        const [tab] = tabs.splice(from, 1)
        tabs.splice(to, 0, tab)
        set({ tabs })
      },
      patch(id, patch) {
        set({
          tabs: get().tabs.map((t) =>
            t.id === id ? { id, spec: { ...t.spec, ...patch } as TabSpec } : t
          )
        })
      },
      closeConnection(connId) {
        const tabs = get().tabs.filter((t) => t.spec.connId !== connId)
        const activeId = tabs.some((t) => t.id === get().activeId)
          ? get().activeId
          : (tabs[tabs.length - 1]?.id ?? null)
        set({ tabs, activeId })
      },
      cycle(delta) {
        const { tabs, activeId } = get()
        if (tabs.length === 0) return
        const index = tabs.findIndex((t) => t.id === activeId)
        set({ activeId: tabs[(index + delta + tabs.length) % tabs.length].id })
      }
    }),
    { name: 'studio.tabs.v1', version: TABS_VERSION, migrate: migrateTabs as never }
  )
)
