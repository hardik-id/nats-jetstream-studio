import { fitZoom, type GraphLayout, type Size } from '../../model/layout'

/** The first fit never zooms out further than this; the start of the request is shown instead. */
export const MIN_FIT_ZOOM = 0.55
export const FIT_PADDING = 28
/** Room kept free at the bottom for the legend, which is shown in an area at least this high. */
const LEGEND_SPACE = 44
export const LEGEND_MIN_HEIGHT = 260
const legendSpace = (height: number): number => (height >= LEGEND_MIN_HEIGHT ? LEGEND_SPACE : 0)

/** The area a graph is laid out for: the element without the padding kept around a fit. */
export function layoutArea(element: Size): Size | undefined {
  if (element.width <= 0 || element.height <= 0) return undefined
  return {
    width: Math.max(1, element.width - 2 * FIT_PADDING),
    height: Math.max(1, element.height - 2 * FIT_PADDING - legendSpace(element.height))
  }
}

/** The viewport that shows the whole graph, or its start when that would be too small to read. */
export function fitViewport(
  layout: Pick<GraphLayout, 'bounds'>,
  width: number,
  height: number
): { x: number; y: number; zoom: number } {
  const b = layout.bounds
  const room = layoutArea({ width, height }) ?? { width: 1, height: 1 }
  const zoom = Math.max(MIN_FIT_ZOOM, fitZoom(b, room))
  const x =
    b.width * zoom <= room.width
      ? (width - b.width * zoom) / 2 - b.x * zoom
      : FIT_PADDING - b.x * zoom
  const y =
    b.height * zoom <= room.height
      ? (height - legendSpace(height) - b.height * zoom) / 2 - b.y * zoom
      : FIT_PADDING - b.y * zoom
  return { x, y, zoom }
}

/** The graph does not fit the area even when fitted: then a minimap helps to find the way. */
export function overflows(
  layout: Pick<GraphLayout, 'bounds'>,
  width: number,
  height: number
): boolean {
  const room = layoutArea({ width, height })
  return room !== undefined && fitZoom(layout.bounds, room) < MIN_FIT_ZOOM
}

/**
 * The viewport that brings a node into view, centred, at the same zoom; null when it is already
 * fully visible in an area of this size.
 */
export function revealViewport(
  viewport: { x: number; y: number; zoom: number },
  node: { x: number; y: number; width: number; height: number },
  width: number,
  height: number
): { x: number; y: number; zoom: number } | null {
  const { x, y, zoom } = viewport
  const left = node.x * zoom + x
  const top = node.y * zoom + y
  const inside =
    left >= 0 && top >= 0 && left + node.width * zoom <= width && top + node.height * zoom <= height
  if (inside) return null
  return {
    x: width / 2 - (node.x + node.width / 2) * zoom,
    y: height / 2 - (node.y + node.height / 2) * zoom,
    zoom
  }
}
