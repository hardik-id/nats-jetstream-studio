import { MINUTE, type TraceQuery, type TraceRule } from '@shared/trace'
import { useTabs } from '../../state/tabs'

/** Half the window "Follow this value" starts with: 15 minutes either side of the message. */
export const FOLLOW_WINDOW_MS = 15 * MINUTE

/** The trace for "follow this value" on a message stored at `time`. */
export function followQuery(rule: TraceRule, time: string | number): TraceQuery {
  return {
    rules: [rule],
    window: { kind: 'around', anchor: new Date(time).toISOString(), ms: FOLLOW_WINDOW_MS }
  }
}

/** Opens a new Trace tab that follows the value of an open message, and runs it. */
export function followValue(connId: string, rule: TraceRule, time: string | number): void {
  useTabs.getState().openNew({ kind: 'trace', connId, query: followQuery(rule, time) })
}
