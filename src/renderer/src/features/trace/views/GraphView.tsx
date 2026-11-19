import '@xyflow/react/dist/style.css'
import './graph/graph.css'
import {
  useCallback,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  type KeyboardEvent,
  type ReactNode
} from 'react'
import {
  Background,
  BackgroundVariant,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
  type EdgeTypes,
  type NodeTypes,
  type Viewport
} from '@xyflow/react'
import { Maximize, Minus, Plus } from 'lucide-react'
import { formatCount } from '@shared/format'
import { Button } from '../../../components/ui'
import { useDocumentVisible, usePrefersReducedMotion, useTabActive } from '../../../lib/hooks'
import { buildGraph, cycleMessage, type TraceGraph } from '../model/graph'
import { layoutGraph, type GraphLayout } from '../model/layout'
import { MAX_ANIMATED_EDGES, planMotion } from '../model/motion'
import { formatSpan, type Trace } from '../model/trace'
import { GraphActions, type GraphActionsValue } from './graph/actions'
import { ConsumerNode } from './graph/ConsumerNode'
import { toFlowEdges, toFlowNodes } from './graph/elements'
import { FlowDots } from './graph/FlowDots'
import { FlowEdge } from './graph/FlowEdge'
import { SubjectNode } from './graph/SubjectNode'
import { useElementSize } from './graph/useElementSize'
import {
  fitViewport,
  layoutArea,
  LEGEND_MIN_HEIGHT,
  overflows,
  revealViewport
} from './graph/viewport'
import { graphSettings } from './graphSettings'
import type { TraceViewProps } from './types'

const ZOOM_STEP = { duration: 0 }
/** Above this many edges only the slowest and the selected one keep their labels. */
const DENSE_EDGES = 36

// Module constants: new objects on each render would make the library remount every node.
const nodeTypes: NodeTypes = { subject: SubjectNode, consumer: ConsumerNode }
const edgeTypes: EdgeTypes = { flow: FlowEdge }

/**
 * Graph (PBI-138 phase 3): subjects and consumers as nodes, the path of the request as arrows,
 * with small dots travelling along them. Built on React Flow, which only this view and its
 * `graph/` folder import; the view is loaded on first use, so the library is a separate chunk.
 */
export default function GraphView(props: TraceViewProps): ReactNode {
  return (
    <ReactFlowProvider>
      <Graph {...props} />
    </ReactFlowProvider>
  )
}

