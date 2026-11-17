/**
 * The actions of a subject (Browse stored messages, Start live tail, Publish message, Copy), as
 * plain descriptors shared by the detail pane and the row menu of the Subjects screen (PBI-127),
 * so labels, filters and disabled reasons exist in one place. `rowMenuItems` builds icons with
 * `createElement`, so this file stays free of JSX.
 */
import { createElement, type ReactNode } from 'react'
import { Copy, Database, Radio, Send } from 'lucide-react'
import { toast } from '../../state/toasts'
import { subjectsOverlap } from '@shared/subject'
import { readOnlyProps, type MenuItem } from '../../components/ui'
import {
  availableScopes,
  canPublish,
  defaultScope,
  scopeFilter,
  streamsForScope,
  type StreamPatterns,
  type SubjectInfo,
  type SubjectScope
} from './subjectTree'

/** The part of the tabs store the actions need (`useTabs()` fits). */
export interface ActionTabs {
  open(spec: {
    kind: 'stream'
    connId: string
    stream: string
    section: 'messages'
    subject: string
    seq: undefined
  }): void
  openNew(kind: 'tail' | 'publish', connId: string, subject?: string): void
}

export interface ActionDescriptor {
  /** Button text. */
  label: string
  /** The subject or filter the action works on; null when the node offers no scope. */
  subject: string | null
  enabled: boolean
  /** Why the action is unavailable (set when `enabled` is false). */
  reason?: string
}

export interface BrowseAction extends ActionDescriptor {
  /** Streams that can be browsed, the one with the most stored messages first. */
  streams: string[]
  /** The stream used when none is chosen. */
  defaultStream: string | null
}

export interface SubjectActions {
  scope: SubjectScope | null
  /** The filter of the scope (`orders.>`), null for an invalid subject. */
  filter: string | null
  browse: BrowseAction
  tail: ActionDescriptor
  publish: ActionDescriptor
  copySubject: ActionDescriptor
  copyFilter: ActionDescriptor
}

export const LABELS = {
  browse: 'Browse stored messages',
  tail: 'Start live tail',
  publish: 'Publish message',
  copySubject: 'Copy subject',
  copyFilter: 'Copy filter'
} as const

export const INVALID_REASON =
  'This path is not a valid subject (it has an empty token, whitespace or a wildcard), so it cannot be used as a filter.'
export const NO_STREAM_REASON = 'No stream stores or captures this subject.'
export const WILDCARD_REASON =
  'Publishing needs one exact subject. Choose "This subject" or pick a leaf.'
export const NO_CONCRETE_REASON =
  'Publish needs a concrete subject; select a leaf or a subject with its own messages.'
export const READ_ONLY_REASON = readOnlyProps(true).title as string

/** Stored messages of one stream within a scope. */
export function storedInScope(node: SubjectInfo, scope: SubjectScope, stream: string): number {
  if (scope === 'subject') return node.ownByStream[stream] ?? 0
  if (scope === 'children') return node.childByStream[stream] ?? 0
  return Math.max(0, (node.byStream[stream] ?? 0) - (node.ownByStream[stream] ?? 0))
}

export interface ScopeStream {
  name: string
  /** Stored messages in the scope; 0 for a stream that only captures the subject. */
  stored: number
}

/**
 * Every stream that holds or would capture the scope's filter: the streams with stored messages
 * (most first, as `streamsForScope`), then the streams whose patterns capture the filter but hold
 * nothing there. `streamsForScope` leaves those out when data exists, but Live tail and Publish
 * still reach them, so the detail pane lists them.
 */
export function scopeStreams(
  node: SubjectInfo,
  scope: SubjectScope,
  streams: readonly StreamPatterns[]
): ScopeStream[] {
  const out = streamsForScope(node, scope, streams).map((name) => ({
    name,
    stored: storedInScope(node, scope, name)
  }))
  const seen = new Set(out.map((s) => s.name))
  const filter = scopeFilter(node.path, scope)
  for (const s of streams) {
    if (!seen.has(s.name) && s.subjects.some((p) => subjectsOverlap(p, filter))) {
      seen.add(s.name)
      out.push({ name: s.name, stored: 0 })
    }
  }
  return out
}

/** The scope in use: the chosen one when the node offers it, else the default; null if none. */
export function resolveScope(node: SubjectInfo, chosen?: SubjectScope | null): SubjectScope | null {
  const scopes = availableScopes(node)
  if (scopes.length === 0) return null
  if (chosen && scopes.includes(chosen)) return chosen
  const def = defaultScope(node)
  return scopes.includes(def) ? def : scopes[0]
}

/**
 * Describes every action for a node and scope: the filter each one uses, whether it is enabled and
 * why not. `scope` null (an invalid subject) disables all but Copy subject.
 */
