import { useState } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CollapsibleSection } from '@renderer/components/ui'
import { MessageBrowser } from '@renderer/features/messages/MessageBrowser'
import { createFakeGateway } from '@renderer/gateway/fake'
import { renderWithGateway } from './render'

const doc = {
  order: { id: 'A-1', items: [{ sku: 'x1' }, { sku: 'urgent-2' }], note: 'Urgent' },
  tags: ['a', 'b']
}

async function openMessage(consumerCount?: number) {
  const gateway = createFakeGateway({ connections: [{ id: 'dev', name: 'Dev' }] })
  gateway.streams.set('ORDERS', {
    config: {
      name: 'ORDERS',
      subjects: ['orders.>'],
      storage: 'file',
      retention: 'limits',
      num_replicas: 1
    },
    messages: [
      {
        seq: 1,
        subject: 'orders.eu',
        payload: JSON.stringify(doc),
        time: '2026-01-01T00:00:00Z',
        headers: [
          ['Region', 'eu'],
          ['Trace-Id', 't-1']
        ]
      }
    ],
    consumers: []
  })
  const real = await gateway.streamInfo('dev', 'ORDERS')
  const info =
    consumerCount === undefined
      ? real
      : { ...real, state: { ...real.state, consumer_count: consumerCount } }
  renderWithGateway(<MessageBrowser connId="dev" info={info} />, gateway)
  await userEvent.click(await screen.findByText('orders.eu'))
  await screen.findByRole('complementary', { name: 'Message detail' })
  return gateway
}

describe('CollapsibleSection', () => {
  function Demo(): React.ReactNode {
    const [open, setOpen] = useState(true)
    return (
      <CollapsibleSection
        title="Headers (3)"
        summary="Region, Trace-Id"
        open={open}
        onToggle={() => setOpen((v) => !v)}
      >
        <p>body text</p>
      </CollapsibleSection>
    )
  }

  it('flips aria-expanded, hides the body and shows a summary while closed', async () => {
    render(<Demo />)
    const button = screen.getByRole('button', { name: /Headers \(3\)/ })
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('body text')).toBeVisible()
    expect(screen.queryByText('Region, Trace-Id')).toBeNull()
    await userEvent.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('body text')).not.toBeVisible()
    expect(screen.getByText('Region, Trace-Id')).toBeVisible()
    expect(button.getAttribute('aria-controls')).toBeTruthy()
  })
})

