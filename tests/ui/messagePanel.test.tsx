import { useState } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { CollapsibleSection } from '@renderer/components/ui'
import { MessageBrowser } from '@renderer/features/messages/MessageBrowser'
import { createFakeGateway } from '@renderer/gateway/fake'
import { renderWithGateway } from './render'

const doc = {
  order: { id: 'A-1', items: [{ sku: 'x1' }, { sku: 'urgent-2' }], note: 'Urgent' },
  tags: ['a', 'b']
}

async function openMessage(): Promise<void> {
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
  const info = await gateway.streamInfo('dev', 'ORDERS')
  renderWithGateway(<MessageBrowser connId="dev" info={info} />, gateway)
  await userEvent.click(await screen.findByText('orders.eu'))
  await screen.findByRole('complementary', { name: 'Message detail' })
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
    await userEvent.type(within(panel).getByLabelText('Payload contains'), 'urgent')
    await userEvent.click(within(panel).getByRole('button', { name: 'Apply filters' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Filters, 1 active' })).toBeInTheDocument()
    )
    // The chip stays when the panel is closed.
    const field = within(screen.getByRole('form', { name: 'Message filters' })).getByLabelText(
      'Payload contains'
    )
    await userEvent.type(field, '{Escape}')
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Message filters' })).toBeNull())
    expect(screen.getByRole('button', { name: /^Filters/ })).toHaveFocus()
    expect(screen.getByRole('button', { name: /^Filters/ })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(screen.getByLabelText('Active filters')).toHaveTextContent('Payload contains')
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
  it('collapses a section to a summary and leaves the others open', async () => {
    await openMessage()
    const headers = screen.getByRole('button', { name: /^Headers \(2\)/ })
    expect(screen.getByText('Trace-Id')).toBeVisible()
    await userEvent.click(headers)
    await waitFor(() => expect(headers).toHaveAttribute('aria-expanded', 'false'))
    expect(screen.getByText('Region, Trace-Id')).toBeVisible()
    expect(screen.getByRole('button', { name: /^Payload/ })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
  })

  it('collapses to a rail that keeps the selection, and expands again', async () => {
    await openMessage()
    await userEvent.click(screen.getByRole('button', { name: 'Collapse panel' }))
    const rail = await screen.findByRole('complementary', { name: 'Message detail (collapsed)' })
    expect(rail).toHaveTextContent('Message #1')
    expect(screen.queryByRole('separator', { name: 'Resize message detail' })).toBeNull()
    expect(screen.getByTestId('detail-frame')).toHaveStyle({ width: '36px' })
    await userEvent.click(within(rail).getByRole('button', { name: 'Expand message panel' }))
    await screen.findByRole('complementary', { name: 'Message detail' })
    expect(screen.getByRole('separator', { name: 'Resize message detail' })).toBeInTheDocument()
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
    expect(screen.getAllByText('urgent', { selector: 'mark' }).length).toBeGreaterThan(0)
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

  it('copies the path and the value of a row, reachable from the keyboard', async () => {
    const user = userEvent.setup()
    await openMessage()
    const toggle = screen.getByRole('button', { name: /^items array, 2 items/ })
    toggle.focus()
    await user.tab()
    expect(document.activeElement).toHaveAccessibleName('Copy path $.order.items')
    await user.keyboard('{Enter}')
    expect(await navigator.clipboard.readText()).toBe('$.order.items')
    await user.tab()
    expect(document.activeElement).toHaveAccessibleName('Copy value of $.order.items')
    await user.keyboard('{Enter}')
    expect(JSON.parse(await navigator.clipboard.readText())).toEqual(doc.order.items)
  })
})
