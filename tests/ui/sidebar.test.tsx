import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import App from '@renderer/App'
import { createFakeGateway } from '@renderer/gateway/fake'
import { requestRail, useRail } from '@renderer/state/ui'
import { renderWithGateway } from './render'

function gateway(): ReturnType<typeof createFakeGateway> {
  return createFakeGateway({
    connections: [{ id: 'dev', name: 'Dev', envLabel: 'dev', color: '#059669' }]
  })
}

afterEach(() => useRail.setState({ owners: {} }))

describe('PBI-115 sidebar icon rail', () => {
  it('toggles with the button and the shortcut, and saves the choice', async () => {
    const { gateway: gw } = renderWithGateway(<App status="ready" />, gateway())
    const nav = await screen.findByRole('navigation', { name: 'Connections' })
    expect(await within(nav).findByRole('group', { name: 'Dev' })).toBeInTheDocument()

    await userEvent.click(within(nav).getByRole('button', { name: 'Collapse sidebar' }))
    const rail = await screen.findByRole('navigation', { name: 'Connections' })
    expect(within(rail).queryByRole('group')).toBeNull()
    const expand = within(rail).getByRole('button', { name: 'Expand sidebar' })
    expect(expand).toHaveAttribute('title', expect.stringContaining('Expand'))
    await waitFor(async () => expect(await gw.getSetting('ui.sidebarRail')).toBe(true))
    expect(within(rail).getByRole('button', { name: /^Dev,/ })).toHaveAttribute('title')

    await userEvent.keyboard('{Control>}b{/Control}')
    expect(await screen.findByRole('group', { name: 'Dev' })).toBeInTheDocument()
  })

  it('shows the rail while a page asks for it and goes back to the user choice', async () => {
    renderWithGateway(<App status="ready" />, gateway())
    expect(await screen.findByRole('group', { name: 'Dev' })).toBeInTheDocument()
    act(() => requestRail('messages', true))
    expect(screen.queryByRole('group', { name: 'Dev' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeDisabled()
    act(() => requestRail('messages', false))
    expect(await screen.findByRole('group', { name: 'Dev' })).toBeInTheDocument()
  })
})
