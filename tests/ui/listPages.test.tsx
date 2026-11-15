import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ConsumersTab } from '@renderer/features/consumers/ConsumersTab'
import { consumerTotals } from '@renderer/features/consumers/ConsumersPanel'
import { createFakeGateway } from '@renderer/gateway/fake'
import type { ConsumerInfoDto } from '@shared/api'
import { renderWithGateway } from './render'

const consumer = (over: Partial<ConsumerInfoDto>): ConsumerInfoDto =>
  ({
    stream_name: 'ORDERS',
    name: 'c',
    config: { ack_policy: 'explicit' },
    num_pending: 0,
    num_ack_pending: 0,
    num_redelivered: 0,
    num_waiting: 0,
    ...over
  }) as ConsumerInfoDto

describe('PBI-121 consumer summary', () => {
  it('adds up pending, ack pending and consumers that need attention', () => {
    const totals = consumerTotals([
      consumer({ num_pending: 5, num_ack_pending: 2, health: ['stalled'] }),
      consumer({ name: 'd', num_pending: 7 }),
      consumer({ stream_name: 'KV_x', num_pending: 100, health: ['stalled'] })
    ])
    expect(totals).toEqual({ pending: 12, ackPending: 2, attention: 1 })
  })

  it('shows the heading and three cards on the consumers page', async () => {
    const gateway = createFakeGateway({
      connections: [{ id: 'dev', name: 'Dev', envLabel: 'dev', color: '#059669' }]
    })
    renderWithGateway(<ConsumersTab connId="dev" />, gateway)
    const cards = await screen.findAllByTestId('summary-card')
    expect(cards).toHaveLength(3)
    expect(within(cards[2]).getByText('All consumers healthy')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Consumers' })).toBeInTheDocument()
  })
})
