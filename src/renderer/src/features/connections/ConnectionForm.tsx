import { useMemo, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, FolderOpen, XCircle } from 'lucide-react'
import {
  isProduction,
  type AuthMethod,
  type ConnectionInput,
  type ConnectionSummary,
  type TestConnectionResult
} from '@shared/api'
import {
  CONNECTION_COLORS,
  validateConnectionInput,
  type ConnectionErrors
} from '@shared/connection'
import {
  Button,
  Checkbox,
  cx,
  Dialog,
  ErrorNote,
  Field,
  Input,
  Notice,
  Select,
  TextArea
} from '../../components/ui'
import { useGateway } from '../../gateway'
import { useAppInfo, useConnections } from '../../lib/hooks'
import { toast } from '../../state/toasts'

interface FormState {
  name: string
  description: string
  servers: string
  auth: AuthMethod
  user: string
  password: string
  token: string
  nkeySeed: string
  nkeyFile: string
  credsFile: string
  caFile: string
  certFile: string
  keyFile: string
  handshakeFirst: boolean
  jsDomain: string
  apiPrefix: string
  inboxPrefix: string
  color: string
  envLabel: string
  readOnly: boolean
  saveSecrets: boolean
}

function initial(existing: ConnectionSummary | undefined, count: number): FormState {
  return {
    name: existing?.name ?? '',
    description: existing?.description ?? '',
    servers: existing?.servers.join('\n') ?? 'nats://127.0.0.1:4222',
    auth: existing?.auth ?? 'none',
    user: existing?.user ?? '',
    password: '',
    token: '',
    nkeySeed: '',
    nkeyFile: existing?.nkeyFile ?? '',
    credsFile: existing?.credsFile ?? '',
    caFile: existing?.tls?.caFile ?? '',
    certFile: existing?.tls?.certFile ?? '',
    keyFile: existing?.tls?.keyFile ?? '',
    handshakeFirst: existing?.tls?.handshakeFirst ?? false,
    jsDomain: existing?.jsDomain ?? '',
    apiPrefix: existing?.apiPrefix ?? '',
    inboxPrefix: existing?.inboxPrefix ?? '',
    color: existing?.color ?? CONNECTION_COLORS[count % CONNECTION_COLORS.length],
    envLabel: existing?.envLabel ?? '',
    readOnly: existing?.readOnly ?? false,
    saveSecrets: existing?.saveSecrets ?? true
  }
}

function toInput(form: FormState, id: string | undefined): ConnectionInput {
  const text = (v: string): string | undefined => (v.trim() ? v.trim() : undefined)
  const tls = {
    caFile: text(form.caFile),
    certFile: text(form.certFile),
    keyFile: text(form.keyFile),
    handshakeFirst: form.handshakeFirst || undefined
  }
  return {
    id,
    name: form.name,
    description: text(form.description),
    servers: form.servers
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
    auth: form.auth,
    user: text(form.user),
    // An empty secret field means "keep what is stored".
    password: form.password || undefined,
    token: form.token || undefined,
    nkeySeed: form.nkeySeed.trim() || undefined,
    nkeyFile: text(form.nkeyFile),
    credsFile: text(form.credsFile),
    tls: Object.values(tls).some((v) => v !== undefined) ? tls : undefined,
    jsDomain: text(form.jsDomain),
    apiPrefix: text(form.apiPrefix),
    inboxPrefix: text(form.inboxPrefix),
    color: form.color,
    envLabel: form.envLabel.trim(),
    readOnly: form.readOnly,
    saveSecrets: form.saveSecrets
  }
}

/** Add or edit a connection (PBI-011), with "Test" (PBI-012) and secret handling (PBI-014). */
export function ConnectionForm({
  id,
  onClose
}: {
  id: string | null
  onClose: () => void
}): ReactNode {
  const { data: connections, isLoading } = useConnections()
  // The form copies the connection into its own state once, so it must not start before the
  // connection is known.
  if (id && isLoading) return null
  const existing = id ? connections?.find((c) => c.id === id) : undefined
  return <Form existing={existing} count={connections?.length ?? 0} onClose={onClose} />
}

