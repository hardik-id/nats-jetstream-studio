import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TabBar } from '@renderer/features/shell/TabBar'
import { useTabs } from '@renderer/state/tabs'
import { renderWithGateway } from './render'

describe('TabBar overflow', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private cb: () => void) {}
        observe(): void {
          this.cb()
        }
        unobserve(): void {}
        disconnect(): void {}
      }
    )
    // 162px per tab, 64px kept for the "+N" button: room for 3 tabs.
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(162 * 3 + 64)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('moves tabs that do not fit into a +N menu and keeps the active tab visible', async () => {
    renderWithGateway(<TabBar />)
    act(() => {
      for (const kind of ['overview', 'streams', 'consumers', 'subjects', 'kv'] as const)
        useTabs.getState().open({ kind, connId: 'dev' })
    })
    const list = screen.getByRole('tablist', { name: 'Open tabs' })
    expect(within(list).getAllByRole('tab')).toHaveLength(3)
    const more = screen.getByRole('button', { name: '2 more tabs' })
    expect(more).toHaveTextContent('+2')

    // The active tab (the last one) is swapped in rather than hidden.
    expect(within(list).getAllByRole('tab').at(-1)).toHaveAttribute('aria-selected', 'true')

    // Choosing a hidden tab activates it and shows it.
    await userEvent.click(more)
    const items = screen.getAllByRole('menuitem')
    expect(items).toHaveLength(2)
    const label = items[0].textContent ?? ''
    await userEvent.click(items[0])
    const selected = within(list)
      .getAllByRole('tab')
      .find((t) => t.getAttribute('aria-selected') === 'true')
    expect(selected).toHaveTextContent(label)
  })
})
