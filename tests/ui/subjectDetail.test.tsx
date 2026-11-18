import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SubjectDetail } from '@renderer/features/subjects/SubjectDetail'
import {
  buildTree,
  type StreamPatterns,
  type SubjectInfo
} from '@renderer/features/subjects/subjectTree'
import { createFakeGateway } from '@renderer/gateway/fake'
import { useTabs } from '@renderer/state/tabs'
import { renderWithGateway } from './render'

const PATTERNS: StreamPatterns[] = [
  { name: 'ORDERS', subjects: ['orders.>'] },
  { name: 'AUDIT', subjects: ['orders.*.created'] },
  { name: 'EMPTY', subjects: ['orders.>'] }
]

const tree = buildTree(
  [
    {
      stream: 'ORDERS',
      subjects: [
        { subject: 'orders', count: 5 },
        { subject: 'orders.eu.created', count: 70 },
        { subject: 'orders.eu.paid', count: 4 }
      ]
    },
    { stream: 'AUDIT', subjects: [{ subject: 'orders.eu.created', count: 10 }] },
    { stream: 'LOGS', subjects: [{ subject: 'logs.app', count: 1 }] }
  ],
  { 'live.only': 3, 'a..b': 1, 'orders.eu.created': 2, 'orders.fresh': 1 },
  [...PATTERNS, { name: 'LOGS', subjects: ['logs.>'] }]
)
const node = (p: string): SubjectInfo => tree.byPath.get(p)!

function show(path: string | null, readOnly = false) {
  const gateway = createFakeGateway({
    connections: [{ id: 'dev', name: 'Dev', envLabel: 'dev', color: '#059669' }]
  })
  return renderWithGateway(
    <SubjectDetail
      connId="dev"
      node={path ? node(path) : null}
      streams={[...PATTERNS, { name: 'LOGS', subjects: ['logs.>'] }]}
      readOnly={readOnly}
    />,
    gateway
  )
}

const filter = () => screen.getByTestId('subject-filter')
const button = (name: string | RegExp) => screen.getByRole('button', { name })

