import { useMemo, useState, type ReactNode } from 'react'
import { BookmarkPlus, CheckCircle2, Eraser, Send, Trash2 } from 'lucide-react'
import type { Header, PublishResult, RequestResult } from '@shared/api'
import { textToBase64, utf8Encode } from '@shared/encoding'
import { formatBytes, formatTime } from '@shared/format'
import { validateSubject } from '@shared/subject'
import { HeadersEditor } from '../../components/HeadersEditor'
import { PayloadViewer } from '../../components/PayloadViewer'
import {
  Badge,
  Button,
  Card,
  Dialog,
  ErrorNote,
  Field,
  Input,
  Kbd,
  Notice,
  Page,
  Select,
  TextArea
} from '../../components/ui'
import { useGateway } from '../../gateway'
import { useDecoders } from '../../lib/decoders'
import { useConnection, useSetting } from '../../lib/hooks'

type Mode = 'core' | 'jetstream' | 'request'

interface Draft {
  subject: string
  headers: Header[]
  payload: string
  mode: Mode
  timeoutMs: number
}

interface Template extends Draft {
  name: string
}

interface HistoryEntry extends Draft {
  at: number
}

type Outcome =
  | { kind: 'sent'; subject: string; bytes: number }
  | { kind: 'ack'; subject: string; ack: NonNullable<PublishResult['ack']> }
  | { kind: 'reply'; reply: RequestResult }

const EMPTY: Draft = { subject: '', headers: [], payload: '', mode: 'core', timeoutMs: 2000 }
const HISTORY_LIMIT = 20

