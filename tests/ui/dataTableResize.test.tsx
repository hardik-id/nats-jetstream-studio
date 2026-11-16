import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DataTable, type Column, type DataTableProps } from '@renderer/components/DataTable'
import { createFakeGateway } from '@renderer/gateway/fake'
import { renderWithGateway } from './render'

interface Row {
  id: number
  name: string
  size: number
}
const rows: Row[] = [
  { id: 1, name: 'beta', size: 20 },
  { id: 2, name: 'alpha', size: 10 }
]
const columns: Column<Row>[] = [
  { id: 'name', header: 'Name', width: '200px', sort: (r) => r.name, cell: (r) => r.name },
  { id: 'size', header: 'Size', width: 'minmax(80px, 1fr)', cell: (r) => r.size }
]
const KEY = 'table.widths:Things'

function table(extra: Partial<DataTableProps<Row>> = {}) {
  return (
    <div style={{ height: 400 }}>
      <DataTable ariaLabel="Things" rows={rows} columns={columns} rowKey={(r) => r.id} {...extra} />
    </div>
  )
}
const handle = (name: string): HTMLElement => screen.getByRole('separator', { name })
const templates = (): string[] =>
  screen.getAllByRole('row').map((r) => (r as HTMLElement).style.gridTemplateColumns)

/** Lets the stored value be read, so a change is stored rather than kept for the session. */
const settled = (): Promise<void> => act(() => new Promise<void>((r) => setTimeout(r, 30)))

function drag(el: HTMLElement, from: number, to: number): void {
  fireEvent.pointerDown(el, { clientX: from, button: 0, pointerId: 1 })
  fireEvent.pointerMove(el, { clientX: to, pointerId: 1 })
  fireEvent.pointerUp(el, { clientX: to, pointerId: 1 })
}