describe('PBI-127 subject detail', () => {
  it('shows a hint without a selection', () => {
    show(null)
    expect(screen.getByText(/Select a subject/)).toBeInTheDocument()
  })

  it('a branch with own messages defaults to everything below and says it excludes itself', () => {
    show('orders')
    expect(filter()).toHaveTextContent('orders.>')
    expect(
      screen.getByRole('radio', { name: 'Everything below orders (not orders itself)' })
    ).toBeChecked()
    expect(screen.getByRole('radio', { name: 'This subject (orders)' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'One level below orders' })).toBeInTheDocument()
  })

  it('a branch without own messages offers only the wildcard scopes', () => {
    show('orders.eu')
    expect(screen.queryByRole('radio', { name: /This subject/ })).toBeNull()
    expect(screen.getByRole('radio', { name: 'Everything below orders.eu' })).toBeChecked()
    expect(filter()).toHaveTextContent('orders.eu.>')
  })

  it('a leaf offers only this subject', () => {
    show('orders.eu.paid')
    expect(screen.getAllByRole('radio')).toHaveLength(1)
    expect(filter()).toHaveTextContent('orders.eu.paid')
  })

  it('shows counts with labels and the streams, including empty capturing streams', () => {
    show('orders')
    expect(screen.getByText('Stored on this subject')).toBeInTheDocument()
    expect(screen.getByText('Stored below')).toBeInTheDocument()
    expect(screen.getByText('Live on this subject')).toBeInTheDocument()
    const list = screen.getByRole('list', { name: 'Streams for this scope' })
    expect(within(list).getByText('ORDERS')).toBeInTheDocument()
    expect(within(list).getByText('AUDIT')).toBeInTheDocument()
    expect(within(list).getByText('EMPTY')).toBeInTheDocument()
    expect(within(list).queryByText('LOGS')).toBeNull()
    expect(within(list).getByText(/nothing stored here/)).toBeInTheDocument()
  })

  it('the scope decides the filter that Browse and Live tail open with', async () => {
    show('orders')
    await userEvent.click(button('Start live tail'))
    expect(useTabs.getState().tabs.at(-1)?.spec).toMatchObject({
      kind: 'tail',
      connId: 'dev',
      subject: 'orders.>'
    })
    await userEvent.click(screen.getByRole('radio', { name: 'One level below orders' }))
    expect(filter()).toHaveTextContent('orders.*')
    await userEvent.click(button('Start live tail'))
    expect(useTabs.getState().tabs.at(-1)?.spec).toMatchObject({ subject: 'orders.*' })
    await userEvent.click(screen.getByRole('radio', { name: 'This subject (orders)' }))
    await userEvent.click(button('Browse stored messages'))
    expect(useTabs.getState().tabs.at(-1)?.spec).toMatchObject({
      kind: 'messages',
      stream: 'ORDERS',
      subject: 'orders'
    })
  })

  it('offers a stream chooser when several streams hold the subject', async () => {
    show('orders.eu.created')
    await userEvent.click(button(/Stream to browse: ORDERS/))
    await userEvent.click(screen.getByRole('menuitem', { name: 'AUDIT' }))
    await userEvent.click(button('Browse stored messages'))
    expect(useTabs.getState().tabs.at(-1)?.spec).toMatchObject({
      kind: 'messages',
      stream: 'AUDIT',
      subject: 'orders.eu.created'
    })
  })

  it('Publish opens the tab with the exact subject only for the subject scope', async () => {
    show('orders')
    const publish = button('Publish message')
    expect(publish).toBeDisabled()
    expect(screen.getByText(/Publishing needs one exact subject/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('radio', { name: 'This subject (orders)' }))
    expect(publish).toBeEnabled()
    await userEvent.click(publish)
    expect(useTabs.getState().tabs.at(-1)?.spec).toMatchObject({
      kind: 'publish',
      connId: 'dev',
      subject: 'orders'
    })
  })

  it('read-only disables Publish with the reason as text and opens no tab', async () => {
    show('orders.eu.paid', true)
    const publish = button('Publish message')
    expect(publish).toBeDisabled()
    expect(screen.getByText(/This connection is read-only/)).toBeInTheDocument()
    await userEvent.click(publish)
    expect(useTabs.getState().tabs).toHaveLength(0)
    expect(button('Start live tail')).toBeEnabled()
    expect(button('Browse stored messages')).toBeEnabled()
  })

  it('disables Browse with the reason when no stream holds a live-only subject', () => {
    show('live.only')
    expect(button('Browse stored messages')).toBeDisabled()
    expect(screen.getByText(/No stream stores or captures this subject/)).toBeInTheDocument()
    expect(screen.getByText('live only')).toBeInTheDocument()
    expect(button('Start live tail')).toBeEnabled()
  })

  it('an invalid subject says why nothing is available', () => {
    show('a..b')
    expect(screen.getByRole('note')).toHaveTextContent(/Not a valid subject/)
    expect(screen.queryByRole('group', { name: 'Scope' })).toBeNull()
    expect(screen.getAllByText(/cannot be used as a filter|no scope/)).toHaveLength(1)
    expect(button('Browse stored messages')).toBeDisabled()
    expect(button('Start live tail')).toBeDisabled()
    expect(button('Publish message')).toBeDisabled()
  })

  it('keeps the section state, and resets scope and stream, when another subject is selected', async () => {
    const streams = [...PATTERNS, { name: 'LOGS', subjects: ['logs.>'] }]
    const gateway = createFakeGateway({
      connections: [{ id: 'dev', name: 'Dev', envLabel: 'dev', color: '#059669' }]
    })
    const el = (path: string) => <SubjectDetail connId="dev" node={node(path)} streams={streams} />
    const { rerender } = renderWithGateway(el('orders'), gateway)
    await userEvent.click(screen.getByRole('radio', { name: 'One level below orders' }))
    await userEvent.click(screen.getByRole('button', { name: /^Messages/ }))
    expect(screen.getByRole('button', { name: /^Messages/ })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    rerender(el('orders.eu.created'))
    expect(filter()).toHaveTextContent('orders.eu.created')
    expect(screen.getByRole('button', { name: /^Messages/ })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    await userEvent.click(button(/Stream to browse: ORDERS/))
    await userEvent.click(screen.getByRole('menuitem', { name: 'AUDIT' }))
    rerender(el('orders.eu.paid'))
    rerender(el('orders.eu.created'))
    expect(button(/Stream to browse: ORDERS/)).toBeInTheDocument()
  })

  it('hints that a capture-only stream has no stored messages', () => {
    show('orders.fresh')
    // orders.fresh was only seen live at all: streams that capture it are offered, with nothing stored.
    expect(screen.getByText(/No stored messages yet in/)).toBeInTheDocument()
  })

  it('announces copy success and failure', async () => {
    show('orders.eu.paid')
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await userEvent.click(button('Copy subject'))
    expect(writeText).toHaveBeenCalledWith('orders.eu.paid')
    expect(await screen.findByText('Copied subject')).toBeInTheDocument()
    writeText.mockRejectedValue(new Error('denied'))
    await userEvent.click(button(/Copy filter/))
    expect(await screen.findByText(/Could not copy/)).toBeInTheDocument()
  })
})