function Graph({ trace, selected, onSelect, onOpen, settings }: TraceViewProps): ReactNode {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '')
  const { consumers, group, animate } = graphSettings(settings)
  const graph = useMemo(() => buildGraph(trace, { consumers, group }), [trace, consumers, group])
  const box = useRef<HTMLDivElement>(null)
  // A long request wraps into bands, as many as show it largest in the area.
  const { width, height } = useElementSize(box)
  const dense = graph.edges.length > DENSE_EDGES
  const layout = useMemo(
    () => layoutGraph(graph, { area: layoutArea({ width, height }), compactLanes: dense }),
    [graph, width, height, dense]
  )

  // Dots move only when asked for, when the system allows motion, and while they can be seen.
  const reduced = usePrefersReducedMotion()
  const visible = useDocumentVisible()
  const active = useTabActive()
  const tooMany = graph.edges.length > MAX_ANIMATED_EDGES
  const moving = animate && !reduced && visible && active && !tooMany
  const motion = useMemo(() => (moving ? planMotion(graph) : null), [graph, moving])

  const index = useMemo(() => {
    const i = selected === null ? -1 : trace.hops.findIndex((h) => h.id === selected)
    return i >= 0 ? i : null
  }, [selected, trace.hops])
  const nodes = useMemo(() => toFlowNodes(graph, layout, index), [graph, layout, index])
  const edges = useMemo(
    () => toFlowEdges(graph, layout, index, !dense),
    [graph, layout, index, dense]
  )

  const flow = useReactFlow()
  const dots = useRef<SVGSVGElement>(null)
  // The user panned or zoomed: then a resize leaves the view alone (see below).
  const moved = useRef(false)

  /** Moves the view, if needed, so that the node of the selected message is in it. */
  const reveal = useCallback(
    (viewport: Viewport): void => {
      const el = box.current
      const node = index === null ? undefined : layout.nodes[graph.nodeOf[index]]
      if (!el || !node) return
      const next = revealViewport(viewport, node, el.clientWidth, el.clientHeight)
      if (next) void flow.setViewport(next)
    },
    [flow, layout, graph, index]
  )

  const fit = useCallback((): void => {
    const el = box.current
    if (!el || el.clientWidth === 0 || el.clientHeight === 0) return
    const viewport = fitViewport(layout, el.clientWidth, el.clientHeight)
    void flow.setViewport(viewport)
    reveal(viewport)
  }, [flow, layout, reveal])

  // A new graph (a new result, a setting that changes the nodes) is fitted, whatever the user
  // did with the previous one. Runs before the effect below.
  useLayoutEffect(() => {
    moved.current = false
  }, [graph])

  // The layout follows the size of the area (`useElementSize`, the one observer of it), so it
  // also changes when the detail pane opens or closes. Fit then, unless the user has panned or
  // zoomed: their view is kept, and only the selected node is brought back into it if needed.
  const onLayout = useEffectEvent((): void => {
    if (moved.current) reveal(flow.getViewport())
    else fit()
  })
  useLayoutEffect(() => {
    onLayout()
  }, [layout])

  // Keeps the node of the selected message in view as the selection moves.
  const onSelection = useEffectEvent((): void => reveal(flow.getViewport()))
  useLayoutEffect(() => {
    onSelection()
  }, [index])

  const open = (i: number | null): void => {
    if (i !== null && trace.hops[i]) onOpen(trace.hops[i].id)
  }
  const pickNode = (id: string): void => {
    const node = graph.nodes.find((n) => n.id === id)
    if (node) open(cycleMessage(node.messages, index))
  }
  const actions = useMemo<GraphActionsValue>(
    () => ({
      pickEdge: (id) => {
        const edge = graph.edges.find((e) => e.id === id)
        const i = edge ? cycleMessage(edge.messages, index) : null
        if (i !== null && trace.hops[i]) onOpen(trace.hops[i].id)
      },
      pause: () => dots.current?.pauseAnimations?.(),
      resume: () => dots.current?.unpauseAnimations?.()
    }),
    [graph, index, trace.hops, onOpen]
  )

  const zoom = (by: 'in' | 'out'): void => {
    moved.current = true
    void (by === 'in' ? flow.zoomIn(ZOOM_STEP) : flow.zoomOut(ZOOM_STEP))
  }
  const refit = (): void => {
    moved.current = false
    fit()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.ctrlKey || e.altKey || e.metaKey) return
    const last = trace.hops.length - 1
    const select = (i: number): void => onSelect(trace.hops[i].id)
    let handled = true
    switch (e.key) {
      case 'ArrowRight':
        select(index === null ? 0 : Math.min(last, index + 1))
        break
      case 'ArrowLeft':
        select(index === null ? 0 : Math.max(0, index - 1))
        break
      case 'Home':
        select(0)
        break
      case 'End':
        select(last)
        break
      case 'Enter':
        open(index ?? 0)
        break
      case '+':
      case '=':
        zoom('in')
        break
      case '-':
        zoom('out')
        break
      case '0':
        refit()
        break
      default:
        handled = false
    }
    if (handled) e.preventDefault()
  }

  const summaryId = `${uid}-summary`
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-line px-4 py-1">
        <p id={summaryId} className="min-w-0 flex-1 py-0.5 text-xs text-muted">
          <Summary trace={trace} graph={graph} />
          {tooMany && animate && (
            <> Too many arrows to animate ({graph.edges.length}); the dots are off.</>
          )}
          {reduced && animate && <> The dots are off: the system asks for reduced motion.</>}
        </p>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            aria-label="Zoom out"
            title="Zoom out (-)"
            icon={<Minus className="h-3.5 w-3.5" aria-hidden />}
            onClick={() => zoom('out')}
          />
          <Button
            size="sm"
            variant="ghost"
            aria-label="Zoom in"
            title="Zoom in (+)"
            icon={<Plus className="h-3.5 w-3.5" aria-hidden />}
            onClick={() => zoom('in')}
          />
          <Button
            size="sm"
            variant="ghost"
            title="Fit the graph to the view (0)"
            icon={<Maximize className="h-3.5 w-3.5" aria-hidden />}
            onClick={refit}
          >
            Fit
          </Button>
        </div>
      </div>
      <p className="sr-only" aria-live="polite">
        {index !== null && selectionText(trace, graph, index)}
      </p>
      <div className="relative min-h-0 flex-1">
        <GraphActions.Provider value={actions}>
          {/* The library's wrapper is the view's one tab stop: it already has role="application",
              which it does not let us change, so it gets the names and the keys too. */}
          <ReactFlow
            ref={box}
            aria-roledescription="trace graph"
            aria-label="Trace graph"
            aria-describedby={summaryId}
            tabIndex={0}
            onKeyDown={onKeyDown}
            data-testid="trace-graph"
            className="trace-graph focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
            id={`trace-graph-${uid}`}
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            nodesFocusable={false}
            edgesFocusable={false}
            disableKeyboardA11y
            deleteKeyCode={null}
            selectionKeyCode={null}
            multiSelectionKeyCode={null}
            zoomOnDoubleClick={false}
            minZoom={0.15}
            maxZoom={2}
            attributionPosition="top-right"
            onNodeClick={(_, node) => pickNode(node.id)}
            onEdgeClick={(_, edge) => actions.pickEdge(edge.id)}
            onEdgeMouseEnter={actions.pause}
            onEdgeMouseLeave={actions.resume}
            // A move with an event is the user's (a click alone does not move the view).
            onMove={(event) => {
              if (event) moved.current = true
            }}
          >
            {motion && <FlowDots ref={dots} idPrefix={`dot${uid}`} edges={edges} motion={motion} />}
            <Background variant={BackgroundVariant.Dots} gap={22} size={1.3} />
            <Overview layout={layout} />
            <Panel position="bottom-left">
              <Legend moving={motion !== null} />
            </Panel>
          </ReactFlow>
        </GraphActions.Provider>
      </div>
    </div>
  )
}

