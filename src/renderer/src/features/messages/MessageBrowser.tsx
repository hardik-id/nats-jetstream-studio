import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Bookmark,
  ChevronLeft,
  ChevronRight,
  ChevronsUp,
  Download,
  Filter,
  RefreshCw,
  Repeat,
  Terminal,
  Trash2,
  X
} from 'lucide-react'
import {
  GatewayError,
  type ContentFilters,
  type MessageDto,
  type MessageStart,
  type ScanEvent,
  type StreamInfoDto
} from '@shared/api'
import { hasContentFilters } from '@shared/filters'
import { formatBytes, formatCount, formatTime } from '@shared/format'
import { validateSubject } from '@shared/subject'
import { DataTable, type Column } from '../../components/DataTable'
import { MessageDetail } from '../../components/MessageDetail'
import {
  Button,
  Dialog,
  EmptyState,
  errorMessage,
  ErrorNote,
  Field,
  Input,
  Menu,
  Notice,
  readOnlyProps,
  Select,
  type MenuItem
} from '../../components/ui'
import { useGateway } from '../../gateway'
import { useDecoders } from '../../lib/decoders'
import { useFavorites } from '../../lib/favorites'
import { pickFile, safeFileName, saveText } from '../../lib/files'
import { useConnection, useLatest, useSetting, useTabActive } from '../../lib/hooks'
import {
  filterChips,
  natsPubCommand,
  payloadPreview,
  removeChip,
  serializeExport,
  toExported,
  MAX_SAVED_FILTER_NAME,
  MAX_SAVED_FILTERS,
  type ExportedMessage,
  type SavedFilter
} from '../../lib/messages'
import {
  buildSavedExport,
  describeImport,
  describeSaved,
  mergeSavedExport,
  parseSavedExport,
  serializeSavedExport
} from '../../lib/savedExport'
import { toast } from '../../state/toasts'
import { requestRail } from '../../state/ui'
import { draftFrom, FilterPanel } from './FilterPanel'
import { DeleteMessageDialog, ExportAllDialog, RepublishDialog } from './MessageDialogs'

type Walk = 'asc' | 'desc'
type StartMode = 'latest' | 'first' | 'seq' | 'time'

interface View {
  order: Walk
  pageSize: number
  subject: string
  filters: ContentFilters
  scanLimit: number
}

interface Outcome {
  reason: Extract<ScanEvent, { type: 'done' }>['reason']
  scanned: number
  matched: number
  skippedNonJson: number
  resumeSeq: number | null
  walk: Walk
}

const FULL_PAYLOAD = 64 * 1024 * 1024
/** An export of saved filters and favourites is a few kilobytes; anything huge is another file. */
const MAX_SAVED_IMPORT_BYTES = 1024 * 1024

/** datetime-local wants "YYYY-MM-DDTHH:MM:SS" in local time. */
function toLocalInput(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * Pages through the messages of a stream (PBI-040 to PBI-048). Reading never creates a consumer
 * or acknowledges anything, so it is safe on any stream, including work queues.
 */
const DETAIL_MIN_WIDTH = 440
const DETAIL_DEFAULT_WIDTH = 480
const DETAIL_STEP = 24

/** The detail panel's frame: a separator on its left edge resizes it by pointer or arrow keys. */
function ResizableDetail({
  width,
  onWidth,
  onCommit,
  children
}: {
  width: number
  onWidth: (w: number) => void
  onCommit: (w: number) => void
  children: ReactNode
}): ReactNode {
  const frame = useRef<HTMLDivElement>(null)
  // The panel may take at most 70% of the row, so the table always keeps room.
  const maxWidth = (): number => {
    const row = frame.current?.parentElement?.clientWidth || 1600
    return Math.max(DETAIL_MIN_WIDTH, Math.floor(row * 0.7))
  }
  const clamp = (w: number): number =>
    Math.min(maxWidth(), Math.max(DETAIL_MIN_WIDTH, Math.round(w)))
  const current = Math.max(DETAIL_MIN_WIDTH, Math.round(width))
  const drag = useRef<{ x: number; width: number; last: number } | null>(null)
  return (
    <div
      ref={frame}
      className="relative shrink-0"
      style={{ width: current, maxWidth: '70%', minWidth: DETAIL_MIN_WIDTH }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize message detail"
        aria-valuenow={current}
        aria-valuemin={DETAIL_MIN_WIDTH}
        tabIndex={0}
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none hover:bg-accent/40 active:bg-accent/60"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { x: e.clientX, width: current, last: current }
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d) return
          d.last = clamp(d.width + (d.x - e.clientX))
          onWidth(d.last)
        }}
        onPointerUp={() => {
          const d = drag.current
          drag.current = null
          if (d) onCommit(d.last)
        }}
        onKeyDown={(e) => {
          const delta =
            e.key === 'ArrowLeft' ? DETAIL_STEP : e.key === 'ArrowRight' ? -DETAIL_STEP : 0
          if (e.key === 'Home') onCommit(DETAIL_MIN_WIDTH)
          else if (e.key === 'End') onCommit(maxWidth())
          else if (delta) onCommit(clamp(current + delta))
          else return
          e.preventDefault()
        }}
      />
      {children}
    </div>
  )
}

