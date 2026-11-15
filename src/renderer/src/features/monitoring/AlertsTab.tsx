import { useEffect, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { BellOff, BellRing, Pencil, Plus, Trash2 } from 'lucide-react'
import {
  DEFAULT_HEALTH_THRESHOLDS,
  type AlertMetric,
  type AlertRule,
  type HealthThresholds
} from '@shared/api'
import { formatCount, formatTime } from '@shared/format'
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Dialog,
  ErrorNote,
  Field,
  Input,
  Notice,
  Page,
  Select
} from '../../components/ui'
import { useGateway } from '../../gateway'
import { useNow, useRefetchInterval, useSetting, useTabActive } from '../../lib/hooks'
import { useAlertFeed } from '../../state/alerts'
import { toast } from '../../state/toasts'

const METRICS: Record<AlertMetric, { label: string; unit: string; consumer: boolean }> = {
  consumer_pending: { label: 'Consumer pending messages', unit: 'messages', consumer: true },
  consumer_redelivered: {
    label: 'Consumer redelivered messages',
    unit: 'messages',
    consumer: true
  },
  stream_bytes_pct: { label: 'Stream size as a share of its limit', unit: '%', consumer: false }
}

const SNOOZES: [label: string, ms: number][] = [
  ['15 minutes', 15 * 60_000],
  ['1 hour', 60 * 60_000],
  ['8 hours', 8 * 60 * 60_000]
]

function describe(rule: AlertRule): string {
  const m = METRICS[rule.metric]
  const target = m.consumer
    ? `${rule.consumer === '*' ? 'any consumer' : `consumer ${rule.consumer}`} of ${rule.stream === '*' ? 'any stream' : rule.stream}`
    : rule.stream === '*'
      ? 'any stream with a size limit'
      : `stream ${rule.stream}`
  const held = rule.durationSeconds > 0 ? ` for ${rule.durationSeconds} seconds` : ''
  return `${m.label} above ${formatCount(rule.threshold)}${m.unit === '%' ? '%' : ''} on ${target}${held}`
}

/**
 * Alert rules and the alerts fired this session (PBI-081), plus the thresholds that decide when
 * a consumer is flagged as unhealthy (PBI-054).
 */