function Form({
  existing,
  count,
  onClose
}: {
  existing: ConnectionSummary | undefined
  count: number
  onClose: () => void
}): ReactNode {
  const gateway = useGateway()
  const client = useQueryClient()
  const appInfo = useAppInfo()
  const fromCli = existing?.source === 'cli'

  const [form, setForm] = useState<FormState>(() => initial(existing, count))
  const [touchedReadOnly, setTouchedReadOnly] = useState(Boolean(existing))
  const [submitted, setSubmitted] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [test, setTest] = useState<TestConnectionResult | null>(null)
  const [error, setError] = useState<unknown>(null)
  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm((f) => ({ ...f, [key]: value }))
    setTest(null)
  }

  // A production label switches read-only on, unless the user already decided.
  const setEnvLabel = (envLabel: string): void => {
    setForm((f) => ({
      ...f,
      envLabel,
      readOnly: touchedReadOnly ? f.readOnly : isProduction(envLabel)
    }))
    setTest(null)
  }

  const input = useMemo(() => toInput(form, existing?.id), [form, existing?.id])
  const errors: ConnectionErrors = useMemo(
    () => (fromCli ? {} : validateConnectionInput(input, { stored: existing?.storedSecrets })),
    [input, existing, fromCli]
  )
  const show = (key: keyof ConnectionErrors): string | undefined =>
    submitted ? errors[key] : undefined
  const desktop = window.studioDesktop

  const browse = async (
    key: 'credsFile' | 'nkeyFile' | 'caFile' | 'certFile' | 'keyFile',
    title: string
  ): Promise<void> => {
    const path = await desktop?.pickFile({ title })
    if (path) set(key, path)
  }
  const pathField = (
    key: 'credsFile' | 'nkeyFile' | 'caFile' | 'certFile' | 'keyFile',
    label: string,
    placeholder: string,
    err?: string
  ): ReactNode => (
    <Field label={label} error={err}>
      {(fid) => (
        <div className="flex gap-1">
          <Input
            id={fid}
            mono
            placeholder={placeholder}
            value={form[key]}
            invalid={!!err}
            disabled={fromCli}
            onChange={(e) => set(key, e.target.value)}
          />
          {desktop && !fromCli && (
            <Button
              title="Browse"
              aria-label={`Browse for ${label}`}
              icon={<FolderOpen className="h-4 w-4" aria-hidden />}
              onClick={() => void browse(key, label)}
            />
          )}
        </div>
      )}
    </Field>
  )

  const runTest = async (): Promise<void> => {
    setSubmitted(true)
    if (Object.keys(errors).length > 0) return
    setTesting(true)
    setTest(null)
    try {
      setTest(await gateway.testConnection(input))
    } catch (err) {
      setTest({ ok: false, kind: 'other', message: (err as Error).message })
    } finally {
      setTesting(false)
    }
  }

  const save = async (): Promise<void> => {
    setSubmitted(true)
    if (Object.keys(errors).length > 0) return
    setSaving(true)
    setError(null)
    try {
      const saved = await gateway.saveConnection(input)
      await client.invalidateQueries({ queryKey: ['connections'] })
      toast.ok(existing ? `Saved "${saved.name}"` : `Added "${saved.name}"`)
      onClose()
    } catch (err) {
      setError(err)
      setSaving(false)
    }
  }

  const stored = existing?.storedSecrets ?? {}
  const savedHint = (has: boolean | undefined): string =>
    has ? 'Saved. Leave empty to keep it.' : ''

  return (
    <Dialog
      title={existing ? `Edit connection: ${existing.name}` : 'Add connection'}
      onClose={onClose}
      width={640}
      footer={
        <>
          {!fromCli && (
            <Button className="mr-auto" busy={testing} onClick={() => void runTest()}>
              Test connection
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={saving} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        {fromCli && (
          <Notice>
            This connection comes from the NATS CLI context{' '}
            <span className="font-mono">{existing?.name}</span>. Its address and credentials are
            read from the context file and cannot be changed here; use{' '}
            <span className="font-mono">nats context edit {existing?.name}</span>. Colour,
            environment and read-only mode are the studio&apos;s own settings.
          </Notice>
        )}
        {existing?.warnings?.map((w) => (
          <Notice key={w} tone="warn">
            {w}
          </Notice>
        ))}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Name" error={show('name')}>
            {(fid) => (
              <Input
                id={fid}
                autoFocus={!fromCli}
                value={form.name}
                invalid={!!show('name')}
                disabled={fromCli}
                onChange={(e) => set('name', e.target.value)}
              />
            )}
          </Field>
          <Field
            label="Environment"
            hint="For example dev, test or prod. Production connections start read-only."
          >
            {(fid) => (
              <>
                <Input
                  id={fid}
                  list="env-labels"
                  placeholder="dev"
                  value={form.envLabel}
                  onChange={(e) => setEnvLabel(e.target.value)}
                />
                <datalist id="env-labels">
                  {['dev', 'test', 'staging', 'prod'].map((l) => (
                    <option key={l} value={l} />
                  ))}
                </datalist>
              </>
            )}
          </Field>
        </div>

        <Field
          label="Server URLs"
          hint="One per line. Give several servers of the same cluster so the studio can fail over."
          error={show('servers')}
        >
          {(fid) => (
            <TextArea
              id={fid}
              rows={2}
              placeholder="nats://localhost:4222"
              value={form.servers}
              invalid={!!show('servers')}
              disabled={fromCli}
              onChange={(e) => set('servers', e.target.value)}
            />
          )}
        </Field>

        <fieldset className="flex flex-col gap-3 rounded-md border border-line p-3">
          <legend className="px-1 text-xs font-semibold text-muted">Authentication</legend>
          <Field label="Method">
            {(fid) => (
              <Select
                id={fid}
                value={form.auth}
                disabled={fromCli}
                onChange={(e) => set('auth', e.target.value as AuthMethod)}
              >
                <option value="none">None</option>
                <option value="userpass">User and password</option>
                <option value="token">Token</option>
                <option value="nkey">NKey seed</option>
                <option value="creds">Credentials file (JWT and NKey)</option>
              </Select>
            )}
          </Field>
          {form.auth === 'userpass' && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="User" error={show('user')}>
                {(fid) => (
                  <Input
                    id={fid}
                    autoComplete="off"
                    value={form.user}
                    invalid={!!show('user')}
                    disabled={fromCli}
                    onChange={(e) => set('user', e.target.value)}
                  />
                )}
              </Field>
              {!fromCli && (
                <Field label="Password" error={show('password')} hint={savedHint(stored.password)}>
                  {(fid) => (
                    <Input
                      id={fid}
                      type="password"
                      autoComplete="new-password"
                      placeholder={stored.password ? '••••••••' : ''}
                      value={form.password}
                      invalid={!!show('password')}
                      onChange={(e) => set('password', e.target.value)}
                    />
                  )}
                </Field>
              )}
            </div>
          )}
          {form.auth === 'token' && !fromCli && (
            <Field label="Token" error={show('token')} hint={savedHint(stored.token)}>
              {(fid) => (
                <Input
                  id={fid}
                  type="password"
                  autoComplete="new-password"
                  placeholder={stored.token ? '••••••••' : ''}
                  value={form.token}
                  invalid={!!show('token')}
                  onChange={(e) => set('token', e.target.value)}
                />
              )}
            </Field>
          )}
          {form.auth === 'nkey' && (
            <>
              {!fromCli && (
                <Field
                  label="NKey seed"
                  error={show('nkeySeed')}
                  hint={savedHint(stored.nkeySeed) || 'Starts with "S". Or give a seed file below.'}
                >
                  {(fid) => (
                    <Input
                      id={fid}
                      type="password"
                      mono
                      autoComplete="new-password"
                      placeholder={stored.nkeySeed ? '••••••••' : 'SU...'}
                      value={form.nkeySeed}
                      invalid={!!show('nkeySeed')}
                      onChange={(e) => set('nkeySeed', e.target.value)}
                    />
                  )}
                </Field>
              )}
              {pathField('nkeyFile', 'NKey seed file', '/path/to/user.nk')}
            </>
          )}
          {form.auth === 'creds' &&
            pathField('credsFile', 'Credentials file', '/path/to/user.creds', show('credsFile'))}

          {!fromCli &&
            (form.auth === 'userpass' || form.auth === 'token' || form.auth === 'nkey') && (
              <>
                <Checkbox
                  label="Save the secret on this computer"
                  hint="When off, the studio asks for it every time you connect."
                  checked={form.saveSecrets}
                  onChange={(e) => set('saveSecrets', e.target.checked)}
                />
                {appInfo && !appInfo.secretStorage && form.saveSecrets && (
                  <Notice tone="warn">
                    No operating system keychain is available here, so a saved secret would only be
                    lightly protected. Untick the box above to be asked for it on each connect
                    instead.
                  </Notice>
                )}
              </>
            )}
        </fieldset>

        <details
          className="rounded-md border border-line p-3"
          open={Boolean(form.caFile || form.certFile || form.keyFile || form.handshakeFirst)}
        >
          <summary className="cursor-pointer text-xs font-semibold text-muted">TLS</summary>
          <div className="mt-3 flex flex-col gap-3">
            {pathField('caFile', 'CA certificate file', '/path/to/ca.pem')}
            <div className="grid grid-cols-2 gap-3">
              {pathField('certFile', 'Client certificate file', '/path/to/client-cert.pem')}
              {pathField('keyFile', 'Client key file', '/path/to/client-key.pem')}
            </div>
            <Checkbox
              label="TLS-first handshake"
              hint="For servers configured with handshake_first."
              checked={form.handshakeFirst}
              disabled={fromCli}
              onChange={(e) => set('handshakeFirst', e.target.checked)}
            />
          </div>
        </details>

        <details
          className="rounded-md border border-line p-3"
          open={Boolean(form.jsDomain || form.apiPrefix || form.inboxPrefix)}
        >
          <summary className="cursor-pointer text-xs font-semibold text-muted">
            JetStream and inbox options
          </summary>
          <div className="mt-3 grid grid-cols-3 gap-3">
            <Field label="JetStream domain">
              {(fid) => (
                <Input
                  id={fid}
                  mono
                  placeholder="hub"
                  value={form.jsDomain}
                  disabled={fromCli}
                  onChange={(e) => set('jsDomain', e.target.value)}
                />
              )}
            </Field>
            <Field label="API prefix">
              {(fid) => (
                <Input
                  id={fid}
                  mono
                  placeholder="$JS.API"
                  value={form.apiPrefix}
                  disabled={fromCli}
                  onChange={(e) => set('apiPrefix', e.target.value)}
                />
              )}
            </Field>
            <Field label="Inbox prefix">
              {(fid) => (
                <Input
                  id={fid}
                  mono
                  placeholder="_INBOX"
                  value={form.inboxPrefix}
                  disabled={fromCli}
                  onChange={(e) => set('inboxPrefix', e.target.value)}
                />
              )}
            </Field>
          </div>
        </details>

        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">Colour</span>
            <div role="radiogroup" aria-label="Colour" className="flex gap-1.5">
              {CONNECTION_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  role="radio"
                  aria-checked={form.color === color}
                  aria-label={color}
                  onClick={() => set('color', color)}
                  className={cx(
                    'h-6 w-6 rounded-full border-2',
                    form.color === color ? 'border-fg' : 'border-transparent'
                  )}
                  style={{ background: color }}
                />
              ))}
            </div>
          </div>
          <Checkbox
            className="self-end"
            label="Read-only"
            hint="Blocks create, edit, delete, purge and publish on this connection."
            checked={form.readOnly}
            onChange={(e) => {
              setTouchedReadOnly(true)
              set('readOnly', e.target.checked)
            }}
          />
        </div>

        {test &&
          (test.ok ? (
            <Notice tone="ok" className="flex items-start gap-2">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>
                Connected to <strong>{test.serverName}</strong> (NATS {test.version}
                {test.cluster ? `, cluster ${test.cluster}` : ''}) in {test.rttMs} ms.{' '}
                {test.jetstream
                  ? 'JetStream is available.'
                  : `JetStream is not available to this account${test.jetstreamNote ? `: ${test.jetstreamNote}` : '.'}`}
              </span>
            </Notice>
          ) : (
            <Notice tone="danger" className="flex items-start gap-2">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>{test.message}</span>
            </Notice>
          ))}
        <ErrorNote error={error} />
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}
