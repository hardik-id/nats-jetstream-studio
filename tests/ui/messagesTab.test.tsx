import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { ReactNode } from 'react'
import { MessagesTab } from '@renderer/features/messages/MessagesTab'
import { openMessages } from '@renderer/features/shell/nav'
import { StreamTab } from '@renderer/features/streams/StreamTab'
import { createFakeGateway, type FakeGateway } from '@renderer/gateway/fake'
import { useTabs } from '@renderer/state/tabs'
import { renderWithGateway } from './render'

const msg = (seq: number, subject: string, payload: string) => ({
  seq,
  subject,
  payload,
  time: '2026-01-01T00:00:00Z'
})

function gatewayWith(...names: string[]): FakeGateway {
  const gateway = createFakeGateway({ connections: [{ id: 'dev', name: 'Dev' }] })
  for (const name of names) {
    const prefix = name.toLowerCase()
    gateway.streams.set(name, {
      config: {
        name,
        subjects: [`${prefix}.>`],
        storage: 'file',
        retention: 'limits',
        num_replicas: 1
      },
      messages: [
        msg(1, `${prefix}.eu`, `${prefix} one`),
        msg(2, `${prefix}.us`, `${prefix} two`),
        msg(3, `${prefix}.eu`, `${prefix} three`)
      ],
      consumers: []
    })
  }
  return gateway
}

/** Renders the Messages tab of `dev` from the tab store, as the tab host does. */
function Host(): ReactNode {
  const tab = useTabs((s) => s.tabs.find((t) => t.id === 'messages:dev'))
  if (!tab || tab.spec.kind !== 'messages') return null
  const { connId, stream, subject, seq } = tab.spec
  return <MessagesTab tabId={tab.id} connId={connId} stream={stream} subject={subject} seq={seq} />
}

function setup(gateway: FakeGateway, target?: Parameters<typeof openMessages>[1]): void {
  renderWithGateway(<Host />, gateway)
  act(() => openMessages('dev', target))
}

const spec = () => useTabs.getState().tabs.find((t) => t.id === 'messages:dev')!.spec
const picker = (): HTMLElement => screen.getByRole('combobox', { name: 'Stream' })

