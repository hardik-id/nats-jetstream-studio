import { useQuery } from '@tanstack/react-query'
import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageBrowser } from '@renderer/features/messages/MessageBrowser'
import { createFakeGateway, type FakeGateway } from '@renderer/gateway/fake'
import { useGateway } from '@renderer/gateway'
import { renderWithGateway } from './render'

function Page({ connId, stream }: { connId: string; stream: string }): React.ReactNode {
  const gateway = useGateway()
  const query = useQuery({
    queryKey: ['stream', connId, stream],
    queryFn: () => gateway.streamInfo(connId, stream)
  })
  return query.data ? <MessageBrowser connId={connId} info={query.data} /> : null
}

const msg = (seq: number) => ({
  seq,
  subject: 'orders.eu',
  payload: `body ${seq}`,
  time: '2026-01-01T00:00:00Z'
})

function setup(count = 2): { gateway: FakeGateway; unmount: () => void } {
  const gateway = createFakeGateway({ connections: [{ id: 'dev', name: 'Dev' }] })
  gateway.streams.set('ORDERS', {
    config: {
      name: 'ORDERS',
      subjects: ['orders.>'],
      storage: 'file',
      retention: 'limits',
      num_replicas: 1
    },
    messages: Array.from({ length: count }, (_, i) => msg(i + 1)),
    consumers: []
  })
  const { unmount } = renderWithGateway(<Page connId="dev" stream="ORDERS" />, gateway)
  return { gateway, unmount }
}
const reads = (g: FakeGateway): number => g.calls.filter((c) => c.method === 'getMessages').length
const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))

describe('Live', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
  afterEach(() => vi.useRealTimers())

  it('is off by default and shows new messages when the last sequence grows', async () => {
    const { gateway } = setup()
    await screen.findByText('body 2')
    const live = screen.getByRole('button', { name: 'Live' })
    expect(live).toHaveAttribute('aria-pressed', 'false')
    expect(live).toHaveAttribute('title', 'Show new messages as they arrive')
    // Off: nothing is read on its own.
    gateway.streams.get('ORDERS')!.messages.push(msg(3))
    await tick(10_000)
    expect(screen.queryByText('body 3')).toBeNull()

    await userEvent.click(live)
    expect(live).toHaveAttribute('aria-pressed', 'true')
    await screen.findByText('body 3')
    gateway.streams.get('ORDERS')!.messages.push(msg(4))
    await tick(2500)
    await screen.findByText('body 4')
  })

  it('does not read again while the last sequence is unchanged', async () => {
    const { gateway } = setup()
    await screen.findByText('body 2')
    await userEvent.click(screen.getByRole('button', { name: 'Live' }))
    await screen.findByText('body 2')
    await tick(2500)
    const before = reads(gateway)
    await tick(10_000)
    expect(reads(gateway)).toBe(before)
  })

  it('turns off when paging, and stops polling', async () => {
    const { gateway } = setup(60)
    await screen.findByText('body 60')
    const live = screen.getByRole('button', { name: 'Live' })
    await userEvent.click(live)
    await screen.findByText('body 60')
    await tick(2500)
    await userEvent.click(screen.getByRole('button', { name: /^Next$/ }))
    expect(live).toHaveAttribute('aria-pressed', 'false')
    const infoCalls = (): number => gateway.calls.filter((c) => c.method === 'streamInfo').length
    await tick(2500)
    const before = infoCalls()
    await tick(10_000)
    expect(infoCalls()).toBe(before)
  })

  it('stops polling when the tab goes away', async () => {
    const { gateway, unmount } = setup()
    await screen.findByText('body 2')
    await userEvent.click(screen.getByRole('button', { name: 'Live' }))
    await tick(2500)
    unmount()
    const before = gateway.calls.length
    await tick(10_000)
    expect(gateway.calls.length).toBe(before)
  })
})
