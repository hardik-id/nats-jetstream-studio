import { useMemo, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { StreamConfigDto, StreamInfoDto } from '@shared/api'
import { validateSubject } from '@shared/subject'
import {
  BytesField,
  ConfigEditor,
  CountField,
  DurationField,
  LinesField
} from '../../components/inputs'
import {
  Button,
  Checkbox,
  Dialog,
  ErrorNote,
  Field,
  Input,
  Notice,
  Select
} from '../../components/ui'
import { useGateway } from '../../gateway'
import { toast } from '../../state/toasts'

const DEFAULTS: StreamConfigDto = {
  name: '',
  subjects: [],
  storage: 'file',
  retention: 'limits',
  num_replicas: 1,
  max_msgs: -1,
  max_bytes: -1,
  max_age: 0,
  max_msg_size: -1,
  max_msgs_per_subject: -1,
  max_consumers: -1,
  discard: 'old',
  duplicate_window: 120e9,
  allow_direct: true
}

function validate(config: StreamConfigDto, editing: boolean): Record<string, string> {
  const errors: Record<string, string> = {}
  const name = config.name ?? ''
  if (!name.trim()) errors.name = 'Name is required'
  else if (/[\s.*>/\\]/.test(name))
    errors.name = 'Name cannot contain spaces, ".", "*", ">", "/" or "\\"'
  const sourced = Boolean(config.mirror) || (config.sources?.length ?? 0) > 0
  const subjects = config.subjects ?? []
  if (subjects.length === 0 && !sourced && !editing)
    errors.subjects = 'At least one subject is required'
  for (const subject of subjects) {
    const invalid = validateSubject(subject)
    if (invalid) {
      errors.subjects = `${subject}: ${invalid}`
      break
    }
  }
  if (!(Number(config.num_replicas ?? 1) >= 1 && Number(config.num_replicas ?? 1) <= 5))
    errors.replicas = 'Replicas must be between 1 and 5'
  return errors
}

/**
 * Create or edit a stream (PBI-032). In edit mode the fields the server refuses to change are
 * disabled; anything else the server rejects is shown with its error code.
 */
export function StreamForm({
  connId,
  existing,
  initial,
  onClose,
  onSaved
}: {
  connId: string
  existing?: StreamInfoDto
  /** Pre-fills the create form, for importing a configuration file. */
  initial?: StreamConfigDto
  onClose: () => void
  onSaved?: (info: StreamInfoDto) => void
}): ReactNode {
  const gateway = useGateway()
  const client = useQueryClient()
  const editing = Boolean(existing)
  const [config, setConfig] = useState<StreamConfigDto>(() => ({
    ...DEFAULTS,
    ...(existing?.config ?? initial ?? {})
  }))
  const [jsonValid, setJsonValid] = useState(true)
  const [submitted, setSubmitted] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const errors = useMemo(() => validate(config, editing), [config, editing])
  const show = (key: string): string | undefined => (submitted ? errors[key] : undefined)
  const set = <K extends keyof StreamConfigDto>(key: K, value: StreamConfigDto[K]): void =>
    setConfig((c) => ({ ...c, [key]: value }))
  const original = existing?.config
  const sourced = Boolean(config.mirror) || (config.sources?.length ?? 0) > 0

  const save = async (): Promise<void> => {
    setSubmitted(true)
    if (Object.keys(errors).length > 0 || !jsonValid) return
    setSaving(true)
    setError(null)
    try {
      const info = editing
        ? await gateway.updateStream(connId, existing!.config.name, config)
        : await gateway.createStream(connId, { ...config, name: config.name.trim() })
      await client.invalidateQueries({ queryKey: ['streams', connId] })
      await client.invalidateQueries({ queryKey: ['stream', connId, info.config.name] })
      toast.ok(editing ? `Saved stream ${info.config.name}` : `Created stream ${info.config.name}`)
      onSaved?.(info)
      onClose()
    } catch (err) {
      setError(err)
      setSaving(false)
    }
  }

  return (
    <Dialog
      title={editing ? `Edit stream ${existing!.config.name}` : 'New stream'}
      onClose={onClose}
      width={720}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={saving} disabled={!jsonValid} onClick={() => void save()}>
            {editing ? 'Save changes' : 'Create stream'}
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
        <ConfigEditor value={config} onChange={setConfig} onValidity={setJsonValid}>
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Name"
                error={show('name')}
                hint={editing ? 'The name cannot be changed.' : undefined}
              >
                {(id) => (
                  <Input
                    id={id}
                    mono
                    autoFocus={!editing}
                    disabled={editing}
                    invalid={!!show('name')}
                    value={config.name ?? ''}
                    onChange={(e) => set('name', e.target.value)}
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

            <LinesField
              label="Subjects"
              hint={
                sourced
                  ? 'Optional for a stream that mirrors or sources another stream.'
                  : 'One per line. Wildcards are allowed, for example orders.> or orders.*.created'
              }
              error={show('subjects')}
              placeholder="orders.>"
              value={config.subjects ?? []}
              onChange={(subjects) => set('subjects', subjects)}
            />

            <div className="grid grid-cols-3 gap-3">
              <Field label="Storage" hint={editing ? 'Cannot be changed.' : undefined}>
                {(id) => (
                  <Select
                    id={id}
                    disabled={editing}
                    value={config.storage ?? 'file'}
                    onChange={(e) => set('storage', e.target.value as StreamConfigDto['storage'])}
                  >
                    <option value="file">File</option>
                    <option value="memory">Memory</option>
                  </Select>
                )}
              </Field>
              <Field
                label="Retention"
                hint={
                  editing && original?.retention === 'workqueue'
                    ? 'A work-queue stream cannot change retention.'
                    : undefined
                }
              >
                {(id) => (
                  <Select
                    id={id}
                    disabled={editing && original?.retention === 'workqueue'}
                    value={config.retention ?? 'limits'}
                    onChange={(e) =>
                      set('retention', e.target.value as StreamConfigDto['retention'])
                    }
                  >
                    <option value="limits">Limits (keep until a limit is reached)</option>
                    <option value="interest">Interest (keep while consumers want it)</option>
                    <option
                      value="workqueue"
                      disabled={editing && original?.retention !== 'workqueue'}
                    >
                      Work queue (remove once acknowledged)
                    </option>
                  </Select>
                )}
              </Field>
              <Field label="Replicas" error={show('replicas')}>
                {(id) => (
                  <Input
                    id={id}
                    type="number"
                    min={1}
                    max={5}
                    invalid={!!show('replicas')}
                    value={config.num_replicas ?? 1}
                    onChange={(e) => set('num_replicas', Number(e.target.value))}
                  />
                )}
              </Field>
            </div>

            <fieldset className="rounded-md border border-line p-3">
              <legend className="px-1 text-xs font-semibold text-muted">
                Limits (empty means unlimited)
              </legend>
              <div className="grid grid-cols-3 gap-3">
                <CountField
                  label="Max messages"
                  value={config.max_msgs}
                  onChange={(v) => set('max_msgs', v)}
                />
                <BytesField
                  label="Max bytes"
                  value={config.max_bytes}
                  onChange={(v) => set('max_bytes', v)}
                />
                <DurationField
                  label="Max age"
                  value={config.max_age}
                  onChange={(v) => set('max_age', v)}
                />
                <BytesField
                  label="Max message size"
                  value={config.max_msg_size}
                  onChange={(v) => set('max_msg_size', v)}
                />
                <CountField
                  label="Max messages per subject"
                  value={config.max_msgs_per_subject}
                  onChange={(v) => set('max_msgs_per_subject', v)}
                />
                <CountField
                  label="Max consumers"
                  value={config.max_consumers}
                  disabled={editing}
                  hint={editing ? 'Cannot be changed.' : undefined}
                  onChange={(v) => set('max_consumers', v)}
                />
              </div>
            </fieldset>

            <div className="grid grid-cols-3 gap-3">
              <Field label="When a limit is reached">
                {(id) => (
                  <Select
                    id={id}
                    value={config.discard ?? 'old'}
                    onChange={(e) => set('discard', e.target.value as StreamConfigDto['discard'])}
                  >
                    <option value="old">Discard the oldest messages</option>
                    <option value="new">Refuse new messages</option>
                  </Select>
                )}
              </Field>
              <DurationField
                label="Duplicate window"
                emptyLabel="server default"
                value={config.duplicate_window}
                onChange={(v) => set('duplicate_window', v)}
                hint="How long message IDs are remembered. Cannot exceed max age."
              />
              <Field label="Compression">
                {(id) => (
                  <Select
                    id={id}
                    value={config.compression ?? 'none'}
                    onChange={(e) =>
                      set('compression', e.target.value as StreamConfigDto['compression'])
                    }
                  >
                    <option value="none">None</option>
                    <option value="s2">S2</option>
                  </Select>
                )}
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-x-6 gap-y-2">
              <Checkbox
                label="Allow direct get"
                hint="Lets clients (and this studio) read messages faster."
                checked={!!config.allow_direct}
                onChange={(e) => set('allow_direct', e.target.checked)}
              />
              <Checkbox
                label="Allow rollup headers"
                hint="Lets a publisher replace earlier messages."
                checked={!!config.allow_rollup_hdrs}
                onChange={(e) => set('allow_rollup_hdrs', e.target.checked)}
              />
              <Checkbox
                label="Deny delete"
                hint={
                  editing
                    ? 'Cannot be changed after creation.'
                    : 'Messages can never be deleted one by one.'
                }
                disabled={editing}
                checked={!!config.deny_delete}
                onChange={(e) => set('deny_delete', e.target.checked)}
              />
              <Checkbox
                label="Deny purge"
                hint={
                  editing ? 'Cannot be changed after creation.' : 'The stream can never be purged.'
                }
                disabled={editing}
                checked={!!config.deny_purge}
                onChange={(e) => set('deny_purge', e.target.checked)}
              />
            </div>

            {(config.mirror || (config.sources?.length ?? 0) > 0) && (
              <Notice>
                {config.mirror ? `Mirrors stream ${config.mirror.name}. ` : ''}
                {config.sources?.length
                  ? `Sources from ${config.sources.map((s) => s.name).join(', ')}. `
                  : ''}
                Use the JSON view to change mirror and source settings.
              </Notice>
            )}
          </div>
        </ConfigEditor>
        <ErrorNote error={error} />
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}