export function AlertsTab({ connId }: { connId: string }): ReactNode {
  const gateway = useGateway()
  const client = useQueryClient()
  const active = useTabActive()
  const now = useNow(10_000)
  const rules = useQuery({
    queryKey: ['alertRules', connId],
    queryFn: () => gateway.listAlertRules(connId)
  })
  const history = useQuery({
    queryKey: ['alertHistory'],
    queryFn: () => gateway.alertHistory(),
    refetchInterval: useRefetchInterval()
  })
  const [editing, setEditing] = useState<AlertRule | 'new' | null>(null)
  const [permission, setPermission] = useState(
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
  )
  const markSeen = useAlertFeed((s) => s.markSeen)
  const feedCount = useAlertFeed((s) => s.latest.length)

  // Looking at this tab clears the "new alerts" marker.
  useEffect(() => {
    if (active) markSeen(connId)
  }, [active, connId, markSeen, feedCount])
  useEffect(() => {
    void history.refetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedCount])

  const save = async (rule: AlertRule): Promise<void> => {
    await gateway.saveAlertRule(rule)
    await client.invalidateQueries({ queryKey: ['alertRules', connId] })
  }
  // Changes made in the list are shown at once (React state) and then saved; the saved rules
  // replace them when the gateway answers.
  const [edits, setEdits] = useState<Record<string, Partial<AlertRule>>>({})
  const update = (rule: AlertRule, patch: Partial<AlertRule>): void => {
    setEdits((e) => ({ ...e, [rule.id]: { ...e[rule.id], ...patch } }))
    gateway
      .saveAlertRule({ ...rule, ...patch })
      .then(() => client.invalidateQueries({ queryKey: ['alertRules', connId] }))
      .catch((err) => toast.error(err))
      .finally(() =>
        setEdits((e) => {
          const { [rule.id]: _done, ...rest } = e
          return rest
        })
      )
  }
  const fired = (history.data ?? []).filter((a) => a.connId === connId)

  return (
    <Page
      title="Alerts"
      subtitle="Rules are checked every time the studio samples this connection"
      actions={
        <Button
          variant="primary"
          icon={<Plus className="h-4 w-4" aria-hidden />}
          onClick={() => setEditing('new')}
        >
          New rule
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        {permission === 'default' && (
          <Notice className="flex items-center gap-2">
            <span className="mr-auto">
              Allow notifications to be told about alerts while the studio is in the background.
            </span>
            <Button
              size="sm"
              onClick={() => void Notification.requestPermission().then(setPermission)}
            >
              Allow notifications
            </Button>
          </Notice>
        )}
        {permission === 'denied' && (
          <Notice tone="warn">
            Notifications are blocked for this app, so alerts only appear inside the studio.
          </Notice>
        )}

        <Card title={`Rules (${rules.data?.length ?? 0})`}>
          <ErrorNote error={rules.error} />
          {rules.data?.length === 0 && (
            <p className="text-muted">
              No rules yet. A rule fires when a number stays above its threshold, for example a
              consumer with more than 1,000 pending messages for a minute.
            </p>
          )}
          <ul className="flex flex-col">
            {(rules.data ?? []).map((saved) => {
              const rule = { ...saved, ...edits[saved.id] }
              const snoozed = rule.snoozedUntil !== undefined && rule.snoozedUntil > now
              return (
                <li
                  key={rule.id}
                  className="flex flex-wrap items-center gap-2 border-t border-line py-2 first:border-t-0"
                >
                  <div className="mr-auto min-w-0">
                    <p className="flex items-center gap-2 font-medium">
                      {rule.name}
                      {!rule.enabled && <Badge>off</Badge>}
                      {snoozed && (
                        <Badge tone="warn">
                          snoozed until {formatTime(rule.snoozedUntil!).slice(11, 16)}
                        </Badge>
                      )}
                      {rule.notify && <Badge tone="accent">notifies</Badge>}
                    </p>
                    <p className="text-xs text-muted">{describe(rule)}</p>
                  </div>
                  <Checkbox
                    label="On"
                    checked={rule.enabled}
                    onChange={(e) => update(rule, { enabled: e.target.checked })}
                  />
                  {snoozed ? (
                    <Button
                      size="sm"
                      icon={<BellRing className="h-3.5 w-3.5" aria-hidden />}
                      onClick={() => update(rule, { snoozedUntil: undefined })}
                    >
                      End snooze
                    </Button>
                  ) : (
                    <Select
                      className="!h-6 w-32 !text-xs"
                      aria-label={`Snooze ${rule.name}`}
                      value=""
                      onChange={(e) =>
                        e.target.value &&
                        update(rule, { snoozedUntil: Date.now() + Number(e.target.value) })
                      }
                    >
                      <option value="">Snooze...</option>
                      {SNOOZES.map(([label, ms]) => (
                        <option key={ms} value={ms}>
                          {label}
                        </option>
                      ))}
                    </Select>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Edit rule ${rule.name}`}
                    icon={<Pencil className="h-3.5 w-3.5" aria-hidden />}
                    onClick={() => setEditing(rule)}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Delete rule ${rule.name}`}
                    icon={<Trash2 className="h-3.5 w-3.5" aria-hidden />}
                    onClick={() =>
                      void gateway
                        .deleteAlertRule(connId, rule.id)
                        .then(() => client.invalidateQueries({ queryKey: ['alertRules', connId] }))
                    }
                  />
                </li>
              )
            })}
          </ul>
        </Card>

        <Card title={`Fired this session (${fired.length})`}>
          {fired.length === 0 ? (
            <p className="flex items-center gap-2 text-muted">
              <BellOff className="h-4 w-4" aria-hidden /> No alerts have fired since the studio
              started.
            </p>
          ) : (
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="text-left text-muted">
                  <th className="py-1 pr-3 font-semibold">Time</th>
                  <th className="py-1 pr-3 font-semibold">Rule</th>
                  <th className="py-1 pr-3 font-semibold">Target</th>
                  <th className="py-1 pr-3 text-right font-semibold">Value</th>
                  <th className="py-1 text-right font-semibold">Threshold</th>
                </tr>
              </thead>
              <tbody>
                {fired.map((a) => (
                  <tr key={a.id} className="border-t border-line">
                    <td className="tabular py-1 pr-3 whitespace-nowrap">
                      {formatTime(a.time).slice(0, 19)}
                    </td>
                    <td className="py-1 pr-3 font-medium">{a.ruleName}</td>
                    <td className="py-1 pr-3 font-mono">{a.target}</td>
                    <td className="tabular py-1 pr-3 text-right">
                      {formatCount(a.value)}
                      {a.metric === 'stream_bytes_pct' ? '%' : ''}
                    </td>
                    <td className="tabular py-1 text-right">
                      {formatCount(a.threshold)}
                      {a.metric === 'stream_bytes_pct' ? '%' : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <HealthSettings connId={connId} />
      </div>

      {editing && (
        <RuleForm
          connId={connId}
          rule={editing === 'new' ? undefined : editing}
          onSave={save}
          onClose={() => setEditing(null)}
        />
      )}
    </Page>
  )
}

function RuleForm({
  connId,
  rule,
  onSave,
  onClose
}: {
  connId: string
  rule?: AlertRule
  onSave: (rule: AlertRule) => Promise<void>
  onClose: () => void
}): ReactNode {
  const [draft, setDraft] = useState<AlertRule>(
    rule ?? {
      id: '',
      connId,
      name: '',
      metric: 'consumer_pending',
      stream: '*',
      consumer: '*',
      threshold: 1000,
      durationSeconds: 60,
      enabled: true,
      notify: true
    }
  )
  const [threshold, setThreshold] = useState(String(draft.threshold))
  const [duration, setDuration] = useState(String(draft.durationSeconds))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const set = <K extends keyof AlertRule>(key: K, value: AlertRule[K]): void =>
    setDraft((d) => ({ ...d, [key]: value }))
  const metric = METRICS[draft.metric]
  const thresholdError = !/^\d+(\.\d+)?$/.test(threshold.trim()) ? 'Enter a number' : null
  const durationError = !/^\d+$/.test(duration.trim())
    ? 'Enter whole seconds, 0 to fire immediately'
    : null
  const valid = draft.name.trim() && !thresholdError && !durationError

  const submit = async (): Promise<void> => {
    if (!valid) return
    setBusy(true)
    setError(null)
    try {
      await onSave({ ...draft, threshold: Number(threshold), durationSeconds: Number(duration) })
      onClose()
    } catch (err) {
      setError(err)
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={rule ? `Edit rule ${rule.name}` : 'New alert rule'}
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} disabled={!valid} onClick={() => void submit()}>
            Save rule
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <Field label="Name">
          {(id) => (
            <Input
              id={id}
              autoFocus
              placeholder="Billing is falling behind"
              value={draft.name}
              onChange={(e) => set('name', e.target.value)}
            />
          )}
        </Field>
        <Field label="Watch">
          {(id) => (
            <Select
              id={id}
              value={draft.metric}
              onChange={(e) => set('metric', e.target.value as AlertMetric)}
            >
              {(Object.keys(METRICS) as AlertMetric[]).map((m) => (
                <option key={m} value={m}>
                  {METRICS[m].label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Stream" hint="* for every stream">
            {(id) => (
              <Input
                id={id}
                mono
                value={draft.stream}
                onChange={(e) => set('stream', e.target.value)}
              />
            )}
          </Field>
          {metric.consumer && (
            <Field label="Consumer" hint="* for every consumer">
              {(id) => (
                <Input
                  id={id}
                  mono
                  value={draft.consumer}
                  onChange={(e) => set('consumer', e.target.value)}
                />
              )}
            </Field>
          )}
          <Field label={`Fire above (${metric.unit})`} error={thresholdError}>
            {(id) => (
              <Input
                id={id}
                inputMode="decimal"
                invalid={!!thresholdError}
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
              />
            )}
          </Field>
          <Field
            label="For at least (seconds)"
            error={durationError}
            hint="How long it must stay above before firing."
          >
            {(id) => (
              <Input
                id={id}
                inputMode="numeric"
                invalid={!!durationError}
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
              />
            )}
          </Field>
        </div>
        {draft.metric === 'stream_bytes_pct' && (
          <p className="text-xs text-muted">
            Only streams with a max bytes limit have a share to measure; unlimited streams are
            ignored.
          </p>
        )}
        <Checkbox
          label="Show a desktop notification"
          hint="The alert always appears in the studio. Notifications need permission from the operating system."
          checked={draft.notify}
          onChange={(e) => set('notify', e.target.checked)}
        />
        <ErrorNote error={error} />
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}

/** Thresholds for the "needs attention" badges on consumers. */
function HealthSettings({ connId }: { connId: string }): ReactNode {
  const client = useQueryClient()
  const [stored, setStored, loaded] = useSetting<Partial<HealthThresholds>>(
    `conn:${connId}:health`,
    {}
  )
  const [draft, setDraft] = useState<Record<keyof HealthThresholds, string> | null>(null)
  const current = { ...DEFAULT_HEALTH_THRESHOLDS, ...stored }
  const values = draft ?? {
    lagSamples: String(current.lagSamples),
    redelivered: String(current.redelivered),
    stalledSeconds: String(current.stalledSeconds)
  }
  const fields: [keyof HealthThresholds, string, string][] = [
    [
      'lagSamples',
      'Lag keeps growing',
      'Flag when pending grew in each of this many samples in a row.'
    ],
    [
      'redelivered',
      'Many redeliveries',
      'Flag when more than this many messages were redelivered.'
    ],
    [
      'stalledSeconds',
      'Pending but inactive',
      'Flag when messages are pending and nothing happened for this many seconds.'
    ]
  ]
  const valid = Object.values(values).every((v) => /^\d+$/.test(v.trim()) && Number(v) >= 1)

  return (
    <Card title="Consumer health thresholds">
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (!valid) return
          setStored({
            lagSamples: Number(values.lagSamples),
            redelivered: Number(values.redelivered),
            stalledSeconds: Number(values.stalledSeconds)
          })
          setDraft(null)
          void client.invalidateQueries({ queryKey: ['consumers', connId] })
          void client.invalidateQueries({ queryKey: ['healthSummary', connId] })
          toast.ok('Saved health thresholds')
        }}
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {fields.map(([key, label, hint]) => (
            <Field
              key={key}
              label={label}
              hint={hint}
              error={
                /^\d+$/.test(values[key].trim()) && Number(values[key]) >= 1
                  ? null
                  : 'Enter a whole number, 1 or more'
              }
            >
              {(id) => (
                <Input
                  id={id}
                  inputMode="numeric"
                  disabled={!loaded}
                  value={values[key]}
                  onChange={(e) => setDraft({ ...values, [key]: e.target.value })}
                />
              )}
            </Field>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Button type="submit" disabled={!draft || !valid}>
            Save thresholds
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setStored({})
              setDraft(null)
            }}
          >
            Reset to defaults
          </Button>
          <span className="text-xs text-muted">
            A consumer whose ack pending is at its maximum, or that has no leader, is always
            flagged.
          </span>
        </div>
      </form>
    </Card>
  )
}
