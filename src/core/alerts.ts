import { randomUUID } from 'node:crypto'
import type { AlertEvent, AlertRule, ConsumerInfoDto, StreamInfoDto } from '@shared/api'
import { gatewayError } from './errors'
import type { SettingsStore } from './settings'

const HISTORY_LIMIT = 500
const rulesKey = (connId: string): string => `conn:${connId}:alerts`

/**
 * Evaluates alert rules against each metrics sample (PBI-081).
 * A rule fires once when its condition has held for the rule's duration, and can fire again only
 * after the condition has cleared.
 */
export class AlertEngine {
  readonly history: AlertEvent[] = []
  private readonly active = new Map<string, { since: number; fired: boolean }>()

  constructor(
    private readonly settings: SettingsStore,
    private readonly emit: (alert: AlertEvent) => void
  ) {}

  rules(connId: string): AlertRule[] {
    return this.settings.get<AlertRule[]>(rulesKey(connId)) ?? []
  }

  save(rule: AlertRule): AlertRule {
    if (!rule.name?.trim()) throw gatewayError('validation', 'Rule name is required')
    if (!Number.isFinite(rule.threshold))
      throw gatewayError('validation', 'Threshold must be a number')
    if (!(rule.durationSeconds >= 0))
      throw gatewayError('validation', 'Duration cannot be negative')
    const next: AlertRule = {
      ...rule,
      id: rule.id || randomUUID(),
      name: rule.name.trim(),
      stream: rule.stream?.trim() || '*',
      consumer: rule.consumer?.trim() || '*'
    }
    const rules = this.rules(rule.connId).filter((r) => r.id !== next.id)
    rules.push(next)
    this.settings.set(rulesKey(rule.connId), rules)
    this.clearRule(next.id)
    return next
  }

  delete(connId: string, ruleId: string): void {
    this.settings.set(
      rulesKey(connId),
      this.rules(connId).filter((r) => r.id !== ruleId)
    )
    this.clearRule(ruleId)
  }

  private clearRule(ruleId: string): void {
    for (const k of this.active.keys()) if (k.startsWith(`${ruleId}|`)) this.active.delete(k)
  }

  evaluate(
    connId: string,
    streams: StreamInfoDto[],
    consumers: ConsumerInfoDto[],
    now: number
  ): AlertEvent[] {
    const fired: AlertEvent[] = []
    for (const rule of this.rules(connId)) {
      if (!rule.enabled) {
        this.clearRule(rule.id)
        continue
      }
      const snoozed = rule.snoozedUntil !== undefined && now < rule.snoozedUntil
      const seen = new Set<string>()

      for (const [target, value] of this.measure(rule, streams, consumers)) {
        const k = `${rule.id}|${target}`
        seen.add(k)
        if (value <= rule.threshold) {
          this.active.delete(k)
          continue
        }
        let state = this.active.get(k)
        if (!state) this.active.set(k, (state = { since: now, fired: false }))
        if (state.fired || snoozed || now - state.since < rule.durationSeconds * 1000) continue
        state.fired = true
        const alert: AlertEvent = {
          id: randomUUID(),
          ruleId: rule.id,
          ruleName: rule.name,
          connId,
          metric: rule.metric,
          target,
          value,
          threshold: rule.threshold,
          time: now,
          notify: rule.notify
        }
        fired.push(alert)
        this.history.unshift(alert)
        if (this.history.length > HISTORY_LIMIT) this.history.length = HISTORY_LIMIT
        this.emit(alert)
      }

      // Targets that disappeared (a deleted consumer) should not stay "active" forever.
      for (const k of this.active.keys()) {
        if (k.startsWith(`${rule.id}|`) && !seen.has(k)) this.active.delete(k)
      }
    }
    return fired
  }

  private measure(
    rule: AlertRule,
    streams: StreamInfoDto[],
    consumers: ConsumerInfoDto[]
  ): [target: string, value: number][] {
    const streamMatches = (name: string): boolean => rule.stream === '*' || rule.stream === name
    if (rule.metric === 'stream_bytes_pct') {
      const out: [string, number][] = []
      for (const s of streams) {
        const max = s.config.max_bytes ?? -1
        if (!streamMatches(s.config.name) || max <= 0) continue
        out.push([s.config.name, Math.round((s.state.bytes / max) * 1000) / 10])
      }
      return out
    }
    const out: [string, number][] = []
    for (const c of consumers) {
      if (!streamMatches(c.stream_name)) continue
      if (rule.consumer !== '*' && rule.consumer !== c.name) continue
      out.push([
        `${c.stream_name} > ${c.name}`,
        rule.metric === 'consumer_pending' ? c.num_pending : c.num_redelivered
      ])
    }
    return out
  }
}
