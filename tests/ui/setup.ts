import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => cleanup())

// jsdom has no layout, so give elements a size. The virtualized tables render rows only for the
// area they believe is visible.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
for (const [prop, value] of [
  ['offsetHeight', 600],
  ['clientHeight', 600],
  ['offsetWidth', 1200],
  ['clientWidth', 1200]
] as const) {
  Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => value })
}
Element.prototype.scrollIntoView ??= () => {}
Element.prototype.scrollTo ??= () => {}
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  onchange: null,
  dispatchEvent: () => false
})) as unknown as typeof window.matchMedia

// jsdom has no DOMMatrix; the graph library (Trace Graph view) reads the zoom from the viewport's
// transform with it. A transform that cannot be read means zoom 1.
class DOMMatrixReadOnlyStub {
  m22 = 1
  constructor(_transform?: string) {}
}
globalThis.DOMMatrixReadOnly ??= DOMMatrixReadOnlyStub as unknown as typeof DOMMatrixReadOnly
