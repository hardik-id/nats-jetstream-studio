import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CopyPlus, Eraser, Pause, Play, Square } from 'lucide-react'
import { GatewayError, isProduction, type TailMessage } from '@shared/api'
import { formatBytes, formatCount, formatRate, formatTime } from '@shared/format'
import { validateSubject } from '@shared/subject'
import { DataTable, type Column } from '../../components/DataTable'
import { MessageDetail } from '../../components/MessageDetail'
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Notice,
  Page,
  Select
} from '../../components/ui'
import { useGateway } from '../../gateway'
import { useDecoders } from '../../lib/decoders'
import { useConnection } from '../../lib/hooks'
import { payloadPreview } from '../../lib/messages'
import { useSeenSubjects } from '../../state/seenSubjects'
import { useTabs } from '../../state/tabs'

/** A row is a message, or a marker where the connection dropped and messages may be missing. */
type Row = (TailMessage & { gap?: false }) | { id: number; gap: true; received: number }

const FLUSH_MS = 200

/**
 * Live view of a subject (PBI-060). Messages arrive from the gateway in batches; the list keeps
 * the newest N and says how many it had to drop.
 */
export function TailTab({
  tabId,
  connId,
  subject: initialSubject
}: {
  tabId: string
  connId: string
  subject?: string
}): ReactNode {
  const gateway = useGateway()
  const conn = useConnection(connId)
  const decoders = useDecoders(connId)
  const tabs = useTabs()
  const recordSeen = useSeenSubjects((s) => s.record)

  const [input, setInput] = useState(initialSubject ?? '')
  // A restored tab picks up where it was. Subscribing to everything is never started unasked.
  const [running, setRunning] = useState<string | null>(() =>
    initialSubject && initialSubject !== '>' && !validateSubject(initialSubject)
      ? initialSubject
      : null
  )
  // True once the gateway reports that the server has the subscription. Until then a message
  // published elsewhere can still be missed, so the page does not yet claim to be listening.
  const [listening, setListening] = useState(false)
  const [paused, setPaused] = useState(false)
  const [rows, setRows] = useState<Row[]>([])
  const [waiting, setWaiting] = useState(0)
  const [dropped, setDropped] = useState(0)
  const [received, setReceived] = useState(0)
  const [rate, setRate] = useState(0)
  const [error, setError] = useState<unknown>(null)
  const [limit, setLimit] = useState(10_000)
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<number | null>(null)
  const [confirmAll, setConfirmAll] = useState(false)

  const buffer = useRef<Row[]>([])
  const dirty = useRef(false)
  const pausedRef = useRef(false)
  const limitRef = useRef(limit)
  const counters = useRef({
    received: 0,
    dropped: 0,
    window: [] as { t: number; n: number }[],
    seen: new Map<string, number>(),
    gapId: -1
  })

  const trim = (): void => {
    const over = buffer.current.length - limitRef.current
    if (over > 0) {
      buffer.current.splice(0, over)
      counters.current.dropped += over
    }
  }

  const start = (subject: string): void => {
    setError(null)
    setPaused(false)
    pausedRef.current = false
    tabs.patch(tabId, { subject })
    setListening(false)
    setRunning(subject)
  }
  const halt = (): void => {
    setListening(false)
    setRunning(null)
  }

  // The subscription lives exactly as long as `running` names a subject.
  useEffect(() => {
    if (!running) return
    return gateway.open('tail', { connId, subject: running }, (event) => {
      const c = counters.current
      if (event.type === 'ready') {
        setListening(true)
      } else if (event.type === 'messages') {
        for (const m of event.messages) {
          buffer.current.push(m)
          c.seen.set(m.subject, (c.seen.get(m.subject) ?? 0) + 1)
        }
        // "Received" counts every message the subscription got, including any the gateway had
        // to drop from a burst before it reached this window.
        c.received += event.messages.length + event.dropped
        c.dropped += event.dropped
        c.window.push({ t: Date.now(), n: event.messages.length + event.dropped })
        const over = buffer.current.length - limitRef.current
        if (over > 0) {
          buffer.current.splice(0, over)
          c.dropped += over
        }
        dirty.current = true
      } else if (event.type === 'gap') {
        buffer.current.push({ id: c.gapId--, gap: true, received: Date.now() })
        dirty.current = true
      } else if (event.type === 'error') {
        setError(new GatewayError(event.error))
        setListening(false)
        setRunning(null)
      }
    })
  }, [running, gateway, connId])

  // Repaint a few times a second, however fast messages arrive.
  useEffect(() => {
    const timer = setInterval(() => {
      const c = counters.current
      const now = Date.now()
      c.window = c.window.filter((w) => now - w.t <= 2000)
      setRate(c.window.reduce((sum, w) => sum + w.n, 0) / 2)
      setReceived(c.received)
      setDropped(c.dropped)
      if (c.seen.size) {
        recordSeen(connId, c.seen)
        c.seen = new Map()
      }
      if (pausedRef.current) {
        setWaiting(buffer.current.length)
        return
      }
      if (dirty.current) {
        dirty.current = false
        setRows([...buffer.current])
      }
    }, FLUSH_MS)
    return () => clearInterval(timer)
  }, [connId, recordSeen])

  const isProd = isProduction(conn?.envLabel)
  const tryStart = (): void => {
    const subject = input.trim()
    if (validateSubject(subject)) return
    if (subject === '>' && isProd) setConfirmAll(true)
    else start(subject)
  }

  // A restored tab picks up where it was, except for "everything" on production.
  const clear = (): void => {
    buffer.current = []
    counters.current.received = 0
    counters.current.dropped = 0
    dirty.current = false
    setRows([])
    setWaiting(0)
    setSelected(null)
  }

  const togglePause = (): void => {
    const next = !paused
    pausedRef.current = next
    setPaused(next)
    if (!next) {
      dirty.current = false
      setRows([...buffer.current])
    } else {
      setWaiting(buffer.current.length)
    }
  }

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(
      (r) =>
        r.gap ||
        r.subject.toLowerCase().includes(q) ||
        payloadPreview(r.payload, r.size, 2000).toLowerCase().includes(q)
    )
  }, [rows, filter])

  const selectedIndex = selected === null ? -1 : visible.findIndex((r) => r.id === selected)
  const detail =
    selectedIndex >= 0 && !visible[selectedIndex].gap
      ? (visible[selectedIndex] as TailMessage)
      : null
  const step = (delta: number): (() => void) | undefined => {
    for (let i = selectedIndex + delta; i >= 0 && i < visible.length; i += delta) {
      if (!visible[i].gap) return () => setSelected(visible[i].id)
    }
    return undefined
  }

  const columns: Column<Row>[] = [
    {
      id: 'time',
      header: 'Received',
      width: '112px',
      cell: (r) => <span className="tabular">{formatTime(r.received).slice(11)}</span>
    },
    {
      id: 'subject',
      header: 'Subject',
      width: 'minmax(180px, 1.2fr)',
      mono: true,
      title: (r) => (r.gap ? undefined : r.subject),
      cell: (r) =>
        r.gap ? (
          <span className="font-sans text-warn">
            Connection was lost here. Messages published meanwhile were not received.
          </span>
        ) : (
          r.subject
        )
    },
    {
      id: 'size',
      header: 'Size',
      width: '84px',
      align: 'right',
      cell: (r) => (r.gap ? '' : formatBytes(r.size))
    },
    {
      id: 'payload',
      header: 'Payload',
      width: 'minmax(220px, 3fr)',
      mono: true,
      cell: (r) =>
        r.gap ? '' : <span className="text-muted">{payloadPreview(r.payload, r.size)}</span>
    }
  ]

  const subjectError = input.trim() ? validateSubject(input.trim()) : null

  return (
    <Page
      scroll={false}
      title="Live tail"
      subtitle={
        running
          ? `${listening ? 'Subscribed' : 'Subscribing'} to ${running}`
          : 'Watch messages on a subject as they arrive'
      }
      actions={
        <Button
          icon={<CopyPlus className="h-3.5 w-3.5" aria-hidden />}
          onClick={() => tabs.openNew('tail', connId)}
        >
          New tail
        </Button>
      }
    >
      <div className="flex shrink-0 flex-wrap items-end gap-2 border-b border-line bg-panel px-4 py-2">
        <form
          className="flex items-end gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            tryStart()
          }}
        >
          <Field label="Subject" error={subjectError} className="w-80">
            {(id) => (
              <Input
                id={id}
                mono
                autoFocus={!initialSubject}
                placeholder="orders.> or orders.*.created"
                invalid={!!subjectError}
                disabled={running !== null}
                value={input}
                onChange={(e) => setInput(e.target.value)}
              />
            )}
          </Field>
          {/* Separate keys: if React reused one element, Stop would become the submit button while
              its own click is still being handled, and the form would start the tail again. */}
          {running === null ? (
            <Button
              key="start"
              type="submit"
              variant="primary"
              icon={<Play className="h-3.5 w-3.5" aria-hidden />}
              disabled={!input.trim() || !!subjectError}
            >
              Start
            </Button>
          ) : (
            <Button key="stop" icon={<Square className="h-3.5 w-3.5" aria-hidden />} onClick={halt}>
              Stop
            </Button>
          )}
        </form>
        <Button
          icon={
            paused ? (
              <Play className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <Pause className="h-3.5 w-3.5" aria-hidden />
            )
          }
          disabled={running === null}
          aria-pressed={paused}
          onClick={togglePause}
        >
          {paused ? 'Resume' : 'Pause'}
        </Button>
        <Button
          icon={<Eraser className="h-3.5 w-3.5" aria-hidden />}
          disabled={rows.length === 0 && waiting === 0}
          onClick={clear}
        >
          Clear
        </Button>
        <Field label="Find in list" className="w-56">
          {(id) => (
            <Input
              id={id}
              type="search"
              placeholder="Subject or payload text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          )}
        </Field>
        <Field label="Keep newest" className="w-28">
          {(id) => (
            <Select
              id={id}
              value={limit}
              onChange={(e) => {
                const next = Number(e.target.value)
                limitRef.current = next
                setLimit(next)
                trim()
                dirty.current = true
              }}
            >
              {[1000, 10_000, 50_000].map((n) => (
                <option key={n} value={n}>
                  {formatCount(n)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <dl className="ml-auto flex items-end gap-5 text-right" aria-live="off">
          <div>
            <dt className="text-xs text-muted">Rate</dt>
            <dd className="tabular font-semibold" data-testid="tail-rate">
              {running ? formatRate(rate) : '-'}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Received</dt>
            <dd className="tabular font-semibold" data-testid="tail-received">
              {formatCount(received)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Dropped</dt>
            <dd
              className={`tabular font-semibold ${dropped > 0 ? 'text-warn' : ''}`}
              data-testid="tail-dropped"
              title="Older messages removed to keep the list within its limit"
            >
              {formatCount(dropped)}
            </dd>
          </div>
        </dl>
      </div>

      {(error != null || paused) && (
        <div className="flex shrink-0 flex-col gap-1.5 bg-panel px-4 py-2">
          <ErrorNote error={error} />
          {paused && (
            <Notice tone="accent" className="flex items-center gap-2">
              <span className="mr-auto">
                Paused. The list is frozen; {formatCount(Math.max(0, waiting - rows.length))} newer{' '}
                {waiting - rows.length === 1 ? 'message is' : 'messages are'} waiting.
              </span>
              <Button size="sm" onClick={togglePause}>
                Resume
              </Button>
            </Notice>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 bg-panel">
          {rows.length === 0 ? (
            <EmptyState
              title={
                running
                  ? listening
                    ? `Waiting for messages on ${running}`
                    : `Subscribing to ${running}`
                  : 'Enter a subject and press Start'
              }
            >
              {!running && (
                <p>
                  Wildcards work: <span className="font-mono">*</span> matches one token,{' '}
                  <span className="font-mono">&gt;</span> matches everything after it.
                </p>
              )}
            </EmptyState>
          ) : (
            <DataTable
              ariaLabel="Live messages"
              rows={visible}
              columns={columns}
              rowKey={(r) => r.id}
              selectedKey={selected}
              onSelect={(r) => !r.gap && setSelected(r.id)}
              stickToBottom={!paused && selected === null}
              rowClassName={(r) => (r.gap ? 'bg-warn-soft' : undefined)}
              empty="No messages in the list match"
            />
          )}
        </div>
        {detail && (
          <div className="w-[46%] max-w-[760px] min-w-[380px] shrink-0">
            <MessageDetail
              message={{
                subject: detail.subject,
                time: detail.received,
                size: detail.size,
                headers: detail.headers,
                payload: detail.payload,
                truncated: detail.truncated,
                reply: detail.reply
              }}
              decoders={decoders}
              onClose={() => setSelected(null)}
              onPrevious={step(-1)}
              onNext={step(1)}
            />
          </div>
        )}
      </div>

      {confirmAll && (
        <ConfirmDialog
          title="Subscribe to every subject on production?"
          confirmLabel="Subscribe to >"
          danger={false}
          onClose={() => setConfirmAll(false)}
          onConfirm={() => start('>')}
        >
          <strong>{conn?.name}</strong> is a production connection. Subscribing to{' '}
          <span className="font-mono">&gt;</span> makes the server send this studio a copy of every
          message the user may read, which can be a lot of traffic. A narrower subject is usually
          enough.
        </ConfirmDialog>
      )}
    </Page>
  )
}
