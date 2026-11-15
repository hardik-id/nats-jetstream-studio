import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { formatTime } from '@shared/format'

export interface LineChartProps {
  title: string
  /** Epoch ms of each sample. */
  t: number[]
  values: number[]
  /** Sampling interval; a longer gap between samples breaks the line instead of bridging it. */
  intervalMs: number
  /** The time window shown, so charts side by side share one x axis. */
  from: number
  to: number
  /** Formats the headline value and, unless `formatTick` is given, the axis labels. */
  format?: (value: number) => string
  /** Formats axis labels. One style for the whole axis. */
  formatTick?: (value: number) => string
  /** Chooses the axis ticks for a maximum; defaults to round decimal steps. */
  ticksFor?: (max: number) => number[]
  height?: number
}

const PAD = { top: 8, right: 12, bottom: 20 }

/** Rounds a maximum up to a clean number and returns evenly spaced ticks from zero. */
export function niceTicks(max: number, count = 3): number[] {
  if (!(max > 0)) return [0, 1]
  const rough = max / count
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const step =
    [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ?? 10 * magnitude
  const ticks: number[] = []
  for (let v = 0; v < max + step - 1e-9; v += step) ticks.push(Number(v.toPrecision(12)))
  return ticks
}

/** Ticks at round binary sizes (512 KiB, 1 MiB, 2 MiB...) for an axis of bytes. */
export function byteTicks(max: number): number[] {
  if (!(max > 0)) return [0, 1024]
  const unit = 1024 ** Math.min(4, Math.floor(Math.log(max) / Math.log(1024)))
  return niceTicks(max / unit).map((v) => v * unit)
}

/** "2 MiB" rather than "2.00 MiB": axis labels do not need the padding digits. */
export function byteTick(value: number): string {
  if (value === 0) return '0'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  const power = Math.min(4, Math.floor(Math.log(value) / Math.log(1024)))
  return `${Number((value / 1024 ** power).toFixed(2))} ${units[power]}`
}

export function compactNumber(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1e9) return `${trim(value / 1e9)}B`
  if (abs >= 1e6) return `${trim(value / 1e6)}M`
  if (abs >= 1e4) return `${trim(value / 1e3)}K`
  return Number.isInteger(value) ? value.toLocaleString('en-US') : trim(value)
}
const trim = (n: number): string => Number(n.toFixed(n < 10 ? 2 : 1)).toString()

function compactAlways(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1e9) return `${trim(value / 1e9)}B`
  if (abs >= 1e6) return `${trim(value / 1e6)}M`
  return `${trim(value / 1e3)}K`
}

const clock = (ms: number): string => formatTime(ms).slice(11, 19)

/**
 * One measure over time: a single 2px line on a zero baseline, with a crosshair that snaps to
 * the nearest sample. One chart shows one measure; measures with different scales get their own
 * chart next to it rather than a second axis.
 */
