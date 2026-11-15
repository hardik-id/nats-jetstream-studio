import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  GatewayError,
  type ContentFilters,
  type Header,
  type MessageDto,
  type StreamInfoDto
} from '@shared/api'
import { fromBase64, textToBase64, tryDecodeText } from '@shared/encoding'
import { formatCount } from '@shared/format'
import { subjectMatches, validateSubject } from '@shared/subject'
import { HeadersEditor } from '../../components/HeadersEditor'
import {
  Button,
  Checkbox,
  ConfirmDialog,
  Dialog,
  ErrorNote,
  Field,
  Input,
  Notice,
  Select,
  TextArea
} from '../../components/ui'
import { useGateway } from '../../gateway'
import { safeFileName, saveText } from '../../lib/files'
import { serializeExport, toExported, type ExportedMessage } from '../../lib/messages'
import { toast } from '../../state/toasts'

const FULL_PAYLOAD = 64 * 1024 * 1024

/** Deletes one message after a confirmation that names it (PBI-046). */
export function DeleteMessageDialog({
  connId,
  stream,
  message,
  onDeleted,
  onClose
}: {
  connId: string
  stream: string
  message: MessageDto
  onDeleted: () => void
  onClose: () => void
}): ReactNode {
  const gateway = useGateway()
  const [erase, setErase] = useState(true)
  return (
    <ConfirmDialog
      title={`Delete message #${message.seq}`}
      confirmLabel="Delete message"
      onClose={onClose}
      onConfirm={async () => {
        await gateway.deleteMessage(connId, stream, message.seq, erase)
        toast.ok(`Deleted message #${message.seq} from ${stream}`)
        onDeleted()
      }}
    >
      <div className="flex flex-col gap-3">
        <p>
          This removes message <strong>#{message.seq}</strong> on subject{' '}
          <span className="font-mono">{message.subject}</span> from stream{' '}
          <span className="font-mono">{stream}</span>. It cannot be undone.
        </p>
        <Checkbox
          label="Securely erase the data"
          hint="Overwrites the message on disk. Without it the message is only marked as deleted, which is faster."
          checked={erase}
          onChange={(e) => setErase(e.target.checked)}
        />
      </div>
    </ConfirmDialog>
  )
}

/**
 * Sends stored messages again (PBI-047). One message can be edited before sending; several are
 * sent as they are, at a limited rate.
 */
