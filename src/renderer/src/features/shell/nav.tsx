import type { ReactNode } from 'react'
import {
  Bell,
  Database,
  FileCode,
  KeyRound,
  LayoutDashboard,
  ListTree,
  Package,
  Radio,
  ScrollText,
  Send,
  Users
} from 'lucide-react'
import { tabId, useTabs, type TabSpec } from '../../state/tabs'

export type NavKind =
  | 'overview'
  | 'streams'
  | 'consumers'
  | 'subjects'
  | 'tail'
  | 'publish'
  | 'kv'
  | 'objects'
  | 'alerts'
  | 'decoders'
  | 'audit'

export const NAV: { kind: NavKind; label: string }[] = [
  { kind: 'overview', label: 'Overview' },
  { kind: 'streams', label: 'Streams' },
  { kind: 'consumers', label: 'Consumers' },
  { kind: 'subjects', label: 'Subjects' },
  { kind: 'tail', label: 'Live tail' },
  { kind: 'publish', label: 'Publish' },
  { kind: 'kv', label: 'KV buckets' },
  { kind: 'objects', label: 'Object stores' },
  { kind: 'alerts', label: 'Alerts' },
  { kind: 'decoders', label: 'Decoders' },
  { kind: 'audit', label: 'Audit log' }
]

export function TabIcon({
  kind,
  className = 'h-3.5 w-3.5 shrink-0'
}: {
  kind: TabSpec['kind']
  className?: string
}): ReactNode {
  const props = { className, 'aria-hidden': true } as const
  switch (kind) {
    case 'overview':
      return <LayoutDashboard {...props} />
    case 'streams':
    case 'stream':
      return <Database {...props} />
    case 'consumers':
    case 'consumer':
      return <Users {...props} />
    case 'subjects':
      return <ListTree {...props} />
    case 'tail':
      return <Radio {...props} />
    case 'publish':
      return <Send {...props} />
    case 'kv':
    case 'kvBucket':
      return <KeyRound {...props} />
    case 'objects':
    case 'objBucket':
      return <Package {...props} />
    case 'alerts':
      return <Bell {...props} />
    case 'decoders':
      return <FileCode {...props} />
    case 'audit':
      return <ScrollText {...props} />
  }
}

/** Opens a section of a connection. Tail and publish reuse an open tab of that kind if there is one. */
export function openNav(connId: string, kind: NavKind): void {
  const tabs = useTabs.getState()
  if (kind === 'tail' || kind === 'publish') {
    const existing = tabs.tabs.find((t) => t.spec.kind === kind && t.spec.connId === connId)
    if (existing) tabs.activate(existing.id)
    else tabs.openNew(kind, connId)
    return
  }
  tabs.open({ kind, connId } as TabSpec)
}

export function isNavActive(connId: string, kind: NavKind, active: TabSpec | undefined): boolean {
  if (!active || active.connId !== connId) return false
  const groups: Record<NavKind, TabSpec['kind'][]> = {
    overview: ['overview'],
    streams: ['streams', 'stream'],
    consumers: ['consumers', 'consumer'],
    subjects: ['subjects'],
    tail: ['tail'],
    publish: ['publish'],
    kv: ['kv', 'kvBucket'],
    objects: ['objects', 'objBucket'],
    alerts: ['alerts'],
    decoders: ['decoders'],
    audit: ['audit']
  }
  return groups[kind].includes(active.kind)
}

export { tabId }
