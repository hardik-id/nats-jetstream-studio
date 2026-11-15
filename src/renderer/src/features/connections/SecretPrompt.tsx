import { useState, type ReactNode } from 'react'
import { Button, Dialog, ErrorNote, Field, Input } from '../../components/ui'
import { useGateway } from '../../gateway'
import { useConnection } from '../../lib/hooks'

/** Asks for a secret that is not stored, then connects (PBI-014). The value is never kept. */
export function SecretPrompt({ id, onClose }: { id: string; onClose: () => void }): ReactNode {
  const gateway = useGateway()
  const conn = useConnection(id)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  if (!conn) return null
  const label =
    conn.auth === 'token'
      ? 'Token'
      : conn.auth === 'nkey'
        ? 'NKey seed'
        : `Password for ${conn.user ?? 'user'}`

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const secrets =
        conn.auth === 'token'
          ? { token: value }
          : conn.auth === 'nkey'
            ? { nkeySeed: value }
            : { password: value }
      await gateway.connect(id, secrets)
      onClose()
    } catch (err) {
      setError(err)
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={`Connect to ${conn.name}`}
      onClose={onClose}
      width={420}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} disabled={!value} onClick={() => void submit()}>
            Connect
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (value) void submit()
        }}
      >
        <Field label={label} hint="Used for this connection only. It is not saved.">
          {(fid) => (
            <Input
              id={fid}
              type="password"
              autoFocus
              autoComplete="off"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          )}
        </Field>
        <ErrorNote error={error} />
      </form>
    </Dialog>
  )
}