/** Publish a message or send a request (PBI-062), with templates and a short history. */
export function PublishTab({ connId, subject }: { connId: string; subject?: string }): ReactNode {
  const gateway = useGateway()
  const conn = useConnection(connId)
  const decoders = useDecoders(connId)
  const [draft, setDraft] = useState<Draft>({ ...EMPTY, subject: subject ?? '' })
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [templates, setTemplates] = useSetting<Template[]>(`conn:${connId}:templates`, [])
  const [history, setHistory] = useSetting<HistoryEntry[]>(`conn:${connId}:publishHistory`, [])
  const [naming, setNaming] = useState(false)
  const set = <K extends keyof Draft>(key: K, value: Draft[K]): void =>
    setDraft((d) => ({ ...d, [key]: value }))

  const subjectError = draft.subject.trim() ? validateSubject(draft.subject.trim(), false) : null
  const json = useMemo(() => {
    const text = draft.payload.trim()
    if (!/^[[{]/.test(text)) return null
    try {
      JSON.parse(text)
      return { valid: true as const }
    } catch (err) {
      return { valid: false as const, message: (err as Error).message }
    }
  }, [draft.payload])
  const readOnly = conn?.readOnly
  const canSend = !!draft.subject.trim() && !subjectError && !readOnly && !busy

  const send = async (): Promise<void> => {
    if (!canSend) return
    setBusy(true)
    setError(null)
    setOutcome(null)
    const subjectText = draft.subject.trim()
    const headers = draft.headers.filter(([k]) => k.trim())
    const payload = textToBase64(draft.payload)
    try {
      if (draft.mode === 'request') {
        const reply = await gateway.request(connId, {
          subject: subjectText,
          headers,
          payload,
          timeoutMs: draft.timeoutMs
        })
        setOutcome({ kind: 'reply', reply })
      } else {
        const result = await gateway.publish(connId, {
          subject: subjectText,
          headers,
          payload,
          mode: draft.mode
        })
        setOutcome(
          result.ack
            ? { kind: 'ack', subject: subjectText, ack: result.ack }
            : { kind: 'sent', subject: subjectText, bytes: utf8Encode(draft.payload).length }
        )
      }
      const entry: HistoryEntry = { ...draft, subject: subjectText, headers, at: Date.now() }
      setHistory(
        [
          entry,
          ...history.filter(
            (h) =>
              !(h.subject === entry.subject && h.payload === entry.payload && h.mode === entry.mode)
          )
        ].slice(0, HISTORY_LIMIT)
      )
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  const load = (source: Draft): void => {
    setDraft({
      subject: source.subject,
      headers: source.headers.map((h) => [...h] as Header),
      payload: source.payload,
      mode: source.mode,
      timeoutMs: source.timeoutMs
    })
    setOutcome(null)
    setError(null)
  }

  return (
    <Page
      scroll={false}
      title="Publish"
      subtitle="Send a message or a request to a subject"
      actions={
        <Button
          size="sm"
          variant="ghost"
          icon={<Eraser className="h-3.5 w-3.5" aria-hidden />}
          disabled={busy}
          onClick={() => load(EMPTY)}
        >
          Clear form
        </Button>
      }
    >
      {/* Wide: the editor and the reply sit side by side and each scrolls inside its own box, so
          the reply is never below the fold. Narrow: one column and the page scrolls. */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:overflow-hidden">
        <div className="flex min-h-0 flex-col gap-4 lg:overflow-y-auto lg:pr-1">
          <Card title="Message">
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault()
                void send()
              }}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                  e.preventDefault()
                  void send()
                }
              }}
            >
              {readOnly && (
                <Notice tone="warn">
                  This connection is read-only, so publishing is blocked. Turn off read-only mode on
                  the connection to send messages.
                </Notice>
              )}
              <div className="grid grid-cols-[1fr_220px] gap-3">
                <Field label="Subject" error={subjectError}>
                  {(id) => (
                    <Input
                      id={id}
                      mono
                      autoFocus
                      placeholder="orders.eu.created"
                      invalid={!!subjectError}
                      disabled={readOnly}
                      value={draft.subject}
                      onChange={(e) => set('subject', e.target.value)}
                    />
                  )}
                </Field>
                <Field label="Send as">
                  {(id) => (
                    <Select
                      id={id}
                      disabled={readOnly}
                      value={draft.mode}
                      onChange={(e) => set('mode', e.target.value as Mode)}
                    >
                      <option value="core">Publish (core NATS)</option>
                      <option value="jetstream">Publish to JetStream (wait for ack)</option>
                      <option value="request">Request (wait for a reply)</option>
                    </Select>
                  )}
                </Field>
              </div>
              {draft.mode === 'request' && (
                <Field label="Reply timeout (milliseconds)" className="w-56">
                  {(id) => (
                    <Input
                      id={id}
                      type="number"
                      min={100}
                      max={120000}
                      step={100}
                      disabled={readOnly}
                      value={draft.timeoutMs}
                      onChange={(e) => set('timeoutMs', Number(e.target.value))}
                    />
                  )}
                </Field>
              )}
              <div>
                <span className="text-xs font-medium text-muted">Headers</span>
                <div className="pt-1">
                  <HeadersEditor
                    value={draft.headers}
                    onChange={(h) => set('headers', h)}
                    disabled={readOnly}
                  />
                </div>
              </div>
              <Field
                label="Payload"
                hint={
                  json === null
                    ? 'Sent as text. Start with { or [ to have JSON checked.'
                    : undefined
                }
                error={
                  json && !json.valid
                    ? `Not valid JSON: ${json.message}. It can still be sent as text.`
                    : null
                }
              >
                {(id) => (
                  <TextArea
                    id={id}
                    rows={10}
                    disabled={readOnly}
                    invalid={!!json && !json.valid}
                    placeholder='{"hello":"world"}'
                    value={draft.payload}
                    onChange={(e) => set('payload', e.target.value)}
                  />
                )}
              </Field>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="submit"
                  variant="primary"
                  busy={busy}
                  disabled={!canSend}
                  icon={<Send className="h-3.5 w-3.5" aria-hidden />}
                >
                  {draft.mode === 'request' ? 'Send request' : 'Publish'}
                </Button>
                <span className="text-xs text-faint">
                  <Kbd>Ctrl</Kbd> + <Kbd>Enter</Kbd>
                </span>
                {json?.valid && (
                  <>
                    <Badge tone="ok">Valid JSON</Badge>
                    <Button
                      size="sm"
                      disabled={readOnly}
                      onClick={() =>
                        set('payload', JSON.stringify(JSON.parse(draft.payload), null, 2))
                      }
                    >
                      Format
                    </Button>
                  </>
                )}
                <span className="ml-auto text-xs text-muted">
                  {formatBytes(utf8Encode(draft.payload).length)}
                </span>
                <Button
                  size="sm"
                  icon={<BookmarkPlus className="h-3.5 w-3.5" aria-hidden />}
                  disabled={!draft.subject.trim()}
                  onClick={() => setNaming(true)}
                >
                  Save as template
                </Button>
              </div>
            </form>
          </Card>

          <Card title={`Templates (${templates.length})`}>
            {templates.length === 0 ? (
              <p className="text-muted">
                Save a message you send often as a template. Templates are kept per connection.
              </p>
            ) : (
              <ul className="flex flex-col">
                {templates.map((t) => (
                  <li
                    key={t.name}
                    className="flex items-center gap-2 border-t border-line py-1 first:border-t-0"
                  >
                    <button
                      className="min-w-0 flex-1 text-left hover:text-accent"
                      onClick={() => load(t)}
                    >
                      <span className="block truncate font-medium">{t.name}</span>
                      <span className="block truncate font-mono text-xs text-muted">
                        {t.subject}
                      </span>
                    </button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Delete template ${t.name}`}
                      icon={<Trash2 className="h-3.5 w-3.5" aria-hidden />}
                      onClick={() => setTemplates(templates.filter((x) => x.name !== t.name))}
                    />
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card
            title="Recently sent"
            actions={
              history.length > 0 && (
                <Button size="sm" variant="ghost" onClick={() => setHistory([])}>
                  Clear
                </Button>
              )
            }
          >
            {history.length === 0 ? (
              <p className="text-muted">The last {HISTORY_LIMIT} messages you send appear here.</p>
            ) : (
              <ul className="flex flex-col">
                {history.map((h) => (
                  <li key={h.at} className="border-t border-line first:border-t-0">
                    <button
                      className="flex w-full items-center gap-2 py-1 text-left hover:text-accent"
                      onClick={() => load(h)}
                    >
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">{h.subject}</span>
                      <Badge>
                        {h.mode === 'request'
                          ? 'request'
                          : h.mode === 'jetstream'
                            ? 'jetstream'
                            : 'publish'}
                      </Badge>
                      <span className="tabular text-xs text-faint">
                        {formatTime(h.at).slice(5, 19)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <section
          aria-label="Result"
          className="flex min-h-96 min-w-0 flex-col rounded-lg border border-line bg-panel lg:min-h-0"
        >
          <header className="flex min-h-9 shrink-0 items-center border-b border-line px-3 py-1.5">
            <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Result</h3>
          </header>
          <div aria-live="polite" className="flex min-h-0 flex-1 flex-col gap-3 p-3">
            {outcome === null && error == null && (
              <p className="text-muted">
                {busy
                  ? 'Waiting for the server...'
                  : 'The acknowledgement or the reply appears here after you send.'}
              </p>
            )}
            <ErrorNote error={error} />
            {outcome?.kind === 'sent' && (
              <Notice tone="ok" className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
                Published {formatBytes(outcome.bytes)} to{' '}
                <span className="font-mono">{outcome.subject}</span>. Core NATS does not confirm
                delivery.
              </Notice>
            )}
            {outcome?.kind === 'ack' && (
              <Notice tone="ok" className="flex flex-wrap items-center gap-2">
                <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
                Stored in stream <span className="font-mono">{outcome.ack.stream}</span> as sequence{' '}
                <strong>{outcome.ack.seq}</strong>.
                {outcome.ack.duplicate && (
                  <Badge tone="warn">Duplicate: the stream already had this message ID</Badge>
                )}
              </Notice>
            )}
            {outcome?.kind === 'reply' && (
              <>
                <p>
                  Reply in <strong>{outcome.reply.rttMs} ms</strong> ·{' '}
                  {formatBytes(outcome.reply.size)}
                </p>
                {outcome.reply.headers.length > 0 && (
                  <table className="w-full table-fixed border-collapse text-xs">
                    <tbody>
                      {outcome.reply.headers.map(([k, v], i) => (
                        <tr key={i} className="border-t border-line first:border-t-0">
                          <th
                            scope="row"
                            className="w-2/5 py-1 pr-2 text-left font-mono font-normal text-muted"
                          >
                            {k}
                          </th>
                          <td className="py-1 font-mono break-all">{v}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <PayloadViewer
                  className="min-h-48 flex-1"
                  payload={outcome.reply.payload}
                  size={outcome.reply.size}
                  subject={outcome.reply.subject}
                  decoders={decoders}
                />
              </>
            )}
          </div>
        </section>
      </div>

      {naming && (
        <NameDialog
          existing={templates.map((t) => t.name)}
          onClose={() => setNaming(false)}
          onSave={(name) =>
            setTemplates(
              [
                ...templates.filter((t) => t.name !== name),
                { ...draft, subject: draft.subject.trim(), name }
              ].sort((a, b) => a.name.localeCompare(b.name))
            )
          }
        />
      )}
    </Page>
  )
}

function NameDialog({
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
  const submit = (): void => {
    if (!trimmed) return
    onSave(trimmed)
    onClose()
  }
  return (
    <Dialog
      title="Save as template"
      onClose={onClose}
      width={400}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!trimmed} onClick={submit}>
            {existing.includes(trimmed) ? 'Replace' : 'Save'}
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
          label="Template name"
          hint={
            existing.includes(trimmed)
              ? 'A template with this name exists and will be replaced.'
              : undefined
          }
        >
          {(id) => (
            <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          )}
        </Field>
      </form>
    </Dialog>
  )
}