describe('PBI-125 filters toggle', () => {
  it('opens and closes with aria-expanded, a count badge, Escape and focus back on the button', async () => {
    await openMessage()
    const button = screen.getByRole('button', { name: /^Filters/ })
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('form', { name: 'Message filters' })).toBeNull()
    await userEvent.click(button)
    const panel = await screen.findByRole('form', { name: 'Message filters' })
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(button).toHaveAttribute('aria-controls', panel.id)
    await userEvent.selectOptions(within(panel).getByLabelText('Condition 1 type'), 'contains')
    await userEvent.type(within(panel).getByLabelText('Condition 1 expression'), 'urgent')
    await userEvent.click(within(panel).getByRole('button', { name: 'Apply filters' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Filters, 1 active' })).toBeInTheDocument()
    )
    // Apply hides the panel, keeps the chip and leaves focus on the Filters button.
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Message filters' })).toBeNull())
    expect(screen.getByRole('button', { name: /^Filters/ })).toHaveFocus()
    expect(screen.getByLabelText('Active filters')).toHaveTextContent('Payload contains')
    await userEvent.click(screen.getByRole('button', { name: /^Filters/ }))
    const field = within(
      await screen.findByRole('form', { name: 'Message filters' })
    ).getByLabelText('Condition 1 expression')
    await userEvent.type(field, '{Escape}')
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Message filters' })).toBeNull())
    expect(screen.getByRole('button', { name: /^Filters/ })).toHaveFocus()
    expect(screen.getByRole('button', { name: /^Filters/ })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(screen.getByLabelText('Active filters')).toHaveTextContent('Payload contains')
  })

  it('hides after Clear too and focuses the Filters button', async () => {
    await openMessage()
    await userEvent.click(screen.getByRole('button', { name: /^Filters/ }))
    const panel = await screen.findByRole('form', { name: 'Message filters' })
    await userEvent.click(within(panel).getByRole('button', { name: 'Clear' }))
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Message filters' })).toBeNull())
    expect(screen.getByRole('button', { name: /^Filters/ })).toHaveFocus()
  })

  it('hides with the Hide button in the footer', async () => {
    await openMessage()
    await userEvent.click(screen.getByRole('button', { name: /^Filters/ }))
    await screen.findByRole('form', { name: 'Message filters' })
    await userEvent.click(screen.getByRole('button', { name: /Hide/ }))
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Message filters' })).toBeNull())
  })
})

describe('PBI-125 detail panel', () => {
  it('starts with Headers closed and a summary, opens it, and leaves Payload open', async () => {
    await openMessage()
    const headers = screen.getByRole('button', { name: /^Headers \(2\)/ })
    expect(headers).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('Region, Trace-Id')).toBeVisible()
    await userEvent.click(headers)
    await waitFor(() => expect(headers).toHaveAttribute('aria-expanded', 'true'))
    expect(screen.getByText('Trace-Id')).toBeVisible()
    expect(screen.getByRole('button', { name: /^Payload/ })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
  })

  it('collapses to a rail that keeps the selection, and expands again', async () => {
    await openMessage()
    await userEvent.click(screen.getByRole('button', { name: 'Collapse panel' }))
    const rail = await screen.findByRole('complementary', { name: 'Message detail (collapsed)' })
    // Focus moves to the rail's button instead of falling to the page.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Expand message panel' })).toHaveFocus()
    )
    expect(rail).toHaveTextContent('Message #1')
    expect(screen.queryByRole('separator', { name: 'Resize message detail' })).toBeNull()
    expect(screen.getByTestId('detail-frame')).toHaveStyle({ width: '36px' })
    await userEvent.click(within(rail).getByRole('button', { name: 'Expand message panel' }))
    await screen.findByRole('complementary', { name: 'Message detail' })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Collapse panel' })).toHaveFocus()
    )
    expect(screen.getByRole('separator', { name: 'Resize message detail' })).toBeInTheDocument()
  })

  it('restores the size first when Escape is pressed in the table, then closes', async () => {
    await openMessage()
    await userEvent.click(screen.getByRole('button', { name: 'Expand to read' }))
    expect(screen.getByTestId('detail-frame')).toHaveStyle({ width: '70%' })
    screen.getByRole('table', { name: 'Messages in ORDERS' }).focus()
    await userEvent.keyboard('{Escape}')
    await waitFor(() =>
      expect(screen.getByTestId('detail-frame')).not.toHaveStyle({ width: '70%' })
    )
    expect(screen.getByRole('complementary', { name: 'Message detail' })).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    await waitFor(() =>
      expect(screen.queryByRole('complementary', { name: 'Message detail' })).toBeNull()
    )
  })

  it('keeps two quick toggles of a section and does not read consumers while closed', async () => {
    const gateway = await openMessage()
    const spy = vi.spyOn(gateway, 'listConsumers')
    const headers = screen.getByRole('button', { name: /^Headers \(2\)/ })
    await userEvent.dblClick(headers)
    await waitFor(() => expect(headers).toHaveAttribute('aria-expanded', 'false'))
    await userEvent.click(headers)
    await waitFor(() => expect(headers).toHaveAttribute('aria-expanded', 'true'))
    expect(screen.getByRole('button', { name: /^Consumers/ })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(spy).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: /^Consumers/ }))
    await waitFor(() => expect(spy).toHaveBeenCalled())
  })

  it('widens to read and Escape restores it without closing, keeping the saved width', async () => {
    await openMessage()
    const sep = screen.getByRole('separator', { name: 'Resize message detail' })
    const saved = sep.getAttribute('aria-valuenow')
    await userEvent.click(screen.getByRole('button', { name: 'Expand to read' }))
    expect(screen.getByTestId('detail-frame')).toHaveStyle({ width: '70%' })
    expect(sep.getAttribute('aria-valuenow')).toBe(saved)
    screen.getByRole('button', { name: 'Restore panel size' }).focus()
    await userEvent.keyboard('{Escape}')
    await waitFor(() =>
      expect(screen.getByTestId('detail-frame')).not.toHaveStyle({ width: '70%' })
    )
    expect(screen.getByRole('separator', { name: 'Resize message detail' })).toHaveAttribute(
      'aria-valuenow',
      saved
    )
    await userEvent.keyboard('{Escape}')
    await waitFor(() =>
      expect(screen.queryByRole('complementary', { name: 'Message detail' })).toBeNull()
    )
  })
})