describe('PBI-128 Messages screen', () => {
  it('asks for a stream first, with the picker focused', async () => {
    setup(gatewayWith('ORDERS', 'AUDIT'))
    expect(await screen.findByText('Choose a stream to browse its messages')).toBeInTheDocument()
    expect(picker()).toHaveFocus()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('filters the picker as you type and loads the chosen stream', async () => {
    const gateway = gatewayWith('ORDERS', 'AUDIT', 'ORDERS_ARCHIVE')
    setup(gateway)
    await screen.findByText('Choose a stream to browse its messages')
    await userEvent.type(picker(), 'arch')
    const list = screen.getByRole('listbox', { name: 'Streams' })
    expect(
      within(list)
        .getAllByRole('option')
        .map((o) => o.textContent)
    ).toEqual(['ORDERS_ARCHIVE3'])
    await userEvent.clear(picker())
    await userEvent.type(picker(), 'audit{Enter}')
    expect(await screen.findByText('audit three')).toBeInTheDocument()
    expect(spec()).toMatchObject({ stream: 'AUDIT' })
    expect(picker()).toHaveValue('AUDIT')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('is usable with the keyboard alone', async () => {
    setup(gatewayWith('AUDIT', 'ORDERS'))
    await screen.findByText('Choose a stream to browse its messages')
    await userEvent.keyboard('{ArrowDown}')
    expect(screen.getAllByRole('option')).toHaveLength(2)
    await userEvent.keyboard('{ArrowDown}{Enter}')
    expect(await screen.findByText('orders three')).toBeInTheDocument()
    // Escape closes the list and keeps the stream.
    await userEvent.click(picker())
    await userEvent.keyboard('x{Escape}')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(picker()).toHaveValue('ORDERS')
  })

  it('opens on a subject and resets the filters for another stream', async () => {
    setup(gatewayWith('ORDERS', 'AUDIT'), { stream: 'ORDERS', subject: 'orders.eu' })
    expect(await screen.findByText('orders three')).toBeInTheDocument()
    expect(screen.getByLabelText('Subject filter')).toHaveValue('orders.eu')
    await waitFor(() => expect(screen.queryByText('orders two')).toBeNull())

    await userEvent.click(picker())
    await userEvent.click(screen.getByRole('option', { name: /AUDIT/ }))
    expect(await screen.findByText('audit two')).toBeInTheDocument()
    expect(screen.getByLabelText('Subject filter')).toHaveValue('')
    expect(spec()).toMatchObject({ stream: 'AUDIT', subject: undefined, seq: undefined })
  })

  it('opens at a sequence, and a later link on the same tab moves it', async () => {
    setup(gatewayWith('ORDERS', 'AUDIT'), { stream: 'ORDERS', seq: 2 })
    expect(await screen.findByText('orders two')).toBeInTheDocument()
    expect(screen.getByLabelText('Sequence')).toHaveValue('2')
    expect(screen.queryByText('orders one')).toBeNull()

    act(() => openMessages('dev', { stream: 'AUDIT', subject: 'audit.us' }))
    expect(await screen.findByText('audit two')).toBeInTheDocument()
    expect(screen.getByLabelText('Subject filter')).toHaveValue('audit.us')
    expect(useTabs.getState().tabs).toHaveLength(1)
  })

  it('chooses the only stream of a connection by itself', async () => {
    setup(gatewayWith('ONLY'))
    expect(await screen.findByText('only three')).toBeInTheDocument()
    expect(picker()).toHaveValue('ONLY')
  })

  it('says when the connection has no streams', async () => {
    setup(gatewayWith())
    expect(await screen.findByText('This connection has no streams')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Open Streams' }))
    expect(useTabs.getState().activeId).toBe('streams:dev')
  })

  it('says when the chosen stream was deleted and forgets it', async () => {
    const gateway = gatewayWith('ORDERS', 'AUDIT')
    setup(gateway, { stream: 'ORDERS', subject: 'orders.eu' })
    expect(await screen.findByText('orders three')).toBeInTheDocument()

    gateway.streams.delete('ORDERS')
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(await screen.findByText(/no longer exists/)).toHaveTextContent(
      'Stream ORDERS no longer exists'
    )
    expect(spec()).toMatchObject({ stream: undefined, subject: undefined })
    expect(useTabs.getState().tabs[0].id).toBe('messages:dev')

    await userEvent.click(picker())
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1))
    await userEvent.click(screen.getByRole('option', { name: /AUDIT/ }))
    expect(await screen.findByText('audit three')).toBeInTheDocument()
    expect(screen.queryByText(/no longer exists/)).toBeNull()
  })

  it('shows a stream info error with a retry', async () => {
    const gateway = gatewayWith('ORDERS', 'AUDIT')
    const real = gateway.streamInfo.bind(gateway)
    let fail = true
    gateway.streamInfo = (async (...args: Parameters<typeof real>) => {
      if (fail) throw new Error('JetStream not available')
      return real(...args)
    }) as typeof gateway.streamInfo
    setup(gateway, { stream: 'ORDERS' })
    expect(await screen.findByRole('alert')).toHaveTextContent('JetStream not available')
    fail = false
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('orders three')).toBeInTheDocument()
  })

  it('opens the stream page from the header', async () => {
    setup(gatewayWith('ORDERS', 'AUDIT'), { stream: 'ORDERS' })
    await screen.findByText('orders three')
    await userEvent.click(screen.getByRole('button', { name: 'Open stream' }))
    expect(useTabs.getState().activeId).toBe('stream:dev:ORDERS')
  })
})

describe('PBI-128 stream page', () => {
  it('has no Messages section and browses messages in the Messages tab', async () => {
    renderWithGateway(
      <StreamTab tabId="stream:dev:ORDERS" connId="dev" stream="ORDERS" />,
      gatewayWith('ORDERS')
    )
    await screen.findByRole('tab', { name: 'Overview' })
    expect(screen.queryByRole('tab', { name: 'Messages' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Browse messages' }))
    expect(useTabs.getState().tabs.at(-1)).toMatchObject({
      id: 'messages:dev',
      spec: { kind: 'messages', stream: 'ORDERS', subject: undefined, seq: undefined }
    })
  })

  it('opens an unknown stored section on Overview', async () => {
    renderWithGateway(
      <StreamTab
        tabId="stream:dev:ORDERS"
        connId="dev"
        stream="ORDERS"
        section={'messages' as never}
      />,
      gatewayWith('ORDERS')
    )
    expect(await screen.findByRole('tab', { name: 'Overview' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
  })
})
