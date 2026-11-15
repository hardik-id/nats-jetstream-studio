import { useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { PurgeRequest, StreamInfoDto } from '@shared/api'
import { formatCount } from '@shared/format'
import { validateSubject } from '@shared/subject'
import { ConfirmDialog, Field, Input } from '../../components/ui'
import { useGateway } from '../../gateway'
import { useConnection } from '../../lib/hooks'
import { toast } from '../../state/toasts'

type Mode = 'all' | 'subject' | 'seq' | 'keep'

/** Purge with a typed confirmation (PBI-033). */
export function PurgeDialog({
  connId,
  info,
  onClose
}: {
  connId: string
  info: StreamInfoDto
  onClose: () => void
}): ReactNode {
  const gateway = useGateway()
  const client = useQueryClient()
  const conn = useConnection(connId)
  const name = info.config.name
  const [mode, setMode] = useState<Mode>('all')
  const [subject, setSubject] = useState('')
  const [seq, setSeq] = useState('')
  const [keep, setKeep] = useState('')

  const subjectError =
    (mode === 'subject' || subject) && subject
      ? validateSubject(subject)
      : mode === 'subject'
        ? 'Subject is required'
        : null
  const seqError = mode === 'seq' && !/^\d+$/.test(seq) ? 'Enter a sequence number' : null
  const keepError =
    mode === 'keep' && !/^\d+$/.test(keep) ? 'Enter how many messages to keep' : null

  const build = (): PurgeRequest => {
    const request: PurgeRequest = {}
    if (subject && (mode === 'subject' || mode === 'seq' || mode === 'keep'))
      request.filter = subject
    if (mode === 'seq') request.seq = Number(seq)
    if (mode === 'keep') request.keep = Number(keep)
    return request
  }

  const option = (value: Mode, label: string, hint: string): ReactNode => (
    <label className="flex items-start gap-2">
      <input
        type="radio"
        name="purge-mode"
        className="mt-0.5 accent-[var(--accent)]"
        checked={mode === value}
        onChange={() => setMode(value)}
      />
      <span>
        {label}
        <span className="block text-xs text-muted">{hint}</span>
      </span>
    </label>
  )

  return (
    <ConfirmDialog
      title={`Purge stream ${name}`}
      confirmLabel="Purge messages"
      typeToConfirm={name}
      onClose={onClose}
      onConfirm={async () => {
        if (subjectError || seqError || keepError)
          throw new Error(subjectError ?? seqError ?? keepError ?? '')
        const result = await gateway.purgeStream(connId, name, build())
        await client.invalidateQueries({ queryKey: ['streams', connId] })
        await client.invalidateQueries({ queryKey: ['stream', connId, name] })
        await client.invalidateQueries({ queryKey: ['subjects', connId, name] })
        toast.ok(
          `Purged ${formatCount(result.purged)} ${result.purged === 1 ? 'message' : 'messages'} from ${name}`
        )
      }}
    >
      <div className="flex flex-col gap-3">
        <p>
          On <strong>{conn?.name}</strong>, stream <span className="font-mono">{name}</span> holds{' '}
          <strong>{formatCount(info.state.messages)}</strong> messages. Purged messages cannot be
          recovered.
        </p>
        <fieldset className="flex flex-col gap-2">
          <legend className="pb-1 text-xs font-semibold text-muted">What to purge</legend>
          {option('all', 'Everything', 'Removes every message in the stream.')}
          {option('subject', 'Messages on a subject', 'Wildcards are allowed.')}
          {option(
            'seq',
            'Up to a sequence',
            'Removes messages before that sequence; the message with that sequence stays.'
          )}
          {option('keep', 'All but the newest', 'Keeps the given number of most recent messages.')}
        </fieldset>
        {mode !== 'all' && (
          <Field
            label={mode === 'subject' ? 'Subject' : 'Only on subject (optional)'}
            error={subject || mode === 'subject' ? subjectError : null}
          >
            {(id) => (
              <Input
                id={id}
                mono
                placeholder="orders.eu.>"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
            )}
          </Field>
        )}
        {mode === 'seq' && (
          <Field
            label="Sequence"
            hint={`First ${info.state.first_seq}, last ${info.state.last_seq}`}
            error={seq ? seqError : null}
          >
            {(id) => (
              <Input
                id={id}
                inputMode="numeric"
                value={seq}
                onChange={(e) => setSeq(e.target.value)}
              />
            )}
          </Field>
        )}
        {mode === 'keep' && (
          <Field label="Messages to keep" error={keep ? keepError : null}>
            {(id) => (
              <Input
                id={id}
                inputMode="numeric"
                value={keep}
                onChange={(e) => setKeep(e.target.value)}
              />
            )}
          </Field>
        )}
      </div>
    </ConfirmDialog>
  )
}
