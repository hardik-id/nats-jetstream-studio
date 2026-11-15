/** NATS configuration uses nanoseconds. These helpers convert to and from text like "1h30m". */

const NS: Record<string, number> = {
  ns: 1,
  us: 1e3,
  ms: 1e6,
  s: 1e9,
  m: 60e9,
  h: 3600e9,
  d: 86400e9
}

/** Parses "90s", "1h30m", "2d" or a bare number of seconds. Returns null when it cannot be parsed. */
export function parseDuration(text: string): number | null {
  const input = text.trim().toLowerCase()
  if (input === '' || input === '0') return 0
  if (/^\d+(\.\d+)?$/.test(input)) return Math.round(Number(input) * NS.s)
  const pattern = /(\d+(?:\.\d+)?)(ns|us|ms|s|m|h|d)/g
  let total = 0
  let consumed = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(input)) !== null) {
    if (match.index !== consumed) return null
    total += Number(match[1]) * NS[match[2]]
    consumed = pattern.lastIndex
  }
  if (consumed !== input.length || consumed === 0) return null
  return Math.round(total)
}

/** Formats nanoseconds as text that parseDuration reads back to the same value, e.g. "1h30m". */
export function formatDuration(ns: number | undefined | null): string {
  if (ns === undefined || ns === null || ns <= 0) return '0'
  let rest = Math.round(ns)
  const parts: string[] = []
  for (const unit of ['d', 'h', 'm', 's', 'ms', 'us', 'ns'] as const) {
    const n = Math.floor(rest / NS[unit])
    if (n > 0) {
      parts.push(`${n}${unit}`)
      rest -= n * NS[unit]
    }
  }
  return parts.join('')
}

export function nsToMs(ns: number): number {
  return ns / 1e6
}

export function msToNs(ms: number): number {
  return Math.round(ms * 1e6)
}