describe('PBI-124 resizable columns', () => {
  it('gives each header an accessible separator that cannot be scrolled by touch', () => {
    renderWithGateway(table())
    const sep = handle('Resize Name')
    expect(sep).toHaveAttribute('aria-orientation', 'vertical')
    expect(sep).toHaveAttribute('tabindex', '0')
    expect(sep).toHaveStyle({ touchAction: 'none' })
    expect(sep).toHaveAttribute('aria-valuemax', '1200')
    expect(Number(sep.getAttribute('aria-valuemin'))).toBeGreaterThanOrEqual(80)
  })

  it('dragging sets the width, and the header and rows share one template', async () => {
    const gateway = createFakeGateway()
    renderWithGateway(table(), gateway)
    await waitFor(() => expect(gateway.getSetting(KEY)).resolves.toBeNull())
    drag(handle('Resize Name'), 100, 160)
    await waitFor(() => expect(templates()[0]).toMatch(/^260px /))
    expect(new Set(templates()).size).toBe(1)
    expect(templates()[0]).toContain('minmax(80px, 1fr)')
    expect(handle('Resize Name')).toHaveAttribute('aria-valuenow', '260')
    await waitFor(() => expect(gateway.getSetting(KEY)).resolves.toEqual({ name: 260 }))
  })

  it('writes only when the drag ends, not on every move', async () => {
    const gateway = createFakeGateway()
    const set = vi.spyOn(gateway, 'setSetting')
    renderWithGateway(table(), gateway)
    const sep = handle('Resize Name')
    await screen.findByRole('table', { name: 'Things' })
    fireEvent.pointerDown(sep, { clientX: 0, button: 0, pointerId: 1 })
    for (const x of [10, 20, 30]) fireEvent.pointerMove(sep, { clientX: x, pointerId: 1 })
    expect(set).not.toHaveBeenCalled()
    expect(screen.getByRole('table')).toHaveClass('select-none')
    fireEvent.pointerUp(sep, { clientX: 30, pointerId: 1 })
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('table')).not.toHaveClass('select-none')
  })

  it('never goes below the floor or above the maximum', async () => {
    renderWithGateway(table())
    drag(handle('Resize Name'), 500, 0)
    const min = Number(handle('Resize Name').getAttribute('aria-valuemin'))
    await waitFor(() => expect(templates()[0]).toMatch(new RegExp(`^${min}px `)))
    drag(handle('Resize Name'), 0, 5000)
    await waitFor(() => expect(templates()[0]).toMatch(/^1200px /))
  })

  it('double-click resets the column to its default width', async () => {
    const gateway = createFakeGateway()
    renderWithGateway(table(), gateway)
    await settled()
    drag(handle('Resize Name'), 0, 100)
    await waitFor(() => expect(templates()[0]).toMatch(/^300px /))
    fireEvent.doubleClick(handle('Resize Name'))
    await waitFor(() => expect(templates()[0]).toMatch(/^200px /))
    await waitFor(() => expect(gateway.getSetting(KEY)).resolves.toEqual({}))
  })

  it('resizes with the arrow keys, 10 px or 50 px with Shift, and Home resets', async () => {
    const onOpen = vi.fn()
    renderWithGateway(table({ onOpen }))
    const sep = handle('Resize Name')
    await screen.findByRole('table', { name: 'Things' })
    fireEvent.keyDown(sep, { key: 'ArrowRight' })
    await waitFor(() => expect(sep).toHaveAttribute('aria-valuenow', '210'))
    fireEvent.keyDown(sep, { key: 'ArrowRight', shiftKey: true })
    await waitFor(() => expect(sep).toHaveAttribute('aria-valuenow', '260'))
    fireEvent.keyDown(sep, { key: 'ArrowLeft' })
    await waitFor(() => expect(sep).toHaveAttribute('aria-valuenow', '250'))
    expect(templates()[0]).toMatch(/^250px /)
    fireEvent.keyDown(sep, { key: 'Home' })
    await waitFor(() => expect(sep).toHaveAttribute('aria-valuenow', '200'))
    // Keys on the handle do not open a row.
    fireEvent.keyDown(sep, { key: 'Enter' })
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('does not sort or select a row when the handle is used', async () => {
    const onSelect = vi.fn()
    renderWithGateway(table({ onSelect }))
    const sep = handle('Resize Name')
    await userEvent.click(sep)
    drag(sep, 0, 20)
    fireEvent.doubleClick(sep)
    expect(screen.getByRole('columnheader', { name: 'Name' })).not.toHaveAttribute('aria-sort')
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('restores stored widths and ignores unknown columns and bad values', async () => {
    const gateway = createFakeGateway()
    await gateway.setSetting(KEY, { name: 333, size: 'wide', gone: 400 })
    renderWithGateway(table(), gateway)
    await waitFor(() => expect(templates()[0]).toBe('333px minmax(80px, 1fr)'))
  })

  it.each([[42], ['text'], [[1, 2]], [{ name: null }], [{ name: 'x' }]])(
    'ignores a corrupt stored value %j',
    async (bad) => {
      const gateway = createFakeGateway()
      await gateway.setSetting(KEY, bad)
      renderWithGateway(table(), gateway)
      await screen.findByRole('table', { name: 'Things' })
      await waitFor(() => expect(gateway.getSetting(KEY)).resolves.not.toBeNull())
      expect(templates()[0]).toBe('200px minmax(80px, 1fr)')
    }
  )

  it('clamps stored widths to the floor and maximum', async () => {
    const gateway = createFakeGateway()
    await gateway.setSetting(KEY, { name: 1, size: 99999 })
    renderWithGateway(table(), gateway)
    await waitFor(() => expect(templates()[0]).toMatch(/^\d+px 1200px$/))
    expect(templates()[0]).not.toMatch(/^1px /)
  })

  it('uses storageKey instead of the label when given', async () => {
    const gateway = createFakeGateway()
    renderWithGateway(table({ storageKey: 'other' }), gateway)
    await settled()
    drag(handle('Resize Name'), 0, 10)
    await waitFor(() =>
      expect(gateway.getSetting('table.widths:other')).resolves.toEqual({ name: 210 })
    )
  })
})
