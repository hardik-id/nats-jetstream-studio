import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { MessageBrowser } from '@renderer/features/messages/MessageBrowser'
import { createFakeGateway } from '@renderer/gateway/fake'
import { renderWithGateway } from './render'

async function openPanel(): Promise<HTMLElement> {
  const gateway = createFakeGateway({ connections: [{ id: 'dev', name: 'Dev' }] })
  gateway.streams.set('ORDERS', {
    config: {
      name: 'ORDERS',
      subjects: ['orders.>'],
      storage: 'file',
      retention: 'limits',
      num_replicas: 1
    },
    messages: [{ seq: 1, subject: 'orders.eu', payload: '{"a":1}', time: '2026-01-01T00:00:00Z' }],
    consumers: []
  })
  const info = await gateway.streamInfo('dev', 'ORDERS')
  renderWithGateway(<MessageBrowser connId="dev" info={info} />, gateway)
  await userEvent.click(await screen.findByText('orders.eu'))
  return screen.findByRole('separator', { name: 'Resize message detail' })
}

describe('PBI-117 detail panel resize', () => {
  it('starts at least 440 px wide and resizes with the arrow keys', async () => {
    const sep = await openPanel()
    const start = Number(sep.getAttribute('aria-valuenow'))
    expect(start).toBeGreaterThanOrEqual(440)
    fireEvent.keyDown(sep, { key: 'ArrowLeft' })
    await waitFor(() => expect(Number(sep.getAttribute('aria-valuenow'))).toBeGreaterThan(start))
    fireEvent.keyDown(sep, { key: 'Home' })
    await waitFor(() => expect(Number(sep.getAttribute('aria-valuenow'))).toBe(440))
    fireEvent.keyDown(sep, { key: 'ArrowRight' })
    await waitFor(() => expect(Number(sep.getAttribute('aria-valuenow'))).toBe(440))
  })
})