export function LineChart({
  title,
  t,
  values,
  intervalMs,
  from,
  to,
  format = compactNumber,
  formatTick,
  ticksFor = niceTicks,
  height = 132
}: LineChartProps): ReactNode {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(360)
  const [hover, setHover] = useState<number | null>(null)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const measure = (): void => setWidth(Math.max(200, el.clientWidth))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const ticks = useMemo(() => ticksFor(Math.max(0, ...values)), [values, ticksFor])
  const yMax = ticks[ticks.length - 1]
  // One style per axis: on an axis that reaches 10,000 every label is compact (5K, 10K).
  const tickLabel =
    formatTick ??
    ((v: number): string =>
      yMax >= 10_000 ? (v === 0 ? '0' : compactAlways(v)) : v.toLocaleString('en-US'))
  const labels = ticks.map(tickLabel)
  // Room for the widest label, so none is cut off.
  const left = Math.max(32, Math.max(...labels.map((l) => l.length)) * 5.8 + 12)
  const plotW = width - left - PAD.right
  const plotH = height - PAD.top - PAD.bottom
  const x = (ms: number): number => left + ((ms - from) / Math.max(1, to - from)) * plotW
  const y = (v: number): number => PAD.top + plotH - (v / yMax) * plotH

  // Split into runs wherever sampling stopped (a disconnect), so the gap stays visible.
  const runs = useMemo(() => {
    const out: number[][] = []
    let run: number[] = []
    for (let i = 0; i < t.length; i++) {
      if (t[i] < from) continue
      if (run.length && t[i] - t[run[run.length - 1]] > intervalMs * 2.5) {
        out.push(run)
        run = []
      }
      run.push(i)
    }
    if (run.length) out.push(run)
    return out
  }, [t, from, intervalMs])

  const visible = runs.flat()
  const last = visible.length ? visible[visible.length - 1] : -1
  const active = hover !== null && visible.includes(hover) ? hover : null
  const shown = active ?? last

  const nearest = (clientX: number, rect: DOMRect): number | null => {
    if (!visible.length) return null
    const ms = from + ((clientX - rect.left - left) / plotW) * (to - from)
    let best = visible[0]
    for (const i of visible) if (Math.abs(t[i] - ms) < Math.abs(t[best] - ms)) best = i
    return best
  }

  const step = (delta: number): void => {
    if (!visible.length) return
    const at = active === null ? visible.length - 1 : visible.indexOf(active)
    setHover(visible[Math.min(visible.length - 1, Math.max(0, at + delta))])
  }

  return (
    <figure className="m-0 min-w-0">
      <figcaption className="flex items-baseline justify-between gap-2 pb-1">
        <span className="text-xs font-medium text-muted">{title}</span>
        <span className="tabular text-sm font-semibold" data-testid="chart-latest">
          {shown >= 0 ? format(values[shown]) : '-'}
          {active !== null && (
            <span className="ml-1.5 text-xs font-normal text-muted">at {clock(t[active])}</span>
          )}
        </span>
      </figcaption>
      <div
        ref={wrapRef}
        tabIndex={0}
        role="img"
        aria-label={`${title}. ${visible.length} samples. Latest value ${last >= 0 ? format(values[last]) : 'none'}. Use the arrow keys to read values.`}
        className="relative rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent"
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') {
            e.preventDefault()
            step(-1)
          } else if (e.key === 'ArrowRight') {
            e.preventDefault()
            step(1)
          } else if (e.key === 'Escape') {
            setHover(null)
          }
        }}
        onBlur={() => setHover(null)}
      >
        {visible.length < 2 ? (
          <div className="flex items-center justify-center text-xs text-faint" style={{ height }}>
            {visible.length === 0
              ? 'Collecting samples...'
              : 'One sample so far. The line appears with the next one.'}
          </div>
        ) : (
          <svg
            width={width}
            height={height}
            className="block"
            onPointerMove={(e) =>
              setHover(nearest(e.clientX, e.currentTarget.getBoundingClientRect()))
            }
            onPointerLeave={() => setHover(null)}
          >
            {ticks.map((tick, i) => (
              <g key={tick}>
                <line
                  x1={left}
                  x2={width - PAD.right}
                  y1={y(tick)}
                  y2={y(tick)}
                  stroke={tick === 0 ? 'var(--chart-axis)' : 'var(--chart-grid)'}
                  strokeWidth={1}
                />
                <text
                  x={left - 6}
                  y={y(tick) + 3.5}
                  textAnchor="end"
                  fontSize={10}
                  fill="var(--faint)"
                  className="tabular"
                >
                  {labels[i]}
                </text>
              </g>
            ))}
            <text x={left} y={height - 5} fontSize={10} fill="var(--faint)" className="tabular">
              {clock(from)}
            </text>
            <text
              x={width - PAD.right}
              y={height - 5}
              textAnchor="end"
              fontSize={10}
              fill="var(--faint)"
              className="tabular"
            >
              {clock(to)}
            </text>

            {runs.map((run, i) => {
              const line = run
                .map(
                  (idx, j) => `${j ? 'L' : 'M'}${x(t[idx]).toFixed(1)},${y(values[idx]).toFixed(1)}`
                )
                .join(' ')
              const first = x(t[run[0]]).toFixed(1)
              const end = x(t[run[run.length - 1]]).toFixed(1)
              return (
                <g key={i}>
                  {run.length > 1 && (
                    <path
                      d={`${line} L${end},${y(0)} L${first},${y(0)} Z`}
                      fill="var(--series-1)"
                      opacity={0.1}
                    />
                  )}
                  <path
                    d={line}
                    fill="none"
                    stroke="var(--series-1)"
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                </g>
              )
            })}

            {active !== null && (
              <line
                x1={x(t[active])}
                x2={x(t[active])}
                y1={PAD.top}
                y2={PAD.top + plotH}
                stroke="var(--chart-axis)"
                strokeWidth={1}
              />
            )}
            {shown >= 0 && (
              <circle
                cx={x(t[shown])}
                cy={y(values[shown])}
                r={4}
                fill="var(--series-1)"
                stroke="var(--panel)"
                strokeWidth={2}
              />
            )}
          </svg>
        )}
      </div>
    </figure>
  )
}