export function RepublishDialog({
  connId,
  info,
  messages,
  onClose
}: {
  connId: string
  info: StreamInfoDto
  messages: MessageDto[]
  onClose: () => void
}): ReactNode {
  const gateway = useGateway()
  const stream = info.config.name
  const single = messages.length === 1 ? messages[0] : null
  const [loaded, setLoaded] = useState<MessageDto | null>(
    single && !single.truncated ? single : null
  )
  const [subject, setSubject] = useState(single?.subject ?? '')
  const [headers, setHeaders] = useState<Header[]>(single?.headers ?? [])
  // null until the user edits; until then the field shows the loaded payload.
  const [edited, setPayload] = useState<string | null>(null)
  const [mode, setMode] = useState<'core' | 'jetstream'>('jetstream')
  const [rate, setRate] = useState('10')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<unknown>(null)
  const cancelled = useRef(false)

  // A single message is loaded in full before it can be edited.
  useEffect(() => {
    if (!single || loaded) return
    let alive = true
    gateway
      .getMessage(connId, stream, single.seq, FULL_PAYLOAD)
      .then((m) => alive && setLoaded(m))
      .catch((err) => alive && setError(err))
    return () => {
      alive = false
    }
  }, [single, loaded, gateway, connId, stream])

  const text = loaded ? tryDecodeText(fromBase64(loaded.payload)) : null
  const payload = edited ?? text ?? ''

  const target = subject.trim()
  const subjectError =
    single || target ? (target ? validateSubject(target, false) : 'Subject is required') : null
  const captures = (s: string): boolean =>
    (info.config.subjects ?? []).some((pattern) => subjectMatches(pattern, s))
  const duplicates = target ? captures(target) : messages.some((m) => captures(m.subject))
  const rateNumber = Number(rate)
  const rateError =
    !single && !(rateNumber > 0 && rateNumber <= 10_000)
      ? 'Enter messages per second, 1 to 10,000'
      : null

  const send = async (): Promise<void> => {
    if (subjectError || rateError) return
    setBusy(true)
    setError(null)
    cancelled.current = false
    try {
      if (single) {
        if (!loaded) return
        await gateway.publish(connId, {
          subject: target,
          headers,
          payload: text !== null ? textToBase64(payload) : loaded.payload,
          mode
        })
        toast.ok(`Republished message #${single.seq} to ${target}`)
      } else {
        let sent = 0
        for (const m of messages) {
          if (cancelled.current) break
          const started = Date.now()
          const full = m.truncated
            ? await gateway.getMessage(connId, stream, m.seq, FULL_PAYLOAD)
            : m
          await gateway.publish(connId, {
            subject: target || full.subject,
            headers: full.headers,
            payload: full.payload,
            mode
          })
          setProgress(++sent)
          const wait = 1000 / rateNumber - (Date.now() - started)
          if (wait > 0) await new Promise((r) => setTimeout(r, wait))
        }
        toast.ok(`Republished ${formatCount(sent)} of ${formatCount(messages.length)} messages`)
      }
      onClose()
    } catch (err) {
      setError(err)
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={single ? `Republish message #${single.seq}` : `Republish ${messages.length} messages`}
      onClose={() => {
        cancelled.current = true
        onClose()
      }}
      width={640}
      footer={
        <>
          {busy && !single && (
            <span className="mr-auto text-muted" role="status">
              Sent {formatCount(progress)} of {formatCount(messages.length)}
            </span>
          )}
          <Button
            onClick={() => {
              cancelled.current = true
              onClose()
            }}
          >
            {busy && !single ? 'Stop' : 'Cancel'}
          </Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={!!subjectError || !!rateError || (!!single && !loaded)}
            onClick={() => void send()}
          >
            Republish
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-[1fr_180px] gap-3">
          <Field
            label={single ? 'Subject' : 'Subject (empty: each message keeps its own)'}
            error={subjectError}
          >
            {(id) => (
              <Input
                id={id}
                mono
                autoFocus
                invalid={!!subjectError}
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
            )}
          </Field>
          <Field label="Send as">
            {(id) => (
              <Select
                id={id}
                value={mode}
                onChange={(e) => setMode(e.target.value as 'core' | 'jetstream')}
              >
                <option value="jetstream">JetStream (wait for ack)</option>
                <option value="core">Core NATS</option>
              </Select>
            )}
          </Field>
        </div>
        {duplicates && (
          <Notice tone="warn">
            {target ? (
              <>
                Stream <span className="font-mono">{stream}</span> captures{' '}
                <span className="font-mono">{target}</span>, so the message will be stored again as
                a new copy.
              </>
            ) : (
              <>
                These subjects are captured by stream <span className="font-mono">{stream}</span>,
                so each message will be stored again as a new copy.
              </>
            )}
          </Notice>
        )}
        {single ? (
          <>
            <div>
              <span className="text-xs font-medium text-muted">Headers</span>
              <div className="pt-1">
                <HeadersEditor value={headers} onChange={setHeaders} />
              </div>
            </div>
            {!loaded ? (
              <p className="text-muted">Loading the full payload...</p>
            ) : text !== null ? (
              <Field label="Payload">
                {(id) => (
                  <TextArea
                    id={id}
                    rows={10}
                    value={payload}
                    onChange={(e) => setPayload(e.target.value)}
                  />
                )}
              </Field>
            ) : (
              <Notice>
                The payload is binary ({formatCount(loaded.size)} bytes) and will be sent unchanged.
              </Notice>
            )}
          </>
        ) : (
          <Field label="Rate limit (messages per second)" error={rateError} className="w-64">
            {(id) => (
              <Input
                id={id}
                inputMode="numeric"
                invalid={!!rateError}
                value={rate}
                onChange={(e) => setRate(e.target.value)}
              />
            )}
          </Field>
        )}
        <ErrorNote error={error} />
      </div>
    </Dialog>
  )
}

/**
 * Exports every message matching the current filters, up to a maximum (PBI-045). Payloads are
 * read in full, so this shows progress and can be cancelled.
 */
export function ExportAllDialog({
  connId,
  stream,
  subject,
  filters,
  onClose
}: {
  connId: string
  stream: string
  subject: string
  filters: ContentFilters
  onClose: () => void
}): ReactNode {
  const gateway = useGateway()
  const [max, setMax] = useState('1000')
  const [format, setFormat] = useState<'json' | 'ndjson'>('json')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState({ found: 0, scanned: 0 })
  const [error, setError] = useState<unknown>(null)
  const stop = useRef<(() => void) | null>(null)
  const maxNumber = Number(max)
  const maxError =
    !/^\d+$/.test(max.trim()) || maxNumber < 1 || maxNumber > 100_000
      ? 'Enter a number from 1 to 100,000'
      : null
  useEffect(() => () => stop.current?.(), [])

  const run = (): void => {
    if (maxError) return
    setRunning(true)
    setError(null)
    const out: ExportedMessage[] = []
    let scannedBefore = 0

    // The gateway returns at most 1,000 matches per scan, so larger exports continue from where the last one stopped.
    const next = (fromSeq: number | null): void => {
      stop.current = gateway.open(
        'scan',
        {
          connId,
          stream,
          request: {
            direction: 'asc',
            start: fromSeq === null ? { kind: 'first' } : { kind: 'seq', seq: fromSeq },
            limit: Math.min(1000, maxNumber - out.length),
            subject: subject || undefined,
            filters,
            scanLimit: 1_000_000_000,
            payloadBytes: FULL_PAYLOAD
          }
        },
        (event) => {
          if (event.type === 'matches') {
            for (const m of event.messages) out.push(toExported(m))
            setProgress((p) => ({ ...p, found: out.length }))
          } else if (event.type === 'progress') {
            setProgress({ found: out.length, scanned: scannedBefore + event.scanned })
          } else if (event.type === 'done') {
            stop.current = null
            scannedBefore += event.scanned
            if (event.reason === 'error') {
              setError(new GatewayError(event.error!))
              setRunning(false)
            } else if (
              event.reason === 'page' &&
              out.length < maxNumber &&
              event.resumeSeq !== null
            ) {
              next(event.resumeSeq)
            } else {
              saveText(
                `${safeFileName(stream)}-messages.${format === 'json' ? 'json' : 'ndjson'}`,
                serializeExport(out, format),
                format === 'json' ? 'application/json' : 'application/x-ndjson'
              )
              toast.ok(
                `Exported ${formatCount(out.length)} ${out.length === 1 ? 'message' : 'messages'} from ${stream}`
              )
              onClose()
            }
          }
        }
      )
    }
    next(null)
  }

  return (
    <Dialog
      title="Export all matching messages"
      onClose={onClose}
      width={460}
      footer={
        <>
          <Button onClick={onClose}>{running ? 'Cancel export' : 'Cancel'}</Button>
          <Button variant="primary" busy={running} disabled={!!maxError} onClick={run}>
            Export
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-muted">
          Exports messages from stream {stream} that match the current subject and filters, oldest
          first, with full payloads.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Maximum messages" error={maxError}>
            {(id) => (
              <Input
                id={id}
                inputMode="numeric"
                autoFocus
                invalid={!!maxError}
                disabled={running}
                value={max}
                onChange={(e) => setMax(e.target.value)}
              />
            )}
          </Field>
          <Field label="Format">
            {(id) => (
              <Select
                id={id}
                disabled={running}
                value={format}
                onChange={(e) => setFormat(e.target.value as 'json' | 'ndjson')}
              >
                <option value="json">JSON (one array)</option>
                <option value="ndjson">NDJSON (one message per line)</option>
              </Select>
            )}
          </Field>
        </div>
        {running && (
          <p role="status" className="tabular">
            Found {formatCount(progress.found)} of up to {formatCount(maxNumber)}. Examined{' '}
            {formatCount(progress.scanned)} messages.
          </p>
        )}
        <ErrorNote error={error} />
      </div>
    </Dialog>
  )
}
