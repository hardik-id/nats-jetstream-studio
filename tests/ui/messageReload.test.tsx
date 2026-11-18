import { useQuery } from '@tanstack/react-query'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { MessageBrowser } from '@renderer/features/messages/MessageBrowser'
import { createFakeGateway } from '@renderer/gateway/fake'
import { useGateway } from '@renderer/gateway'
import { renderWithGateway } from './render'

// The stream page owns the stream info and passes it down, as it does in the app.
function Page({ connId, stream }: { connId: string; stream: string }): React.ReactNode {
  const gateway = useGateway()
  const query = useQuery({
    queryKey: ['stream', connId, stream],
    queryFn: () => gateway.streamInfo(connId, stream)
  })
  return query.data ? <MessageBrowser connId={connId} info={query.data} /> : null
}

const msg = (seq: number, subject = 'orders.eu') => ({
  seq,
  subject,
  payload: `body ${seq}`,
  time: '2026-01-01T00:00:00Z'
})

describe('Reload view', () => {
  it('reads the stream again, shows what was published since and shows it is working', async () => {
    const gateway = createFakeGateway({ connections: [{ id: 'dev', name: 'Dev' }] })
    gateway.streams.set('ORDERS', {
      config: {
        name: 'ORDERS',
        subjects: ['orders.>'],
        storage: 'file',
        retention: 'limits',
        num_replicas: 1
      },
      messages: [msg(1), msg(2)],
      consumers: []
    })
    renderWithGateway(<Page connId="dev" stream="ORDERS" />, gateway)
    await screen.findByText('body 2')
    const infoCalls = (): number => gateway.calls.filter((c) => c.method === 'streamInfo').length
    const before = infoCalls()

    gateway.streams.get('ORDERS')!.messages.push(msg(3))
    // Hold the next read open to see the state while it loads.
    const read = gateway.getMessages.bind(gateway)
    let release = (): void => {}
    gateway.getMessages = (async (...args: Parameters<typeof read>) => {
      await new Promise<void>((resolve) => (release = resolve))
      return read(...args)
    }) as typeof gateway.getMessages

    const button = screen.getByRole('button', { name: 'Reload view' })
    await userEvent.click(button)
    await waitFor(() => expect(button).toBeDisabled())
    release()
    await screen.findByText('body 3')
    await waitFor(() => expect(button).toBeEnabled())
    // The stream info (counts, bounds) was read again too.
    expect(infoCalls()).toBeGreaterThan(before)
  })
})
