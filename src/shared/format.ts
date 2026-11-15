export function formatBytes(bytes: number | undefined | null): string {
  if (bytes === undefined || bytes === null || Number.isNaN(bytes)) return '-'
  if (bytes < 0) return 'unlimited'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[unit]}`
}

export function formatCount(n: number | undefined | null): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '-'
  return n.toLocaleString('en-US')
}

/** NATS limits use -1 (and sometimes 0) for "no limit". */
export function formatLimit(n: number | undefined | null, asBytes = false): string {
  if (n === undefined || n === null || n <= 0) return 'unlimited'
  return asBytes ? formatBytes(n) : formatCount(n)
}

/** "0001-01-01T00:00:00Z" is how the server writes "never". */
export function isZeroTime(iso: string | undefined | null): boolean {
  return !iso || iso.startsWith('0001-01-01')
}

export function formatTime(iso: string | number | undefined | null): string {
  if (iso === undefined || iso === null) return '-'
  if (typeof iso === 'string' && isZeroTime(iso)) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '-'
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  )
}

export function formatAgo(iso: string | number | undefined | null, now = Date.now()): string {
  if (iso === undefined || iso === null) return '-'
  if (typeof iso === 'string' && isZeroTime(iso)) return 'never'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return '-'
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 2) return 'just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export function formatRate(perSecond: number): string {
  if (!Number.isFinite(perSecond)) return '-'
  if (perSecond >= 100) return `${Math.round(perSecond).toLocaleString('en-US')}/s`
  if (perSecond >= 10) return `${perSecond.toFixed(1)}/s`
  return `${perSecond.toFixed(2)}/s`
}

const BYTE_UNITS: Record<string, number> = {
  b: 1,
  k: 1024,
  kb: 1024,
  kib: 1024,
  m: 1024 ** 2,
  mb: 1024 ** 2,
  mib: 1024 ** 2,
  g: 1024 ** 3,
  gb: 1024 ** 3,
  gib: 1024 ** 3,
  t: 1024 ** 4,
  tb: 1024 ** 4,
  tib: 1024 ** 4
}

/** Parses "512", "10MB", "1.5 GiB". Units are binary (1 KB = 1024 bytes). Returns null when invalid. */
export function parseBytes(text: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(text)
  if (!m) return null
  const unit = BYTE_UNITS[m[2].toLowerCase() || 'b']
  if (!unit) return null
  return Math.round(Number(m[1]) * unit)
}

/** Writes a byte count so that parseBytes returns exactly the same number. */
export function bytesToInput(bytes: number): string {
  for (const [unit, size] of [
    ['GiB', 1024 ** 3],
    ['MiB', 1024 ** 2],
    ['KiB', 1024]
  ] as const) {
    if (bytes >= size && bytes % size === 0) return `${bytes / size}${unit}`
  }
  return String(bytes)
}
