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
})