/** The minimap, only when the graph does not fit the area even zoomed out. */
function Overview({ layout }: { layout: GraphLayout }): ReactNode {
  // Not in a small area, where it would cover most of the graph.
  const big = useStore(
    (s) => s.width >= 560 && s.height >= 360 && overflows(layout, s.width, s.height)
  )
  if (!big) return null
  return (
    <MiniMap
      pannable
      zoomable
      ariaLabel="Overview of the trace graph"
      nodeBorderRadius={8}
      maskStrokeWidth={1}
    />
  )
}

/** The text alternative of the picture: what is in it, and the slowest hop. */
function Summary({ trace, graph }: { trace: Trace; graph: TraceGraph }): ReactNode {
  const subjects = graph.nodes.filter((n) => n.kind === 'subject').length
  const consumers = graph.nodes.length - subjects
  const repeats = graph.edges.reduce((n, e) => n + (e.back ? e.repeats : 0), 0)
  const slow = graph.slowest === null ? null : trace.hops[graph.slowest]
  const plural = (n: number, one: string): string => `${formatCount(n)} ${one}${n === 1 ? '' : 's'}`
  return (
    <>
      {plural(subjects, 'subject')}, {plural(consumers, 'consumer')},{' '}
      {plural(trace.hops.length, 'message')}
      {repeats > 0 && <>, {repeats === 1 ? '1 repeat' : `${formatCount(repeats)} repeats`}</>}.
      {slow && (
        <>
          {' '}
          <span className="font-medium text-warn">
            Slowest hop: +{formatSpan(slow.gapMs ?? 0)} before {slow.message.subject}.
          </span>
        </>
      )}
    </>
  )
}

function selectionText(trace: Trace, graph: TraceGraph, index: number): string {
  const hop = trace.hops[index]
  const receivers = graph.receivers[index].length
  return `Message ${index + 1} of ${trace.hops.length}: ${hop.message.subject}, ${hop.message.stream} #${hop.message.seq}${
    receivers ? `, received by ${receivers} ${receivers === 1 ? 'consumer' : 'consumers'}` : ''
  }`
}

/** What the lines and dots mean. Shape and dash carry it, never colour alone. */
function Legend({ moving }: { moving: boolean }): ReactNode {
  // A short area keeps its room for the graph (the summary above says what matters).
  const room = useStore((s) => s.height === 0 || s.height >= LEGEND_MIN_HEIGHT)
  if (!room) return null
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-line bg-panel/90 px-2.5 py-1.5 text-[11px] text-muted shadow-sm backdrop-blur-sm">
      <span className="flex items-center gap-1.5">
        <svg width="26" height="8" aria-hidden>
          <line x1="1" y1="4" x2="25" y2="4" strokeWidth="2" className="stroke-muted" />
        </svg>
        delivered (known)
      </span>
      <span className="flex items-center gap-1.5">
        <svg width="26" height="8" aria-hidden>
          <line
            x1="1"
            y1="4"
            x2="25"
            y2="4"
            strokeWidth="2"
            strokeDasharray="7 5"
            className="stroke-faint"
          />
        </svg>
        ~ next message (inferred)
      </span>
      {moving && (
        <span className="flex items-center gap-1.5">
          <svg width="10" height="10" aria-hidden>
            <circle cx="5" cy="5" r="3.6" className="fill-accent" />
          </svg>
          the request moving
        </span>
      )}
    </div>
  )
}
