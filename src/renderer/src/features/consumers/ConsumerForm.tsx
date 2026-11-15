import { useMemo, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ConsumerConfigDto, ConsumerInfoDto } from '@shared/api'
import { formatDuration, parseDuration } from '@shared/duration'
import { validateSubject } from '@shared/subject'
import { ConfigEditor, CountField, DurationField, LinesField } from '../../components/inputs'
import { Button, Checkbox, Dialog, ErrorNote, Field, Input, Select } from '../../components/ui'
import { useGateway } from '../../gateway'
import { toast } from '../../state/toasts'

const DEFAULTS: ConsumerConfigDto = {
  deliver_policy: 'all',
  ack_policy: 'explicit',
  ack_wait: 30e9,
  max_deliver: -1,
  replay_policy: 'instant',
  max_ack_pending: 1000
}

interface Extra {
  durable: boolean
  push: boolean
  name: string
  backoff: string
  startTime: string
}

function toLocalInput(iso: string | undefined): string {
  const d = iso ? new Date(iso) : new Date()
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * Create or edit a consumer (PBI-052). When editing, the fields the server never changes after
 * creation (delivery start, ack policy, pull or push) are disabled.
 */
export function ConsumerForm({
  connId,
  stream,
  existing,
  onClose,
  onSaved
}: {
  connId: string
  stream: string
  existing?: ConsumerInfoDto
  onClose: () => void
  onSaved?: (info: ConsumerInfoDto) => void
}): ReactNode {
  const gateway = useGateway()
  const client = useQueryClient()
  const editing = Boolean(existing)
  const [config, setConfig] = useState<ConsumerConfigDto>(() => ({
    ...DEFAULTS,
    ...(existing?.config ?? {})
  }))
  const [extra, setExtra] = useState<Extra>(() => ({
    durable: existing ? Boolean(existing.config.durable_name) : true,
    push: Boolean(existing?.config.deliver_subject),
    name: existing?.name ?? '',
    backoff: (existing?.config.backoff ?? []).map((ns) => formatDuration(ns)).join(', '),
    startTime: toLocalInput(existing?.config.opt_start_time)
  }))
  const [jsonValid, setJsonValid] = useState(true)
  const [submitted, setSubmitted] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const set = <K extends keyof ConsumerConfigDto>(key: K, value: ConsumerConfigDto[K]): void =>
    setConfig((c) => ({ ...c, [key]: value }))

  const filters = useMemo(
    () =>
      config.filter_subjects?.length
        ? config.filter_subjects
        : config.filter_subject
          ? [config.filter_subject]
          : [],
    [config.filter_subjects, config.filter_subject]
  )
  const backoff = useMemo(() => {
    const parts = extra.backoff
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    const values = parts.map((p) => parseDuration(p))
    return {
      values: values.filter((v): v is number => v !== null && v > 0),
      invalid: values.some((v) => v === null || v <= 0)
    }
  }, [extra.backoff])

  const errors = useMemo(() => {
    const out: Record<string, string> = {}
    if (!editing) {
      if (extra.durable && !extra.name.trim()) out.name = 'A durable consumer needs a name'
      else if (/[\s.*>/\\]/.test(extra.name))
        out.name = 'Name cannot contain spaces, ".", "*", ">", "/" or "\\"'
    }
    for (const f of filters) {
      const invalid = validateSubject(f)
      if (invalid) {
        out.filters = `${f}: ${invalid}`
        break
      }
    }
    if (backoff.invalid)
      out.backoff = 'Enter durations separated by commas, for example 1s, 5s, 30s'
    if (extra.push && !config.deliver_subject?.trim())
      out.deliver = 'A push consumer needs a deliver subject'
    else if (extra.push && config.deliver_subject && validateSubject(config.deliver_subject, false))
      out.deliver = validateSubject(config.deliver_subject, false)!
    if (config.deliver_policy === 'by_start_sequence' && !(Number(config.opt_start_seq) >= 1))
      out.startSeq = 'Enter the sequence to start from'
    if (
      config.deliver_policy === 'by_start_time' &&
      Number.isNaN(new Date(extra.startTime).getTime())
    )
      out.startTime = 'Enter the time to start from'
    return out
  }, [
    editing,
    extra,
    filters,
    backoff.invalid,
    config.deliver_subject,
    config.deliver_policy,
    config.opt_start_seq
  ])
  const show = (key: string): string | undefined => (submitted ? errors[key] : undefined)

  /** The form keeps a few values outside the config object; fold them in before sending. */
  const build = (): ConsumerConfigDto => {
    const out: ConsumerConfigDto = { ...config }
    if (!editing) {
      const name = extra.name.trim()
      delete out.name
      delete out.durable_name
      if (name) {
        out.name = name
        if (extra.durable) out.durable_name = name
      }
    }
    delete out.filter_subject
    delete out.filter_subjects
    if (filters.length === 1) out.filter_subject = filters[0]
    else if (filters.length > 1) out.filter_subjects = filters
    if (backoff.values.length) out.backoff = backoff.values
    else delete out.backoff
    if (!extra.push) {
      delete out.deliver_subject
      delete out.deliver_group
    }
    if (out.deliver_policy === 'by_start_time')
      out.opt_start_time = new Date(extra.startTime).toISOString()
    else delete out.opt_start_time
    if (out.deliver_policy !== 'by_start_sequence') delete out.opt_start_seq
    return out
  }

  const save = async (): Promise<void> => {
    setSubmitted(true)
    if (Object.keys(errors).length > 0 || !jsonValid) return
    setSaving(true)
    setError(null)
    try {
      const info = editing
        ? await gateway.updateConsumer(connId, stream, existing!.name, build())
        : await gateway.createConsumer(connId, stream, build())
      await client.invalidateQueries({ queryKey: ['consumers', connId] })
      await client.invalidateQueries({ queryKey: ['consumer', connId, stream, info.name] })
      await client.invalidateQueries({ queryKey: ['streams', connId] })
      toast.ok(editing ? `Saved consumer ${info.name}` : `Created consumer ${info.name}`)
      onSaved?.(info)
      onClose()
    } catch (err) {
      setError(err)
      setSaving(false)
    }
  }

  const fixed = editing ? 'Cannot be changed after creation.' : undefined

  return (
    <Dialog
      title={editing ? `Edit consumer ${existing!.name}` : `New consumer on ${stream}`}
      onClose={onClose}
      width={720}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={saving} disabled={!jsonValid} onClick={() => void save()}>
            {editing ? 'Save changes' : 'Create consumer'}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <ConfigEditor
          value={build()}
          onChange={(next) => setConfig({ ...next })}
          onValidity={setJsonValid}
        >
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Name"
                error={show('name')}
                hint={
                  editing
                    ? 'The name cannot be changed.'
                    : extra.durable
                      ? undefined
                      : 'Optional for an ephemeral consumer.'
                }
              >
                {(id) => (
                  <Input
                    id={id}
                    mono
                    autoFocus={!editing}
                    disabled={editing}
                    invalid={!!show('name')}
                    value={extra.name}
                    onChange={(e) => setExtra((x) => ({ ...x, name: e.target.value }))}
                  />
                )}
              </Field>
              <Field label="Description">
                {(id) => (
                  <Input
                    id={id}
                    value={config.description ?? ''}
                    onChange={(e) => set('description', e.target.value || undefined)}
                  />
                )}
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-2">
              <Checkbox
                label="Durable"
                hint={
                  editing
                    ? fixed
                    : 'Keeps its position when clients disconnect. An ephemeral consumer is removed after it has been idle.'
                }
                disabled={editing}
                checked={extra.durable}
                onChange={(e) => setExtra((x) => ({ ...x, durable: e.target.checked }))}
              />
              <Checkbox
                label="Push consumer"
                hint={
                  editing
                    ? fixed
                    : 'The server sends messages to a subject. Leave off for a pull consumer, where clients ask for messages.'
                }
                disabled={editing}
                checked={extra.push}
                onChange={(e) => setExtra((x) => ({ ...x, push: e.target.checked }))}
              />
            </div>
            {extra.push && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Deliver subject" error={show('deliver')}>
                  {(id) => (
                    <Input
                      id={id}
                      mono
                      invalid={!!show('deliver')}
                      value={config.deliver_subject ?? ''}
                      onChange={(e) => set('deliver_subject', e.target.value)}
                    />
                  )}
                </Field>
                <Field
                  label="Deliver group"
                  hint={editing ? fixed : 'Subscribers in the same group share the messages.'}
                >
                  {(id) => (
                    <Input
                      id={id}
                      mono
                      disabled={editing}
                      value={config.deliver_group ?? ''}
                      onChange={(e) => set('deliver_group', e.target.value || undefined)}
                    />
                  )}
                </Field>
              </div>
            )}

            <LinesField
              label="Filter subjects"
              hint="One per line. Empty means every subject in the stream."
              error={show('filters')}
              rows={2}
              placeholder="orders.*.paid"
              value={filters}
              onChange={(list) =>
                setConfig((c) => ({ ...c, filter_subject: undefined, filter_subjects: list }))
              }
            />

            <div className="grid grid-cols-3 gap-3">
              <Field label="Start delivering from" hint={fixed}>
                {(id) => (
                  <Select
                    id={id}
                    disabled={editing}
                    value={config.deliver_policy ?? 'all'}
                    onChange={(e) =>
                      set('deliver_policy', e.target.value as ConsumerConfigDto['deliver_policy'])
                    }
                  >
                    <option value="all">All messages</option>
                    <option value="last">The last message</option>
                    <option value="new">New messages only</option>
                    <option value="by_start_sequence">A sequence</option>
                    <option value="by_start_time">A date and time</option>
                    <option value="last_per_subject">The last message of each subject</option>
                  </Select>
                )}
              </Field>
              {config.deliver_policy === 'by_start_sequence' && (
                <Field label="Start sequence" error={show('startSeq')}>
                  {(id) => (
                    <Input
                      id={id}
                      inputMode="numeric"
                      disabled={editing}
                      invalid={!!show('startSeq')}
                      value={config.opt_start_seq ?? ''}
                      onChange={(e) =>
                        set('opt_start_seq', e.target.value ? Number(e.target.value) : undefined)
                      }
                    />
                  )}
                </Field>
              )}
              {config.deliver_policy === 'by_start_time' && (
                <Field label="Start time (local)" error={show('startTime')}>
                  {(id) => (
                    <Input
                      id={id}
                      type="datetime-local"
                      step={1}
                      disabled={editing}
                      invalid={!!show('startTime')}
                      value={extra.startTime}
                      onChange={(e) => setExtra((x) => ({ ...x, startTime: e.target.value }))}
                    />
                  )}
                </Field>
              )}
              <Field label="Replay" hint={fixed}>
                {(id) => (
                  <Select
                    id={id}
                    disabled={editing}
                    value={config.replay_policy ?? 'instant'}
                    onChange={(e) =>
                      set('replay_policy', e.target.value as ConsumerConfigDto['replay_policy'])
                    }
                  >
                    <option value="instant">As fast as possible</option>
                    <option value="original">At the original pace</option>
                  </Select>
                )}
              </Field>
            </div>

            <fieldset className="rounded-md border border-line p-3">
              <legend className="px-1 text-xs font-semibold text-muted">Acknowledgement</legend>
              <div className="grid grid-cols-3 gap-3">
                <Field label="Ack policy" hint={fixed}>
                  {(id) => (
                    <Select
                      id={id}
                      disabled={editing}
                      value={config.ack_policy ?? 'explicit'}
                      onChange={(e) =>
                        set('ack_policy', e.target.value as ConsumerConfigDto['ack_policy'])
                      }
                    >
                      <option value="explicit">Explicit (each message)</option>
                      <option value="all">All (acks everything before it)</option>
                      <option value="none">None</option>
                    </Select>
                  )}
                </Field>
                <DurationField
                  label="Ack wait"
                  emptyLabel="server default"
                  value={config.ack_wait}
                  onChange={(v) => set('ack_wait', v)}
                  hint={
                    backoff.values.length
                      ? 'With a backoff list, the first step is used instead.'
                      : 'How long before a message is redelivered.'
                  }
                />
                <CountField
                  label="Max deliveries"
                  value={config.max_deliver}
                  onChange={(v) => set('max_deliver', v)}
                  hint="Empty: redeliver without limit."
                />
                <Field
                  label="Backoff"
                  error={show('backoff')}
                  hint="Waits between redeliveries, for example 1s, 5s, 30s"
                >
                  {(id) => (
                    <Input
                      id={id}
                      invalid={!!show('backoff')}
                      value={extra.backoff}
                      onChange={(e) => setExtra((x) => ({ ...x, backoff: e.target.value }))}
                    />
                  )}
                </Field>
                <CountField
                  label="Max ack pending"
                  value={config.max_ack_pending}
                  onChange={(v) => set('max_ack_pending', v)}
                  hint="Delivery pauses at this many unacknowledged messages."
                />
                <DurationField
                  label="Inactive threshold"
                  emptyLabel="server default"
                  value={config.inactive_threshold}
                  onChange={(v) => set('inactive_threshold', v)}
                  hint="Remove the consumer after this long without clients."
                />
              </div>
            </fieldset>
          </div>
        </ConfigEditor>
        <ErrorNote error={error} />
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}
