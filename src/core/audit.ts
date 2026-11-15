import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AuditEntry, AuditQuery } from '@shared/api'
import { currentUser } from './context'

export const DEFAULT_AUDIT_RETENTION_DAYS = 90

/**
 * A local record of every change made from the studio (PBI-092).
 * One JSON object per line. Payloads and secrets are never passed in, so they cannot end up here.
 */
export class AuditLog {
  private readonly path: string

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true })
    this.path = join(dataDir, 'audit.ndjson')
  }

  record(entry: Omit<AuditEntry, 'time'>): void {
    const user = currentUser()
    const line: AuditEntry = {
      time: new Date().toISOString(),
      ...entry,
      ...(user ? { user: user.email ?? user.name } : {})
    }
    try {
      appendFileSync(this.path, JSON.stringify(line) + '\n', { mode: 0o600 })
    } catch {
      // Losing an audit line must never break the action itself.
    }
  }

  private readAll(): AuditEntry[] {
    if (!existsSync(this.path)) return []
    const out: AuditEntry[] = []
    for (const line of readFileSync(this.path, 'utf8').split('\n')) {
      if (!line) continue
      try {
        out.push(JSON.parse(line))
      } catch {
        // Skip a damaged line.
      }
    }
    return out
  }

  /** Newest first. */
  list(query: AuditQuery = {}): AuditEntry[] {
    const text = query.text?.trim().toLowerCase()
    const matches = this.readAll().filter((e) => {
      if (query.connId && e.connId !== query.connId) return false
      if (query.result && e.result !== query.result) return false
      if (text) {
        const haystack =
          `${e.connName} ${e.action} ${e.target} ${e.detail ?? ''} ${e.user ?? ''}`.toLowerCase()
        if (!haystack.includes(text)) return false
      }
      return true
    })
    matches.reverse()
    return matches.slice(0, query.limit ?? 1000)
  }

  toCsv(query: AuditQuery = {}): string {
    const cell = (v: string | undefined): string => {
      const s = v ?? ''
      // Quote everything and neutralise formulas so the file is safe to open in a spreadsheet.
      const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
      return `"${safe.replace(/"/g, '""')}"`
    }
    const rows = this.list({ ...query, limit: query.limit ?? 100_000 }).map((e) =>
      [e.time, e.connName, e.action, e.target, e.result, e.detail, e.user].map(cell).join(',')
    )
    return (
      ['"time","connection","action","target","result","detail","user"', ...rows].join('\n') + '\n'
    )
  }

  /** Drops entries older than the retention period. Returns how many were removed. */
  prune(retentionDays: number, now = Date.now()): number {
    const all = this.readAll()
    const cutoff = now - retentionDays * 86_400_000
    const kept = all.filter((e) => new Date(e.time).getTime() >= cutoff)
    if (kept.length !== all.length) {
      writeFileSync(
        this.path,
        kept.map((e) => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : ''),
        { mode: 0o600 }
      )
    }
    return all.length - kept.length
  }
}
