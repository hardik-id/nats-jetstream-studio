import type { ConsumerInfoDto, HealthFlag, HealthThresholds } from './api'
import { isZeroTime } from './format'

export interface ConsumerSample {
  t: number
  pending: number
  ackPending: number
  redelivered: number
}

/**
 * Decides which problems a consumer has (PBI-054).
 * `samples` is the consumer's recent history, oldest first; it may be empty.
 */
export function evaluateConsumerHealth(
  info: ConsumerInfoDto,
  samples: ConsumerSample[],
  thresholds: HealthThresholds,
  now: number
): HealthFlag[] {
  const flags: HealthFlag[] = []

  if (samples.length > thresholds.lagSamples) {
    const recent = samples.slice(-(thresholds.lagSamples + 1))
    let growing = true
    for (let i = 1; i < recent.length; i++) {
      if (recent[i].pending <= recent[i - 1].pending) {
        growing = false
        break
      }
    }
    if (growing) flags.push('lag_growing')
  }

  if (info.num_redelivered > thresholds.redelivered) flags.push('redeliveries')

  if (!info.paused && (info.num_pending > 0 || info.num_ack_pending > 0)) {
    const lastActive = lastActivity(info)
    if (lastActive !== null && now - lastActive > thresholds.stalledSeconds * 1000)
      flags.push('stalled')
  }

  const maxAckPending = info.config.max_ack_pending ?? 0
  if (maxAckPending > 0 && info.num_ack_pending >= maxAckPending) flags.push('ack_pending_max')

  const replicas = info.cluster?.replicas?.length ?? 0
  if (info.cluster && replicas > 0 && !info.cluster.leader) flags.push('no_leader')

  return flags
}

function lastActivity(info: ConsumerInfoDto): number | null {
  const times = [info.delivered?.last_active, info.ack_floor?.last_active, info.created]
    .filter((t): t is string => !!t && !isZeroTime(t))
    .map((t) => new Date(t).getTime())
    .filter((t) => !Number.isNaN(t))
  return times.length ? Math.max(...times) : null
}

export const HEALTH_LABELS: Record<HealthFlag, string> = {
  lag_growing: 'Lag keeps growing',
  redeliveries: 'Many redeliveries',
  stalled: 'Pending but inactive',
  ack_pending_max: 'Ack pending at maximum',
  no_leader: 'No leader'
}