export function describeActions(
  node: SubjectInfo,
  scope: SubjectScope | null,
  streams: readonly StreamPatterns[],
  readOnly: boolean
): SubjectActions {
  const filter = scope ? scopeFilter(node.path, scope) : null
  const copySubject: ActionDescriptor = {
    label: LABELS.copySubject,
    subject: node.path,
    enabled: true
  }
  if (scope === null || filter === null) {
    const off = (label: string): ActionDescriptor => ({
      label,
      subject: null,
      enabled: false,
      reason: INVALID_REASON
    })
    return {
      scope: null,
      filter: null,
      browse: { ...off(LABELS.browse), streams: [], defaultStream: null },
      tail: off(LABELS.tail),
      publish: off(LABELS.publish),
      copySubject,
      copyFilter: off(LABELS.copyFilter)
    }
  }
  const browseStreams = streamsForScope(node, scope, streams)
  const browse: BrowseAction = {
    label: LABELS.browse,
    subject: filter,
    enabled: browseStreams.length > 0,
    reason: browseStreams.length > 0 ? undefined : NO_STREAM_REASON,
    streams: browseStreams,
    defaultStream: browseStreams[0] ?? null
  }
  const publishReasons: string[] = []
  if (!canPublish(node.path, scope))
    publishReasons.push(
      availableScopes(node).includes('subject') ? WILDCARD_REASON : NO_CONCRETE_REASON
    )
  if (readOnly) publishReasons.push(READ_ONLY_REASON)
  return {
    scope,
    filter,
    browse,
    tail: { label: LABELS.tail, subject: filter, enabled: true },
    publish: {
      label: LABELS.publish,
      subject: node.path,
      enabled: publishReasons.length === 0,
      reason: publishReasons.length ? publishReasons.join(' ') : undefined
    },
    copySubject,
    copyFilter: { label: LABELS.copyFilter, subject: filter, enabled: true }
  }
}

/** Opens Browse in the Messages section of a stream, filtered on the scope's filter. */
export function runBrowse(
  tabs: ActionTabs,
  connId: string,
  action: BrowseAction,
  stream: string | null = action.defaultStream
): void {
  if (!action.enabled || !action.subject || !stream) return
  tabs.open({
    kind: 'stream',
    connId,
    stream,
    section: 'messages',
    subject: action.subject,
    seq: undefined
  })
}

/** Opens a Live tail tab on the scope's filter. */
export function runTail(tabs: ActionTabs, connId: string, action: ActionDescriptor): void {
  if (action.enabled && action.subject) tabs.openNew('tail', connId, action.subject)
}

/** Opens the Publish tab with the exact subject. Sending still goes through the gateway rules. */
export function runPublish(tabs: ActionTabs, connId: string, action: ActionDescriptor): void {
  if (action.enabled && action.subject) tabs.openNew('publish', connId, action.subject)
}

/** Copies text; resolves to false when the clipboard is missing or refuses (never rejects). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** Copies text and tells the user the result with a toast (for the row menu). */
export async function copyWithToast(text: string, what: string): Promise<boolean> {
  const ok = await copyText(text)
  if (ok) toast.ok(`Copied ${what}`)
  else toast.error(`Could not copy ${what}. The clipboard is not available.`)
  return ok
}

const icon = (c: typeof Database): ReactNode =>
  createElement(c, { className: 'h-3.5 w-3.5', 'aria-hidden': true })

/**
 * Menu items for a row (the kebab menu), with the filter in each label: "Start live tail on
 * orders.>". With several candidate streams Browse has one item per stream.
 */
export function rowMenuItems(
  node: SubjectInfo,
  ctx: {
    connId: string
    tabs: ActionTabs
    streams: readonly StreamPatterns[]
    readOnly: boolean
    /** Defaults to the node's default scope. */
    scope?: SubjectScope | null
  }
): MenuItem[] {
  const a = describeActions(node, resolveScope(node, ctx.scope), ctx.streams, ctx.readOnly)
  const where = a.filter ? ` on ${a.filter}` : ''
  const items: MenuItem[] = []
  if (a.browse.streams.length > 1) {
    for (const s of a.browse.streams)
      items.push({
        label: `${a.browse.label}${where} in ${s}`,
        icon: icon(Database),
        onSelect: () => runBrowse(ctx.tabs, ctx.connId, a.browse, s)
      })
  } else {
    items.push({
      label: `${a.browse.label}${where}`,
      icon: icon(Database),
      disabled: !a.browse.enabled,
      title: a.browse.reason,
      onSelect: () => runBrowse(ctx.tabs, ctx.connId, a.browse)
    })
  }
  items.push(
    {
      label: `${a.tail.label}${where}`,
      icon: icon(Radio),
      disabled: !a.tail.enabled,
      title: a.tail.reason,
      onSelect: () => runTail(ctx.tabs, ctx.connId, a.tail)
    },
    {
      label: `${a.publish.label} to ${node.path}`,
      icon: icon(Send),
      disabled: !a.publish.enabled,
      title: a.publish.reason,
      onSelect: () => runPublish(ctx.tabs, ctx.connId, a.publish)
    },
    {
      label: a.copySubject.label,
      icon: icon(Copy),
      onSelect: () => void copyWithToast(node.path, node.path)
    }
  )
  if (a.filter) {
    const filter = a.filter
    items.push({
      label: `${a.copyFilter.label} (${filter})`,
      icon: icon(Copy),
      onSelect: () => void copyWithToast(filter, filter)
    })
  }
  return items
}
