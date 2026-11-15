import { create } from 'zustand'
import type { AlertEvent } from '@shared/api'
import { toast } from './toasts'

interface AlertFeed {
  /** Alerts fired since the alerts tab of that connection was last looked at. */
  unseen: Record<string, number>
  latest: AlertEvent[]
  add(alert: AlertEvent): void
  markSeen(connId: string): void
}

/** Alerts as they arrive: a badge in the UI, and a desktop notification when the rule asks for one. */
export const useAlertFeed = create<AlertFeed>((set, get) => ({
  unseen: {},
  latest: [],
  add(alert) {
    set({
      unseen: { ...get().unseen, [alert.connId]: (get().unseen[alert.connId] ?? 0) + 1 },
      latest: [alert, ...get().latest].slice(0, 200)
    })
    const text = `${alert.ruleName}: ${alert.target} is at ${alert.value} (threshold ${alert.threshold})`
    toast.info(`Alert: ${text}`)
    if (
      alert.notify &&
      typeof Notification !== 'undefined' &&
      Notification.permission === 'granted'
    ) {
      try {
        new Notification('NATS JetStream Studio alert', { body: text, tag: alert.ruleId })
      } catch {
        // Notifications are best effort.
      }
    }
  },
  markSeen(connId) {
    if (get().unseen[connId]) set({ unseen: { ...get().unseen, [connId]: 0 } })
  }
}))
