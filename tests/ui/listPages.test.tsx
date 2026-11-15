import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ConsumersTab } from '@renderer/features/consumers/ConsumersTab'
import { consumerTotals, HealthBadges } from '@renderer/features/consumers/ConsumersPanel'
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

describe('PBI-123 health cell', () => {
  it('shows the first badge, +N and the full list in the tooltip when several flags are set', () => {
    render(<HealthBadges c={consumer({ health: ['lag_growing', 'ack_pending_max'] })} />)
    expect(screen.getByText('Lagging')).toBeInTheDocument()
    const more = screen.getByText('+1')
    expect(more.parentElement).toHaveAttribute('title', 'Lag keeps growing, Ack pending at maximum')
  })

  it('shows a single badge without +N', () => {
    render(<HealthBadges c={consumer({ health: ['stalled'] })} />)
    expect(screen.getByText('Inactive')).toBeInTheDocument()
    expect(screen.queryByText(/^\+/)).toBeNull()
  })
})