describe('PBI-125 follow-ups (#58)', () => {
  it('shows the consumer count while the section is closed, without reading the list', async () => {
    const gateway = await openMessage(3)
    const spy = vi.spyOn(gateway, 'listConsumers')
    const button = screen.getByRole('button', { name: /^Consumers/ })
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(button).toHaveTextContent('Consumers (3)')
    expect(button).toHaveAccessibleName('Consumers (3)')
    expect(spy).not.toHaveBeenCalled()
  })

  it('keeps the panel open when Apply cannot read (start from a sequence without a number)', async () => {
    await openMessage()
    await userEvent.selectOptions(screen.getByLabelText('Start from'), 'seq')
    await userEvent.click(screen.getByRole('button', { name: /^Filters/ }))
    const panel = await screen.findByRole('form', { name: 'Message filters' })
    await userEvent.click(within(panel).getByRole('button', { name: 'Apply filters' }))
    expect(await screen.findByText('Enter a sequence number to start from.')).toBeInTheDocument()
    expect(screen.getByRole('form', { name: 'Message filters' })).toBeInTheDocument()
  })

  it('makes what the expanded panel covers inert, keeps the table usable, and restores it', async () => {
    await openMessage()
    const toolbar = screen.getByLabelText('Subject filter').closest('div[class*="border-b"]')!
    const table = screen.getByRole('table', { name: 'Messages in ORDERS' })
    await userEvent.click(screen.getByRole('button', { name: 'Expand to read' }))
    expect(toolbar).toHaveAttribute('inert')
    expect(table.closest('[inert]')).toBeNull()
    // Only elements of the page are inert, never an ancestor of the table or the panel.
    const aside = screen.getByRole('complementary', { name: 'Message detail' })
    for (const el of document.querySelectorAll('[inert]')) {
      expect(el.contains(table)).toBe(false)
      expect(el.contains(aside)).toBe(false)
    }
    expect(
      screen.getByRole('complementary', { name: 'Message detail' }).closest('[inert]')
    ).toBeNull()
    // Escape from a control in the panel restores and keeps focus on the size button.
    screen.getByRole('button', { name: 'Previous message' }).focus()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(toolbar).not.toHaveAttribute('inert'))
    expect(screen.getByRole('button', { name: 'Expand to read' })).toHaveFocus()
  })

  it('does not fold a JSON node when text is selected or the pointer moved', async () => {
    await openMessage()
    const items = screen.getByRole('treeitem', { name: /^\$\.order\.items array/ })
    expect(items).toHaveAttribute('aria-expanded', 'true')
    // Pointer moved between press and release (a drag).
    fireEvent.mouseDown(items, { clientX: 10, clientY: 10 })
    fireEvent.click(items, { clientX: 80, clientY: 10 })
    expect(items).toHaveAttribute('aria-expanded', 'true')
    // Something is selected.
    const sel = vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => 'items'
    } as unknown as Selection)
    fireEvent.mouseDown(items, { clientX: 10, clientY: 10 })
    fireEvent.click(items, { clientX: 10, clientY: 10 })
    expect(items).toHaveAttribute('aria-expanded', 'true')
    sel.mockRestore()
    // A plain click still toggles.
    fireEvent.mouseDown(items, { clientX: 10, clientY: 10 })
    fireEvent.click(items, { clientX: 10, clientY: 10 })
    expect(items).toHaveAttribute('aria-expanded', 'false')
  })
})

