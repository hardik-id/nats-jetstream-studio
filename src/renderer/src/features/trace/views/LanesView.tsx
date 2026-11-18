import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref
} from 'react'
import { formatCount, formatTime } from '@shared/format'
import {
  DOT_RADIUS,
  LANE_HEIGHT,
  laneY,
  layoutLanes,
  linkShape,
  neighbourInLane,
  type LanesLayout
} from '../model/lanes'
import { formatSpan, type TraceHop } from '../model/trace'
import { laneOptions } from './lanesSettings'
import type { TraceViewProps } from './types'

/** At most this many messages are drawn; the Timeline lists all of them. */
export const MAX_LANE_MESSAGES = 1000

const LABEL_WIDTH = 220
const AXIS_HEIGHT = 40
/** Space kept between a selected dot and the edge of the visible area when it is scrolled in. */
const SCROLL_MARGIN = 72
/** A gap label needs this much room per character, in pixels, and some for the dots. */
const CHAR_WIDTH = 6.4

const gapText = (hop: TraceHop): string | null =>
  hop.gapMs === null ? null : formatSpan(hop.gapMs)

/** The text of a dot for assistive technology: what a sighted reader gets from the picture. */
function dotName(hop: TraceHop, time: string, slowest: boolean): string {
  const gap = gapText(hop)
  const when = gap === null ? 'first message' : `+${gap} after the previous message`
  return `${hop.message.subject}, ${hop.message.stream}, ${time}, ${when}${slowest ? ', slowest hop' : ''}`
}

/**
 * Lanes (PBI-138 phase 2): one lane per subject (or stream), a dot per message, and an arrow from
 * each message to the next in time. Own SVG. The lane labels stay at the left and the axis at
 * the top while the drawing scrolls. One tab stop: Left and Right move through the messages in
 * time order, Up and Down to the nearest message of the next lane, Home and End to the first and
 * last, Enter opens the detail (as in the Timeline, arrows only select).
 */
