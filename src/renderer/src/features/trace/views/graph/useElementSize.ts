import { useCallback, useSyncExternalStore, type RefObject } from 'react'

/**
 * The size of an element, rounded to `step` pixels so that small changes cause no work, and kept
 * current while it is resized. 0 by 0 until the element is there.
 */
export function useElementSize(
  ref: RefObject<HTMLElement | null>,
  step = 40
): { width: number; height: number } {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const el = ref.current
      if (!el || typeof ResizeObserver === 'undefined') return () => {}
      const observer = new ResizeObserver(onChange)
      observer.observe(el)
      return () => observer.disconnect()
    },
    [ref]
  )
  const round = (n: number | undefined): number => Math.round((n ?? 0) / step) * step
  const width = useSyncExternalStore(
    subscribe,
    () => round(ref.current?.clientWidth),
    () => 0
  )
  const height = useSyncExternalStore(
    subscribe,
    () => round(ref.current?.clientHeight),
    () => 0
  )
  return { width, height }
}