describe('PBI-125 payload viewer', () => {
  it('changes the text size and applies it to the other views', async () => {
    await openMessage()
    const tree = screen.getByTestId('payload-body').firstElementChild as HTMLElement
    expect(tree).toHaveStyle({ fontSize: '13px' })
    expect(screen.getByRole('button', { name: 'Smaller text' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Larger text' }))
    await waitFor(() => expect(tree).toHaveStyle({ fontSize: '15px' }))
    await userEvent.click(screen.getByRole('tab', { name: 'Text' }))
    expect(screen.getByTestId('payload-body').querySelector('pre')).toHaveStyle({
      fontSize: '15px'
    })
  })

  it('collapses all, expands all and sets levels', async () => {
    await openMessage()
    expect(screen.getByText('"Urgent"')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Collapse all' }))
    expect(screen.queryByText('"Urgent"')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Expand all' }))
    expect(screen.getByText('"Urgent"')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '1' }))
    expect(screen.queryByText('"Urgent"')).toBeNull()
    expect(screen.getByRole('button', { name: '1' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('searches, counts, highlights, reveals collapsed matches and clears with Escape', async () => {
    await openMessage()
    await userEvent.click(screen.getByRole('button', { name: 'Collapse all' }))
    const input = screen.getByRole('textbox', { name: 'Search in JSON' })
    await userEvent.type(input, 'urgent')
    await waitFor(() => expect(screen.getByTestId('json-match-count')).toHaveTextContent('1 of 2'))
    expect(screen.getAllByText(/^urgent$/i, { selector: 'mark' }).length).toBeGreaterThan(0)
    await userEvent.click(screen.getByRole('button', { name: 'Next match' }))
    expect(screen.getByTestId('json-match-count')).toHaveTextContent('2 of 2')
    await userEvent.type(input, '{Escape}')
    expect(input).toHaveValue('')
    // Escape in the search box did not close the panel.
    expect(screen.getByRole('complementary', { name: 'Message detail' })).toBeInTheDocument()
  })

  it('focuses the search with Ctrl+F inside the payload', async () => {
    await openMessage()
    fireEvent.keyDown(screen.getByTestId('payload-body'), { key: 'f', ctrlKey: true })
    expect(screen.getByRole('textbox', { name: 'Search in JSON' })).toHaveFocus()
  })

  it('moves through the tree with the arrow keys and reaches Copy path of a primitive row', async () => {
    const user = userEvent.setup()
    await openMessage()
    const root = screen.getByRole('treeitem', { name: /^\$ object/ })
    root.focus()
    await user.keyboard('{ArrowDown}{ArrowDown}')
    expect(document.activeElement).toHaveAccessibleName('$.order.id: A-1')
    await user.tab()
    expect(document.activeElement).toHaveAccessibleName('Copy path $.order.id')
    await user.keyboard('{Enter}')
    expect(await navigator.clipboard.readText()).toBe('$.order.id')
    await user.tab()
    expect(document.activeElement).toHaveAccessibleName('Copy value of $.order.id')
    await user.keyboard('{Enter}')
    expect(await navigator.clipboard.readText()).toBe('A-1')
  })

  it('opens and closes nodes with Left and Right and announces the path of array items', async () => {
    const user = userEvent.setup()
    await openMessage()
    const items = screen.getByRole('treeitem', { name: /^\$\.order\.items array, 2 items/ })
    items.focus()
    expect(items).toHaveAttribute('aria-expanded', 'true')
    await user.keyboard('{ArrowLeft}')
    expect(items).toHaveAttribute('aria-expanded', 'false')
    await user.keyboard('{ArrowRight}')
    expect(items).toHaveAttribute('aria-expanded', 'true')
    await user.keyboard('{ArrowRight}')
    // Level 3 shows the items closed; their names carry the index.
    expect(document.activeElement).toHaveAccessibleName('$.order.items[0] object, 1 key')
    await user.keyboard('{ArrowLeft}')
    expect(document.activeElement).toBe(items)
  })

  it('opens a node the user closed when stepping to a match inside it', async () => {
    await openMessage()
    await userEvent.type(screen.getByRole('textbox', { name: 'Search in JSON' }), 'urgent')
    await waitFor(() => expect(screen.getByTestId('json-match-count')).toHaveTextContent('1 of 2'))
    expect(screen.getAllByText(/^urgent$/i, { selector: 'mark' })).toHaveLength(2)
    await userEvent.click(screen.getByRole('treeitem', { name: /^\$\.order\.items array/ }))
    expect(screen.getAllByText(/^urgent$/i, { selector: 'mark' })).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: 'Next match' }))
    await userEvent.click(screen.getByRole('button', { name: 'Previous match' }))
    expect(screen.getAllByText(/^urgent$/i, { selector: 'mark' })).toHaveLength(2)
  })

  it('highlights the matched text but not the quotes around it', async () => {
    await openMessage()
    await userEvent.type(screen.getByRole('textbox', { name: 'Search in JSON' }), 'sku')
    await waitFor(() => expect(screen.getByTestId('json-match-count')).toHaveTextContent('1 of'))
    const marks = screen.getAllByText('sku', { selector: 'mark' })
    expect(marks.length).toBeGreaterThan(0)
  })
})