export function LanesView({
  trace,
  selected,
  onSelect,
  onOpen,
  settings
}: TraceViewProps): ReactNode {
  const uid = useId().replace(/:/g, '')
  const { by, scale, group } = laneOptions(settings)
  const hops = useMemo(
    () =>
      trace.hops.length > MAX_LANE_MESSAGES ? trace.hops.slice(0, MAX_LANE_MESSAGES) : trace.hops,
    [trace.hops]
  )
  const layout = useMemo(
    () => layoutLanes({ hops }, { by, scale, group }),
    [hops, by, scale, group]
  )
  const oneDay = useMemo(
    () => new Set(hops.map((h) => formatTime(h.message.time).slice(0, 10))).size <= 1,
    [hops]
  )
  const timeOf = (h: TraceHop): string => {
    const text = formatTime(h.message.time)
    return oneDay ? text.slice(11) : text
  }

  const [hover, setHover] = useState<number | null>(null)
  const [focused, setFocused] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const tooltip = useRef<HTMLDivElement>(null)
  const selectedIndex = selected === null ? -1 : layout.dots.findIndex((d) => d.id === selected)
  const shownIndex = hover ?? (focused && selectedIndex >= 0 ? selectedIndex : null)

  // Keeps the selected dot visible, clear of the sticky labels and axis, also when the area
  // changes size (the detail pane opening narrows it).
  useEffect(() => {
    const el = box.current
    if (!el) return
    const reveal = (): void => {
      if (selectedIndex < 0 || el.clientWidth === 0) return
      const dot = layout.dots[selectedIndex]
      const x = LABEL_WIDTH + dot.x
      const y = AXIS_HEIGHT + laneY(dot.lane)
      if (x - SCROLL_MARGIN < el.scrollLeft + LABEL_WIDTH) {
        el.scrollLeft = Math.max(0, x - LABEL_WIDTH - SCROLL_MARGIN)
      } else if (x + SCROLL_MARGIN > el.scrollLeft + el.clientWidth) {
        el.scrollLeft = x + SCROLL_MARGIN - el.clientWidth
      }
      if (y - LANE_HEIGHT < el.scrollTop + AXIS_HEIGHT) {
        el.scrollTop = Math.max(0, y - AXIS_HEIGHT - LANE_HEIGHT)
      } else if (y + LANE_HEIGHT > el.scrollTop + el.clientHeight) {
        el.scrollTop = y + LANE_HEIGHT - el.clientHeight
      }
    }
    reveal()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(reveal)
    observer.observe(el)
    return () => observer.disconnect()
  }, [selectedIndex, layout])

  // Puts the tooltip next to its dot, inside the visible part of the drawing: above the dot, or
  // below when there is no room above. It changes the element's style only (no state).
  useLayoutEffect(() => {
    const el = box.current
    const tip = tooltip.current
    if (!el || !tip || shownIndex === null || el.clientWidth === 0) return
    const dot = layout.dots[shownIndex]
    const y = laneY(dot.lane)
    const reach = DOT_RADIUS + 10
    const visibleWidth = el.clientWidth - LABEL_WIDTH
    const left = Math.min(dot.x - 24, el.scrollLeft + visibleWidth - tip.offsetWidth - 8)
    tip.style.left = `${Math.max(el.scrollLeft + 8, left)}px`
    const above = y - reach - tip.offsetHeight >= el.scrollTop
    tip.style.top = `${above ? y - reach - tip.offsetHeight : y + reach}px`
  }, [shownIndex, layout])

  const move = (index: number | null): void => {
    if (index !== null && layout.dots[index]) onSelect(layout.dots[index].id)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.ctrlKey || e.altKey || e.metaKey) return
    const last = layout.dots.length - 1
    const from = selectedIndex
    let handled = true
    switch (e.key) {
      case 'ArrowRight':
        move(from < 0 ? 0 : Math.min(last, from + 1))
        break
      case 'ArrowLeft':
        move(from < 0 ? 0 : Math.max(0, from - 1))
        break
      case 'ArrowDown':
        move(from < 0 ? 0 : (neighbourInLane(layout, from, 1) ?? from))
        break
      case 'ArrowUp':
        move(from < 0 ? 0 : (neighbourInLane(layout, from, -1) ?? from))
        break
      case 'Home':
        move(0)
        break
      case 'End':
        move(last)
        break
      case 'Enter':
        if (from >= 0) onOpen(layout.dots[from].id)
        break
      default:
        handled = false
    }
    if (handled) e.preventDefault()
  }

  const slowestHop = layout.slowest === null ? null : hops[layout.slowest]
  const summaryId = `${uid}-summary`
  const bodyHeight = layout.lanes.length * LANE_HEIGHT
  const clipped = trace.hops.length - hops.length

  return (
    <div className="flex h-full min-h-0 flex-col">
      <p id={summaryId} className="border-b border-line px-4 py-1.5 text-xs text-muted">
        {formatCount(hops.length)} {hops.length === 1 ? 'message' : 'messages'} in{' '}
        {layout.lanes.length} {layout.lanes.length === 1 ? 'lane' : 'lanes'} by {by},{' '}
        {scale === 'steps' ? 'one column per message' : 'spaced by time'}.
        {slowestHop && (
          <>
            {' '}
            <span className="font-medium text-warn">
              Slowest hop: +{gapText(slowestHop)} before {slowestHop.message.subject}.
            </span>
          </>
        )}
        {layout.shortened > 0 && (
          <>
            {' '}
            {layout.shortened === 1 ? 'One long gap is' : `${layout.shortened} long gaps are`} drawn
            shorter (marked //).
          </>
        )}
        {clipped > 0 && (
          <>
            {' '}
            <span className="font-medium text-fg">
              Showing the first {formatCount(hops.length)} of {formatCount(trace.hops.length)}{' '}
              messages; the Timeline lists all of them.
            </span>
          </>
        )}
      </p>
      <div
        ref={box}
        role="listbox"
        aria-label="Trace lanes"
        aria-describedby={summaryId}
        aria-activedescendant={selectedIndex >= 0 ? `${uid}-dot-${selectedIndex}` : undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onMouseLeave={() => setHover(null)}
        className="relative min-h-0 flex-1 overflow-auto focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      >
        <div
          className="grid"
          style={{
            gridTemplateColumns: `${LABEL_WIDTH}px ${layout.width}px`,
            gridTemplateRows: `${AXIS_HEIGHT}px ${bodyHeight}px`,
            width: LABEL_WIDTH + layout.width
          }}
        >
          <div className="sticky top-0 left-0 z-30 border-r border-b border-line bg-panel px-2 py-1 text-[11px] text-faint">
            {by === 'subject' ? 'Subject' : 'Stream'}
          </div>
          <Axis layout={layout} hops={hops} timeOf={timeOf} />
          <div
            aria-hidden
            className="sticky left-0 z-20 border-r border-line bg-bg"
            style={{ height: bodyHeight }}
          >
            {layout.lanes.map((lane, i) => (
              <div
                key={lane.key}
                data-testid="lane-label"
                title={lane.key}
                className={`flex items-center gap-1.5 border-b border-line/60 px-2 ${
                  layout.dots[selectedIndex]?.lane === i ? 'bg-accent-soft' : ''
                }`}
                style={{ height: LANE_HEIGHT }}
              >
                <span className="line-clamp-2 min-w-0 flex-1 font-mono text-[11.5px] leading-tight [overflow-wrap:anywhere]">
                  {lane.key.split('.').map((part, k) => (
                    <Fragment key={k}>
                      {k > 0 && (
                        <>
                          .<wbr />
                        </>
                      )}
                      {part}
                    </Fragment>
                  ))}
                </span>
                {lane.count > 1 && (
                  <span className="shrink-0 text-[11px] text-faint tabular-nums">
                    {'×'}
                    {lane.count}
                  </span>
                )}
              </div>
            ))}
          </div>
          <div className="relative" style={{ height: bodyHeight }}>
            <svg
              role="none"
              width={layout.width}
              height={bodyHeight}
              className="block"
              data-testid="lanes-canvas"
            >
              <defs>
                <marker
                  id={`${uid}-arrow`}
                  viewBox="0 0 8 8"
                  refX="7"
                  refY="4"
                  markerWidth="9"
                  markerHeight="9"
                  markerUnits="userSpaceOnUse"
                  orient="auto"
                >
                  <path d="M0 0L8 4L0 8z" className="fill-faint" />
                </marker>
                <marker
                  id={`${uid}-arrow-slow`}
                  viewBox="0 0 8 8"
                  refX="7"
                  refY="4"
                  markerWidth="11"
                  markerHeight="11"
                  markerUnits="userSpaceOnUse"
                  orient="auto"
                >
                  <path d="M0 0L8 4L0 8z" className="fill-warn" />
                </marker>
              </defs>
              {layout.lanes.map((lane, i) => (
                <g key={lane.key}>
                  {i % 2 === 1 && (
                    <rect
                      x="0"
                      y={i * LANE_HEIGHT}
                      width={layout.width}
                      height={LANE_HEIGHT}
                      className="fill-raised"
                      opacity="0.45"
                    />
                  )}
                  {layout.dots[selectedIndex]?.lane === i && (
                    <rect
                      x="0"
                      y={i * LANE_HEIGHT}
                      width={layout.width}
                      height={LANE_HEIGHT}
                      className="fill-accent-soft"
                      opacity="0.7"
                    />
                  )}
                  <line
                    x1="0"
                    x2={layout.width}
                    y1={laneY(i)}
                    y2={laneY(i)}
                    className="stroke-line"
                    strokeDasharray="2 5"
                  />
                </g>
              ))}
              {layout.axis.map((i) => (
                <line
                  key={i}
                  x1={layout.dots[i].x}
                  x2={layout.dots[i].x}
                  y1="0"
                  y2={bodyHeight}
                  className="stroke-line"
                  opacity="0.6"
                />
              ))}
              {layout.links.map((link) => {
                const shape = linkShape(link)
                const label = `+${formatSpan(link.gapMs)}`
                const room = link.x2 - link.x1 - 2 * DOT_RADIUS - 4
                const showLabel = link.slowest || room >= label.length * CHAR_WIDTH
                // A label above a straight arrow, on the middle of a curved one.
                const ly = shape.curved ? shape.mid.y + 4 : shape.mid.y - 8
                return (
                  <g key={link.to} data-testid={link.slowest ? 'lane-link-slowest' : 'lane-link'}>
                    <path
                      d={shape.d}
                      fill="none"
                      strokeWidth={link.slowest ? 2.5 : 1.5}
                      className={link.slowest ? 'stroke-warn' : 'stroke-faint'}
                      markerEnd={`url(#${uid}-arrow${link.slowest ? '-slow' : ''})`}
                    />
                    {link.shortened && !shape.curved && (
                      <path
                        d={`M${link.x1 + 22} ${laneY(link.fromLane) - 5}l-4 10M${link.x1 + 27} ${laneY(link.fromLane) - 5}l-4 10`}
                        className="stroke-faint"
                        strokeWidth="1.2"
                        fill="none"
                      />
                    )}
                    {showLabel && (
                      <LinkLabel x={shape.mid.x} y={ly} text={label} slow={link.slowest} />
                    )}
                    {link.slowest && (
                      <LinkLabel x={shape.mid.x} y={ly - 13} text="SLOWEST" slow tag />
                    )}
                  </g>
                )
              })}
              {layout.dots.map((dot) => {
                const hop = hops[dot.index]
                const isSelected = dot.index === selectedIndex
                const y = laneY(dot.lane)
                return (
                  <g
                    key={dot.id}
                    id={`${uid}-dot-${dot.index}`}
                    role="option"
                    aria-selected={isSelected}
                    aria-label={dotName(hop, timeOf(hop), dot.index === layout.slowest)}
                    className="cursor-pointer"
                    onMouseEnter={() => setHover(dot.index)}
                    onMouseLeave={() => setHover(null)}
                    onClick={() => onOpen(dot.id)}
                  >
                    <circle cx={dot.x} cy={y} r="15" fill="transparent" />
                    {(isSelected || hover === dot.index) && (
                      <circle
                        cx={dot.x}
                        cy={y}
                        r={DOT_RADIUS + 4}
                        fill="none"
                        strokeWidth={isSelected ? 2.5 : 1.5}
                        className={isSelected ? 'stroke-fg' : 'stroke-accent'}
                      />
                    )}
                    <circle
                      cx={dot.x}
                      cy={y}
                      r={isSelected ? DOT_RADIUS + 1 : DOT_RADIUS}
                      strokeWidth="2"
                      className="fill-accent stroke-bg"
                    />
                  </g>
                )
              })}
            </svg>
            {shownIndex !== null && layout.dots[shownIndex] && (
              <Tooltip
                ref={tooltip}
                layout={layout}
                hop={hops[shownIndex]}
                index={shownIndex}
                time={formatTime(hops[shownIndex].message.time)}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/** The time scale across the top: the message number and its time, where there is room. */
function Axis({
  layout,
  hops,
  timeOf
}: {
  layout: LanesLayout
  hops: readonly TraceHop[]
  timeOf: (hop: TraceHop) => string
}): ReactNode {
  return (
    <div className="sticky top-0 z-20 border-b border-line bg-panel" aria-hidden>
      <svg width={layout.width} height={AXIS_HEIGHT} className="block">
        {layout.axis.map((i) => {
          const x = layout.dots[i].x
          return (
            <g key={i}>
              <line x1={x} x2={x} y1={AXIS_HEIGHT - 8} y2={AXIS_HEIGHT} className="stroke-faint" />
              <text x={x} y="15" textAnchor="middle" className="fill-faint text-[10.5px]">
                #{i + 1}
              </text>
              <text
                x={x}
                y="29"
                textAnchor="middle"
                className="fill-muted font-mono text-[10.5px] tabular-nums"
              >
                {timeOf(hops[i])}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

/** What hovering or focusing a dot shows. Not read out: the dot's own name says the same. */
function Tooltip({
  ref,
  layout,
  hop,
  index,
  time
}: {
  ref: Ref<HTMLDivElement>
  layout: LanesLayout
  hop: TraceHop
  index: number
  time: string
}): ReactNode {
  const dot = layout.dots[index]
  const gap = gapText(hop)
  const consumers = hop.consumers.map((c) => `${c.name}: ${c.label}`)
  return (
    <div
      ref={ref}
      aria-hidden
      data-testid="lane-tooltip"
      className="pointer-events-none absolute z-40 w-64 rounded-md border border-line bg-panel px-2.5 py-1.5 text-xs shadow-lg"
    >
      <div className="font-mono text-[11.5px] break-all">{hop.message.subject}</div>
      <div className="mt-0.5 text-muted">
        {hop.message.stream} #{hop.message.seq}
      </div>
      <div className="tabular-nums">{time}</div>
      <div className="text-muted">
        {gap === null ? 'First message' : `+${gap} after the previous message`}
        {dot.index === layout.slowest ? ' (slowest hop)' : ''}
      </div>
      <div className="text-muted">
        {consumers.length === 0 ? 'No consumers' : `Consumers: ${consumers.join(', ')}`}
      </div>
    </div>
  )
}

/** A label on an arrow, on a background so that the arrow does not run through the text. */
function LinkLabel({
  x,
  y,
  text,
  slow,
  tag
}: {
  x: number
  y: number
  text: string
  slow?: boolean
  tag?: boolean
}): ReactNode {
  const width = text.length * (tag ? 6.4 : CHAR_WIDTH) + 6
  return (
    <g>
      <rect x={x - width / 2} y={y - 10} width={width} height="14" rx="3" className="fill-bg" />
      <text
        x={x}
        y={y}
        textAnchor="middle"
        className={`tabular-nums ${tag ? 'text-[10px] font-semibold tracking-wide' : 'text-[10.5px]'} ${
          slow ? 'fill-warn font-semibold' : 'fill-muted'
        }`}
      >
        {text}
      </text>
    </g>
  )
}