export function MessageBrowser({
  connId,
  info,
  requestSubject,
  requestSeq,
  visible = true
}: {
  connId: string
  info: StreamInfoDto
  requestSubject?: string
  requestSeq?: number
  /** False while another section of the stream is shown (this page stays mounted). */
  visible?: boolean
}): ReactNode {
  const tabActive = useTabActive()
  const gateway = useGateway()
  const conn = useConnection(connId)
  const decoders = useDecoders(connId)
  const stream = info.config.name

  const [view, setView] = useState<View>({
    order: 'desc',
    pageSize: 50,
    subject: requestSubject ?? '',
    filters: {},
    scanLimit: 10_000
  })
  const [subjectDraft, setSubjectDraft] = useState(view.subject)
  const [panelOpen, setPanelOpen] = useState(false)
  const [startMode, setStartMode] = useState<StartMode>('latest')
  const [seqInput, setSeqInput] = useState('')
  const [timeInput, setTimeInput] = useState(() => toLocalInput(new Date()))

  const [messages, setMessages] = useState<MessageDto[]>([])
  const [busy, setBusy] = useState<null | 'loading' | 'scanning'>(null)
  const [progress, setProgress] = useState({ scanned: 0, matched: 0 })
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [more, setMore] = useState({ older: false, newer: false })
  const [loadedOnce, setLoadedOnce] = useState(false)

  const [selected, setSelected] = useState<number | null>(null)
  const [fullBytes, setFullBytes] = useState<number | undefined>(undefined)
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [dialog, setDialog] = useState<
    null | 'delete' | 'republishOne' | 'republishMany' | 'exportAll' | 'saveFilter'
  >(null)
  const [saved, setSaved, savedLoaded, savedLoadError] = useSetting<SavedFilter[]>(
    `conn:${connId}:savedFilters`,
    []
  )
  const {
    favorites,
    replace: setFavorites,
    loaded: favoritesLoaded,
    loadError: favoritesLoadError
  } = useFavorites(connId)
  // Until a list has been read from the settings it is shown as empty, which says nothing about
  // what is stored. Anything that writes a list built from the current one (saving a filter, an
  // import) or that claims to hold everything (an export) has to wait, or it would replace what
  // is stored with that empty list. This is the reason shown while it has to wait.
  const savedBlocked = savedLoaded
    ? null
    : savedLoadError
      ? `The saved filters of this connection could not be read. ${errorMessage(savedLoadError)}`
      : 'The saved filters of this connection are still being read'
  const listsBlocked =
    savedBlocked ??
    (favoritesLoaded
      ? null
      : favoritesLoadError
        ? `The favourites of this connection could not be read. ${errorMessage(favoritesLoadError)}`
        : 'The favourites of this connection are still being read')
  // An import merges into the lists as they are when the file has been read.
  const latestSaved = useLatest({ saved, favorites, blocked: listsBlocked })

  const runToken = useRef(0)
  const stopScan = useRef<(() => void) | null>(null)
  const walked = useRef<{ walk: Walk; messages: MessageDto[] }>({ walk: 'desc', messages: [] })
  const boundsRef = useRef({ firstSeq: info.state.first_seq, lastSeq: info.state.last_seq })
  useEffect(() => {
    boundsRef.current = { firstSeq: info.state.first_seq, lastSeq: info.state.last_seq }
  }, [info.state.first_seq, info.state.last_seq])
  useEffect(() => () => stopScan.current?.(), [])

  /**
   * Loads one page. `walk` is the direction messages are read in; it differs from the display
   * order when going back a page. `paging` says which edge the request extends, so an empty
   * result keeps the current page instead of blanking it. `base` continues a scan.
   */
  const run = useCallback(
    (
      walk: Walk,
      start: MessageStart,
      v: View,
      opts: { paging?: 'older' | 'newer'; base?: MessageDto[] } = {}
    ): void => {
      stopScan.current?.()
      stopScan.current = null
      const token = ++runToken.current
      const base = opts.base ?? []
      setError(null)
      setNotice(null)
      setOutcome(null)

      const finish = (found: MessageDto[], exhausted: boolean, pageNotice?: string): void => {
        if (token !== runToken.current) return
        setBusy(null)
        setLoadedOnce(true)
        const all = [...base, ...found]
        if (all.length === 0 && opts.paging) {
          setMore((m) => ({ ...m, [opts.paging!]: false }))
          setNotice(
            opts.paging === 'older'
              ? 'There are no older messages that match.'
              : 'There are no newer messages that match.'
          )
          return
        }
        walked.current = { walk, messages: all }
        setMessages(walk === v.order ? all : [...all].reverse())
        setChecked(new Set())
        setSelected(null)
        const seqs = all.map((m) => m.seq)
        const min = Math.min(...seqs)
        const max = Math.max(...seqs)
        const { firstSeq, lastSeq } = boundsRef.current
        setMore({
          older: walk === 'desc' ? !exhausted : all.length > 0 && min > firstSeq,
          newer: walk === 'asc' ? !exhausted : all.length > 0 && max < lastSeq
        })
        if (pageNotice) setNotice(pageNotice)
      }

      if (!hasContentFilters(v.filters)) {
        setBusy('loading')
        gateway
          .getMessages(connId, stream, {
            direction: walk,
            start,
            limit: v.pageSize,
            subject: v.subject || undefined
          })
          .then((page) => {
            if (token !== runToken.current) return
            boundsRef.current = { firstSeq: page.firstSeq, lastSeq: page.lastSeq }
            finish(page.messages, page.exhausted, page.notice)
          })
          .catch((err) => {
            if (token !== runToken.current) return
            setBusy(null)
            setLoadedOnce(true)
            setError(err)
          })
        return
      }

      setBusy('scanning')
      setProgress({ scanned: 0, matched: 0 })
      const found: MessageDto[] = []
      let last = { scanned: 0, matched: 0 }
      const close = gateway.open(
        'scan',
        {
          connId,
          stream,
          request: {
            direction: walk,
            start,
            limit: Math.max(1, v.pageSize - base.length),
            subject: v.subject || undefined,
            filters: v.filters,
            scanLimit: v.scanLimit
          }
        },
        (event) => {
          if (token !== runToken.current) return
          if (event.type === 'matches') {
            found.push(...event.messages)
          } else if (event.type === 'progress') {
            last = { scanned: event.scanned, matched: event.matched }
            setProgress(last)
          } else if (event.type === 'done') {
            stopScan.current = null
            if (event.reason === 'error') {
              setBusy(null)
              setLoadedOnce(true)
              setError(event.error ? new GatewayError(event.error) : new Error('The scan failed'))
              return
            }
            setOutcome({
              reason: event.reason,
              scanned: event.scanned,
              matched: event.matched,
              skippedNonJson: event.skippedNonJson,
              resumeSeq: event.resumeSeq,
              walk
            })
            finish(found, event.reason === 'end')
          } else if ((event as { type: string }).type === 'error') {
            setBusy(null)
            setError(new GatewayError((event as unknown as { error: GatewayError }).error))
          }
        }
      )
      stopScan.current = () => {
        close()
        if (token !== runToken.current) return
        // Keep what was found before the user cancelled.
        setOutcome({
          reason: 'cancelled',
          scanned: last.scanned,
          matched: found.length,
          skippedNonJson: 0,
          resumeSeq: null,
          walk
        })
        finish(found, false)
      }
    },
    [gateway, connId, stream]
  )

  const latest = useCallback((v: View) => run('desc', { kind: 'last' }, v), [run])

  // First load, and whenever another part of the app asks for a subject or a sequence (a subject
  // clicked in the Subjects tab, "show the next undelivered message" on a consumer). Answering
  // such a request means both updating the controls and starting a load, so state is set here.
  const applied = useRef<{ subject?: string; seq?: number; done: boolean }>({ done: false })
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const prev = applied.current
    if (prev.done && prev.subject === requestSubject && prev.seq === requestSeq) return
    applied.current = { subject: requestSubject, seq: requestSeq, done: true }
    const next: View = {
      ...view,
      subject: requestSubject ?? (prev.done ? view.subject : ''),
      order: requestSeq !== undefined ? 'asc' : view.order
    }
    if (requestSubject !== undefined) setSubjectDraft(requestSubject)
    setView(next)
    if (requestSeq !== undefined) {
      setStartMode('seq')
      setSeqInput(String(requestSeq))
      run('asc', { kind: 'seq', seq: requestSeq }, next)
    } else {
      setStartMode('latest')
      latest(next)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestSubject, requestSeq])
  /* eslint-enable react-hooks/set-state-in-effect */

  const apply = (patch: Partial<View>): void => {
    const next = { ...view, ...patch }
    setView(next)
    // A change of filters starts again from the chosen start position.
    go(next, startMode)
  }

  const go = (v: View, mode: StartMode): void => {
    // Keep the "Start from" control in step with what is shown, so a later change of filters or
    // page size starts again from the same place.
    setStartMode(mode)
    if (mode === 'latest') {
      const next = { ...v, order: 'desc' as Walk }
      setView(next)
      latest(next)
      return
    }
    // "From here on" reads best oldest first, with the starting message at the top.
    const next = { ...v, order: 'asc' as Walk }
    setView(next)
    if (mode === 'first') run('asc', { kind: 'first' }, next)
    else if (mode === 'seq') {
      if (!/^\d+$/.test(seqInput.trim())) {
        setNotice('Enter a sequence number to start from.')
        return
      }
      run('asc', { kind: 'seq', seq: Number(seqInput) }, next)
    } else {
      const time = new Date(timeInput)
      if (Number.isNaN(time.getTime())) {
        setNotice('Enter a date and time to start from.')
        return
      }
      run('asc', { kind: 'time', time: time.toISOString() }, next)
    }
  }

  const page = (which: 'older' | 'newer'): void => {
    if (messages.length === 0) return
    const seqs = messages.map((m) => m.seq)
    if (which === 'older')
      run('desc', { kind: 'seq', seq: Math.min(...seqs) - 1 }, view, { paging: 'older' })
    else run('asc', { kind: 'seq', seq: Math.max(...seqs) + 1 }, view, { paging: 'newer' })
  }
  // "Next" always moves further in the display order.
  const nextIs: 'older' | 'newer' = view.order === 'desc' ? 'older' : 'newer'
  const previousIs: 'older' | 'newer' = view.order === 'desc' ? 'newer' : 'older'

  const applySubject = (): void => {
    const subject = subjectDraft.trim()
    if (subject && validateSubject(subject)) return
    apply({ subject })
  }
  const subjectError = subjectDraft.trim() ? validateSubject(subjectDraft.trim()) : null

  // ── detail ──
  const selectedIndex = selected === null ? -1 : messages.findIndex((m) => m.seq === selected)
  const selectedRow = selectedIndex >= 0 ? messages[selectedIndex] : null
  const full = useQuery({
    queryKey: ['message', connId, stream, selected, fullBytes ?? 'default'],
    queryFn: () => gateway.getMessage(connId, stream, selected!, fullBytes),
    enabled: selectedRow !== null && (selectedRow.truncated || fullBytes !== undefined),
    staleTime: 60_000
  })
  const detail = full.data && full.data.seq === selected ? full.data : selectedRow
  const select = (seq: number | null): void => {
    setSelected(seq)
    setFullBytes(undefined)
  }

  const chips = filterChips(view.subject, view.filters)
  const readOnly = conn?.readOnly
  const denyDelete = info.config.deny_delete

  const exportSelected = async (format: 'json' | 'ndjson'): Promise<void> => {
    try {
      const out: ExportedMessage[] = []
      for (const m of messages.filter((x) => checked.has(x.seq))) {
        out.push(
          toExported(
            m.truncated ? await gateway.getMessage(connId, stream, m.seq, FULL_PAYLOAD) : m
          )
        )
      }
      saveText(
        `${safeFileName(stream)}-${out.length}-messages.${format}`,
        serializeExport(out, format),
        format === 'json' ? 'application/json' : 'application/x-ndjson'
      )
      toast.ok(`Exported ${out.length} ${out.length === 1 ? 'message' : 'messages'}`)
    } catch (err) {
      toast.error(err)
    }
  }

  const copyNatsPub = async (): Promise<void> => {
    if (!detail) return
    try {
      const message = detail.truncated
        ? await gateway.getMessage(connId, stream, detail.seq, FULL_PAYLOAD)
        : detail
      const command = natsPubCommand(message)
      if (!command) {
        toast.error('This payload is binary, so it cannot be written as a "nats pub" command.')
        return
      }
      await navigator.clipboard.writeText(command)
      toast.ok('Copied a "nats pub" command for this message')
    } catch (err) {
      toast.error(err)
    }
  }

  const exportSaved = (): void => {
    if (listsBlocked) {
      toast.error(`Nothing was exported. ${listsBlocked}.`)
      return
    }
    saveText(
      `saved-filters-${safeFileName(conn?.name ?? connId)}.json`,
      serializeSavedExport(buildSavedExport(saved, favorites))
    )
    toast.ok(`Exported ${describeSaved(saved.length, favorites.length)}`)
  }

  const importSaved = async (): Promise<void> => {
    try {
      const file = await pickFile('.json,application/json')
      if (!file) return
      if (file.size > MAX_SAVED_IMPORT_BYTES)
        throw new Error('This file is too large to be an export of saved filters and favourites.')
      const imported = parseSavedExport(await file.text())
      const current = latestSaved.current
      if (current.blocked) throw new Error(`Nothing was imported. ${current.blocked}.`)
      const merged = mergeSavedExport(
        { savedFilters: current.saved, favorites: current.favorites },
        imported
      )
      if (!merged.importedFilters && !merged.importedFavorites) {
        toast.info('Nothing to import. The file has no saved filters and no new favourites.')
        return
      }
      // One write per list, one after the other. A write that fails reports its own error and
      // shows again what is stored, and the import stops there, so success is only announced
      // when everything the file brought has really been stored.
      if (merged.importedFilters && !(await setSaved(merged.savedFilters))) return
      if (merged.importedFavorites && !(await setFavorites(merged.favorites))) {
        if (merged.importedFilters)
          toast.info(
            `Only part of the file was imported: ${describeSaved(merged.importedFilters, 0)}. ` +
              'Its favourites were not.'
          )
        return
      }
      toast.ok(describeImport(merged))
    } catch (err) {
      toast.error(err)
    }
  }

  // The sidebar shrinks to its icon rail while the detail panel is open (PBI-115). The request is
  // released when the panel closes and when the browser unmounts.
  const detailOpen = Boolean(detail) && visible && tabActive
  useEffect(() => {
    if (!detailOpen) return
    requestRail('messages', true)
    return () => requestRail('messages', false)
  }, [detailOpen])
  const [storedWidth, setStoredWidth] = useSetting<number>(
    'messages.detailWidth',
    DETAIL_DEFAULT_WIDTH
  )
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const detailWidth = dragWidth ?? storedWidth
  const setDetailWidth = setDragWidth
  const saveDetailWidth = (w: number): void => {
    void setStoredWidth(w)
    setDragWidth(null)
  }

  const tableBox = useRef<HTMLDivElement>(null)
  const toggleChecked = useCallback((seq: number): void => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(seq)) next.delete(seq)
      else next.add(seq)
      return next
    })
  }, [])

  const columns: Column<MessageDto>[] = useMemo(
    () => [
      {
        id: 'check',
        header: (
          <input
            type="checkbox"
            aria-label="Select all messages on this page"
            className="accent-[var(--accent)]"
            checked={messages.length > 0 && checked.size === messages.length}
            onChange={(e) =>
              setChecked(e.target.checked ? new Set(messages.map((m) => m.seq)) : new Set())
            }
          />
        ),
        width: '32px',
        cell: (m) => (
          <input
            type="checkbox"
            aria-label={`Select message ${m.seq}`}
            className="accent-[var(--accent)]"
            checked={checked.has(m.seq)}
            // The table has one tab stop; Space on the table ticks the highlighted row.
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
            onChange={() => toggleChecked(m.seq)}
          />
        )
      },
      { id: 'seq', header: 'Seq', width: '72px', align: 'right', cell: (m) => m.seq },
      {
        id: 'subject',
        header: 'Subject',
        width: 'minmax(140px, 1fr)',
        mono: true,
        title: (m) => m.subject,
        cell: (m) => m.subject
      },
      {
        id: 'preview',
        header: 'Payload',
        width: 'minmax(160px, 2fr)',
        mono: true,
        cell: (m) => <span className="text-muted">{payloadPreview(m.payload, m.size)}</span>
      },
      {
        id: 'time',
        header: 'Time',
        width: '170px',
        title: (m) => `${m.time} UTC`,
        cell: (m) => <span className="tabular">{formatTime(m.time)}</span>
      },
      {
        id: 'size',
        header: 'Size',
        width: '76px',
        align: 'right',
        cell: (m) => formatBytes(m.size)
      }
    ],
    [messages, checked, toggleChecked]
  )

  const savedItems: MenuItem[] = [
    ...saved.map((s) => ({
      label: s.name,
      // The whole name first: the menu cuts a long one short.
      title: [s.name, ...filterChips(s.subject, s.filters).map((c) => c.label)].join('\n'),
      onSelect: () => {
        setSubjectDraft(s.subject)
        apply({ subject: s.subject, filters: s.filters })
      }
    })),
    {
      label: 'Save current filters...',
      disabled: !!savedBlocked || chips.length === 0,
      title: savedBlocked ?? (chips.length === 0 ? 'Set a subject or a filter first' : undefined),
      onSelect: () => setDialog('saveFilter')
    },
    {
      label: 'Export filters and favourites...',
      disabled: !!listsBlocked || (saved.length === 0 && favorites.length === 0),
      title:
        listsBlocked ??
        (saved.length === 0 && favorites.length === 0
          ? 'There are no saved filters or favourites to export'
          : undefined),
      onSelect: exportSaved
    },
    {
      label: 'Import filters and favourites...',
      disabled: !!listsBlocked,
      title: listsBlocked ?? undefined,
      onSelect: () => void importSaved()
    },
    ...(saved.length
      ? [{ label: 'Remove all saved filters', danger: true, onSelect: () => setSaved([]) }]
      : [])
  ]

  const emptyText =
    outcome && outcome.matched === 0 && outcome.reason === 'end'
      ? `No messages match these filters. ${formatCount(outcome.scanned)} messages were examined.`
      : outcome && outcome.matched === 0 && outcome.reason === 'limit'
        ? 'No matches yet. The scan limit was reached before the end of the stream.'
        : chips.length
          ? 'No messages match these filters.'
          : 'This stream has no messages.'

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Filters and start position */}
      <div className="flex shrink-0 flex-wrap items-end gap-2 border-b border-line bg-panel px-4 py-2">
        <form
          className="flex items-end gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            applySubject()
          }}
        >
          <Field label="Subject filter" error={subjectError} className="w-72">
            {(id) => (
              <Input
                id={id}
                mono
                placeholder="orders.*.created or orders.>"
                invalid={!!subjectError}
                value={subjectDraft}
                onChange={(e) => setSubjectDraft(e.target.value)}
              />
            )}
          </Field>
          <Button type="submit" disabled={!!subjectError || subjectDraft.trim() === view.subject}>
            Apply
          </Button>
        </form>
        <Button
          icon={<Filter className="h-3.5 w-3.5" aria-hidden />}
          aria-expanded={panelOpen}
          onClick={() => setPanelOpen((v) => !v)}
        >
          Filters
          {hasContentFilters(view.filters) ? ` (${chips.length - (view.subject ? 1 : 0)})` : ''}
        </Button>
        <Menu
          items={savedItems}
          trigger={(props) => (
            <Button icon={<Bookmark className="h-3.5 w-3.5" aria-hidden />} {...props}>
              Saved
            </Button>
          )}
        />

        <div className="ml-auto flex items-end gap-1.5">
          <Field label="Start from" className="w-44">
            {(id) => (
              <Select
                id={id}
                value={startMode}
                onChange={(e) => setStartMode(e.target.value as StartMode)}
              >
                <option value="latest">Latest messages</option>
                <option value="first">First message</option>
                <option value="seq">Sequence...</option>
                <option value="time">Date and time...</option>
              </Select>
            )}
          </Field>
          {startMode === 'seq' && (
            <Field label="Sequence" className="w-28">
              {(id) => (
                <Input
                  id={id}
                  inputMode="numeric"
                  placeholder={`${info.state.first_seq}`}
                  value={seqInput}
                  onChange={(e) => setSeqInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && go(view, 'seq')}
                />
              )}
            </Field>
          )}
          {startMode === 'time' && (
            <Field
              label={`Local time (${Number.isNaN(new Date(timeInput).getTime()) ? 'invalid' : new Date(timeInput).toISOString().slice(0, 19) + ' UTC'})`}
              className="w-60"
            >
              {(id) => (
                <Input
                  id={id}
                  type="datetime-local"
                  step={1}
                  value={timeInput}
                  onChange={(e) => setTimeInput(e.target.value)}
                />
              )}
            </Field>
          )}
          <Button onClick={() => go(view, startMode)}>Go</Button>
          <Field label="Page size" className="w-20">
            {(id) => (
              <Select
                id={id}
                value={view.pageSize}
                onChange={(e) => apply({ pageSize: Number(e.target.value) })}
              >
                {[25, 50, 100, 250, 500].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      </div>

      {panelOpen && (
        <FilterPanel
          key={JSON.stringify(view.filters) + view.scanLimit}
          initial={draftFrom(view.filters, view.scanLimit)}
          onClose={() => setPanelOpen(false)}
          onApply={(filters, scanLimit) => apply({ filters, scanLimit })}
        />
      )}

      {chips.length > 0 && (
        <div
          className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line bg-panel px-4 py-1.5"
          aria-label="Active filters"
        >
          {chips.map((chip) => (
            <span
              key={chip.id}
              className="inline-flex h-6 max-w-96 items-center gap-1 rounded-full border border-line bg-raised pr-1 pl-2.5 text-xs"
            >
              <span className="truncate">{chip.label}</span>
              <button
                aria-label={`Remove filter: ${chip.label}`}
                className="flex h-4 w-4 items-center justify-center rounded-full text-faint hover:bg-hover hover:text-fg"
                onClick={() => {
                  const next = removeChip(chip.id, view.subject, view.filters)
                  setSubjectDraft(next.subject)
                  apply(next)
                }}
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Paging and actions */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line bg-panel px-4 py-1.5">
        <Button
          size="sm"
          icon={<ChevronsUp className="h-3.5 w-3.5" aria-hidden />}
          onClick={() => go(view, 'latest')}
          title="Jump to the latest messages"
        >
          Latest
        </Button>
        <Button
          size="sm"
          icon={<ChevronLeft className="h-3.5 w-3.5" aria-hidden />}
          disabled={!more[previousIs] || busy !== null}
          title={`Previous page (${previousIs} messages)`}
          onClick={() => page(previousIs)}
        >
          Previous
        </Button>
        <Button
          size="sm"
          disabled={!more[nextIs] || busy !== null}
          title={`Next page (${nextIs} messages)`}
          onClick={() => page(nextIs)}
        >
          Next
          <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon={<RefreshCw className="h-3.5 w-3.5" aria-hidden />}
          title="Load this view again"
          aria-label="Reload view"
          onClick={() => go(view, startMode)}
        />
        <Select
          className="!h-6 w-36 !text-xs"
          aria-label="Display order"
          value={view.order}
          onChange={(e) => {
            const order = e.target.value as Walk
            const next = { ...view, order }
            setView(next)
            // Re-display what is loaded; the next page continues in the new order.
            const w = walked.current
            setMessages(w.walk === order ? w.messages : [...w.messages].reverse())
          }}
        >
          <option value="desc">Newest first</option>
          <option value="asc">Oldest first</option>
        </Select>

        <span className="tabular ml-2 text-xs text-muted" role="status" data-testid="message-range">
          {busy === 'loading'
            ? 'Loading...'
            : busy === 'scanning'
              ? `Scanning: ${formatCount(progress.scanned)} examined, ${formatCount(progress.matched)} ${progress.matched === 1 ? 'match' : 'matches'}`
              : messages.length
                ? `${messages.length} ${messages.length === 1 ? 'message' : 'messages'}, #${Math.min(...messages.map((m) => m.seq))} to #${Math.max(...messages.map((m) => m.seq))}`
                : ''}
        </span>
        {busy === 'scanning' && (
          <Button size="sm" onClick={() => stopScan.current?.()}>
            Cancel scan
          </Button>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          {checked.size > 0 && (
            <>
              <span className="text-xs text-muted">{checked.size} selected</span>
              <Button
                size="sm"
                icon={<Download className="h-3.5 w-3.5" aria-hidden />}
                onClick={() => void exportSelected('json')}
              >
                JSON
              </Button>
              <Button
                size="sm"
                icon={<Download className="h-3.5 w-3.5" aria-hidden />}
                onClick={() => void exportSelected('ndjson')}
              >
                NDJSON
              </Button>
              <Button
                size="sm"
                icon={<Repeat className="h-3.5 w-3.5" aria-hidden />}
                {...readOnlyProps(readOnly)}
                onClick={() => setDialog('republishMany')}
              >
                Republish
              </Button>
            </>
          )}
          <Button
            size="sm"
            icon={<Download className="h-3.5 w-3.5" aria-hidden />}
            onClick={() => setDialog('exportAll')}
          >
            Export all matching
          </Button>
        </div>
      </div>

      {(notice ||
        error ||
        (outcome &&
          (outcome.reason === 'limit' ||
            outcome.reason === 'cancelled' ||
            outcome.skippedNonJson > 0))) && (
        <div className="flex shrink-0 flex-col gap-1.5 bg-panel px-4 py-2">
          {notice && <Notice tone="accent">{notice}</Notice>}
          <ErrorNote error={error} onRetry={() => go(view, startMode)} />
          {outcome?.reason === 'limit' && (
            <Notice tone="warn" className="flex items-center gap-2">
              <span className="mr-auto">
                Scan limit reached: {formatCount(outcome.scanned)} messages examined,{' '}
                {formatCount(outcome.matched)} {outcome.matched === 1 ? 'match' : 'matches'}. There
                may be more further on.
              </span>
              {outcome.resumeSeq !== null && (
                <Button
                  size="sm"
                  onClick={() =>
                    run(outcome.walk, { kind: 'seq', seq: outcome.resumeSeq! }, view, {
                      base: walked.current.walk === outcome.walk ? walked.current.messages : []
                    })
                  }
                >
                  Continue scanning
                </Button>
              )}
            </Notice>
          )}
          {outcome?.reason === 'cancelled' && (
            <Notice>
              Scan cancelled after {formatCount(outcome.scanned)} messages. Showing the{' '}
              {formatCount(outcome.matched)} matches found so far.
            </Notice>
          )}
          {outcome && outcome.skippedNonJson > 0 && (
            <Notice>
              {formatCount(outcome.skippedNonJson)}{' '}
              {outcome.skippedNonJson === 1 ? 'payload was' : 'payloads were'} not JSON and{' '}
              {outcome.skippedNonJson === 1 ? 'was' : 'were'} skipped by the JSONPath filter.
            </Notice>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div
          ref={tableBox}
          className="min-w-0 flex-1 bg-panel"
          onKeyDown={(e) => {
            // Keyboard counterparts of the mouse: Esc closes the panel, Space ticks the row.
            if (e.target !== e.currentTarget.querySelector('[role=table]')) return
            if (e.key === 'Escape' && selected !== null) {
              e.preventDefault()
              select(null)
            } else if (e.key === ' ' && selected !== null) {
              e.preventDefault()
              toggleChecked(selected)
            }
          }}
        >
          {messages.length === 0 && loadedOnce && !busy && !error ? (
            <EmptyState title={emptyText} />
          ) : (
            <DataTable
              ariaLabel={`Messages in ${stream}`}
              storageKey="Messages"
              rows={messages}
              columns={columns}
              rowKey={(m) => m.seq}
              selectedKey={selected}
              onSelect={(m) => select(m.seq)}
              onOpen={(m) => select(m.seq)}
              empty={busy ? 'Loading...' : ''}
            />
          )}
        </div>
        {detail && (
          <ResizableDetail width={detailWidth} onWidth={setDetailWidth} onCommit={saveDetailWidth}>
            <MessageDetail
              message={detail}
              decoders={decoders}
              onClose={() => {
                select(null)
                // The panel (and the focus in it) goes away; keep the keyboard in the table.
                tableBox.current?.querySelector<HTMLElement>('[role=table]')?.focus()
              }}
              onPrevious={
                selectedIndex > 0 ? () => select(messages[selectedIndex - 1].seq) : undefined
              }
              onNext={
                selectedIndex < messages.length - 1
                  ? () => select(messages[selectedIndex + 1].seq)
                  : undefined
              }
              onLoadFull={
                detail.truncated ? () => setFullBytes(Math.max(detail.size, 1)) : undefined
              }
              loadingFull={full.isFetching}
              actions={
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    title='Copy as a "nats pub" command'
                    aria-label='Copy as a "nats pub" command'
                    icon={<Terminal className="h-4 w-4" aria-hidden />}
                    onClick={() => void copyNatsPub()}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="Republish message"
                    icon={<Repeat className="h-4 w-4" aria-hidden />}
                    {...(readOnly ? readOnlyProps(true) : { title: 'Republish message' })}
                    onClick={() => setDialog('republishOne')}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="Delete message"
                    icon={<Trash2 className="h-4 w-4" aria-hidden />}
                    {...(denyDelete
                      ? {
                          disabled: true,
                          title: 'This stream does not allow deleting messages (deny_delete)'
                        }
                      : readOnly
                        ? readOnlyProps(true)
                        : { title: 'Delete message' })}
                    onClick={() => setDialog('delete')}
                  />
                </>
              }
            />
          </ResizableDetail>
        )}
      </div>

      {dialog === 'delete' && detail && (
        <DeleteMessageDialog
          connId={connId}
          stream={stream}
          message={detail}
          onClose={() => setDialog(null)}
          onDeleted={() => {
            setMessages((list) => list.filter((m) => m.seq !== detail.seq))
            walked.current = {
              ...walked.current,
              messages: walked.current.messages.filter((m) => m.seq !== detail.seq)
            }
            select(null)
          }}
        />
      )}
      {dialog === 'republishOne' && detail && (
        <RepublishDialog
          connId={connId}
          info={info}
          messages={[detail]}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'republishMany' && (
        <RepublishDialog
          connId={connId}
          info={info}
          messages={messages.filter((m) => checked.has(m.seq))}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'exportAll' && (
        <ExportAllDialog
          connId={connId}
          stream={stream}
          subject={view.subject}
          filters={view.filters}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'saveFilter' && (
        <SaveFilterDialog
          existing={saved.map((s) => s.name)}
          onClose={() => setDialog(null)}
          onSave={(name) => {
            void setSaved([
              ...saved.filter((s) => s.name !== name),
              { name, subject: view.subject, filters: view.filters }
            ]).then((stored) => {
              if (stored) toast.ok(`Saved filter "${name}"`)
            })
          }}
        />
      )}
    </div>
  )
}

function SaveFilterDialog({
  existing,
  onSave,
  onClose
}: {
  existing: string[]
  onSave: (name: string) => void
  onClose: () => void
}): ReactNode {
  const [name, setName] = useState('')
  const trimmed = name.trim()
  const replaces = existing.includes(trimmed)
  // The same limits as for an imported file, so that an export can always be imported again.
  const full = !replaces && existing.length >= MAX_SAVED_FILTERS
  const submit = (): void => {
    if (!trimmed || full) return
    onSave(trimmed)
    onClose()
  }
  return (
    <Dialog
      title="Save filters"
      onClose={onClose}
      width={400}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!trimmed || full} onClick={submit}>
            {replaces ? 'Replace' : 'Save'}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <Field
          label="Name"
          error={
            full
              ? `This connection already has ${formatCount(MAX_SAVED_FILTERS)} saved filters, which is the most it can have. Remove one, or use the name of one to replace it.`
              : null
          }
          hint={
            replaces
              ? 'A saved filter with this name exists and will be replaced.'
              : 'Saved for this connection and available on every stream.'
          }
        >
          {(id) => (
            <Input
              id={id}
              autoFocus
              maxLength={MAX_SAVED_FILTER_NAME}
              value={name}
              invalid={full}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
      </form>
    </Dialog>
  )
}
