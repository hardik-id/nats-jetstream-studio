import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { PublishTab } from '@renderer/features/publish/PublishTab'
import { createFakeGateway } from '@renderer/gateway/fake'
import { renderWithGateway } from './render'

describe('PBI-119 publish page', () => {
  it('shows the page header and a result panel, and Clear form empties the draft', async () => {
    const gateway = createFakeGateway({
      connections: [{ id: 'dev', name: 'Dev', envLabel: 'dev', color: '#059669' }]
    })
    renderWithGateway(<PublishTab connId="dev" subject="orders.created" />, gateway)
    expect(screen.getByRole('heading', { name: 'Publish' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Result' })).toHaveTextContent(
      'appears here after you send'
    )
    const subject = screen.getByLabelText('Subject', { exact: true })
    expect(subject).toHaveValue('orders.created')
    await userEvent.type(screen.getByLabelText('Payload'), 'hello')
    await userEvent.click(screen.getByRole('button', { name: 'Clear form' }))
    expect(subject).toHaveValue('')
    expect(screen.getByLabelText('Payload')).toHaveValue('')
  })

  it('names the stream that stores the subject as you type, or says that none does', async () => {
    const gateway = createFakeGateway({
      connections: [{ id: 'dev', name: 'Dev', envLabel: 'dev', color: '#059669' }]
    })
    await gateway.createStream('dev', { name: 'ORDERS', subjects: ['orders.>'] })
    renderWithGateway(<PublishTab connId="dev" subject="orders.eu.new" />, gateway)
    expect(await screen.findByText('Stored by ORDERS (orders.>).')).toBeInTheDocument()
    const subject = screen.getByLabelText('Subject', { exact: true })
    await userEvent.clear(subject)
    await userEvent.type(subject, 'publish.eu.new')
    expect(
      await screen.findByText('No stream stores this subject. Only live subscribers see it.')
    ).toBeInTheDocument()
  })

  it('explains the send mode under Send as, and warns when JetStream cannot store the subject', async () => {
    const gateway = createFakeGateway({
      connections: [{ id: 'dev', name: 'Dev', envLabel: 'dev', color: '#059669' }]
    })
    renderWithGateway(<PublishTab connId="dev" subject="publish.eu.new" />, gateway)
    expect(
      screen.getByText('Sent without waiting. No confirmation comes back.')
    ).toBeInTheDocument()
    await userEvent.selectOptions(screen.getByLabelText('Send as'), 'jetstream')
    expect(
      screen.getByText('Waits until a stream stores it, and shows the sequence number.')
    ).toBeInTheDocument()
    expect(
      await screen.findByText('No stream stores this subject, so a JetStream publish will fail.')
    ).toBeInTheDocument()
  })
})
