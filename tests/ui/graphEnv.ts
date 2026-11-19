import { vi } from 'vitest'

/**
 * A matchMedia whose "prefers-reduced-motion" answer a test can change, with change events, for
 * the Trace Graph view (the global stub in setup.ts always answers no and never changes).
 * `stubMotionPreference` returns a function that puts the previous globals back.
 */
let reduce = false
const listeners = new Set<() => void>()

export function stubMotionPreference(): () => void {
  reduce = false
  listeners.clear()
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return query.includes('reduced-motion') && reduce
    },
    media: query,
    addEventListener: (_: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false
  }))
  return () => vi.unstubAllGlobals()
}

/** Turns "prefers reduced motion" on, tells the listeners, and returns how to turn it off. */
export function reducedMotion(): () => void {
  reduce = true
  listeners.forEach((cb) => cb())
  return () => {
    reduce = false
    listeners.forEach((cb) => cb())
  }
}
