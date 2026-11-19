import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useState, type ReactNode } from 'react'
import type { ConsumerInfoDto } from '@shared/api'
import { openNav } from '@renderer/features/shell/nav'
import { TraceTab } from '@renderer/features/trace/TraceTab'
import { TRACE_VIEWS } from '@renderer/features/trace/views/registry'
import { createFakeGateway, type FakeGateway } from '@renderer/gateway/fake'
import { TabActiveContext } from '@renderer/lib/hooks'
import { useTabs } from '@renderer/state/tabs'
import { renderWithGateway } from './render'
import { reducedMotion, stubMotionPreference } from './graphEnv'

const ago = (seconds: number): string => new Date(Date.now() - seconds * 1000).toISOString()
const consumer = (name: string, stream: string, filter: string): ConsumerInfoDto =>
  ({
    stream_name: stream,
    name,
    created: ago(86_400),
    config: { ack_policy: 'explicit', deliver_policy: 'all', filter_subject: filter },
    delivered: { consumer_seq: 9, stream_seq: 9 },
    ack_floor: { consumer_seq: 9, stream_seq: 9 },
    num_ack_pending: 0,
    num_redelivered: 0,
    num_waiting: 0,
    num_pending: 0
  }) as ConsumerInfoDto

/**
 * One request across three streams: orders.new (received by order-svc), pay.charge (received by
 * billing), pay.charge again 4 s later (a repeat), ship.pack.
 */
function gatewayForGraph(): FakeGateway {
  const gateway = createFakeGateway({ connections: [{ id: 'dev', name: 'Dev' }] })
  const h: [string, string][] = [['trace-id', 'abc']]
  const stream = (name: string, subjects: [string, number][], consumers: ConsumerInfoDto[]) =>
    gateway.streams.set(name, {
      config: {
        name,
        subjects: [`${name.toLowerCase()}.>`],
        storage: 'file',
        retention: 'limits',
        num_replicas: 1
      },
      messages: subjects.map(([subject, seconds], i) => ({
        seq: i + 1,
        subject,
        payload: '{}',
        time: ago(seconds),
        headers: h
      })),
      consumers
    })
  stream('ORDERS', [['orders.new', 100]], [consumer('order-svc', 'ORDERS', 'orders.new')])
  stream(
    'PAY',
    [
      ['pay.charge', 99],
      ['pay.charge', 95]
    ],
    [consumer('billing', 'PAY', 'pay.charge')]
  )
  stream('SHIP', [['ship.pack', 94.5]], [])
  return gateway
}

function Host(): ReactNode {
  const tab = useTabs((s) => s.tabs.find((t) => t.spec.kind === 'trace'))
  if (!tab || tab.spec.kind !== 'trace') return null
  return (
    <TraceTab
      tabId={tab.id}
      connId={tab.spec.connId}
      query={tab.spec.query}
      view={tab.spec.view}
      viewSettings={tab.spec.viewSettings}
    />
  )
}

const tab = () =>
  useTabs.getState().tabs[0].spec as Extract<
    ReturnType<typeof useTabs.getState>['tabs'][number]['spec'],
    { kind: 'trace' }
  >

async function openGraph(
  user: ReturnType<typeof userEvent.setup>,
  ui: ReactNode = <Host />
): Promise<HTMLElement> {
  renderWithGateway(<>{ui}</>, gatewayForGraph())
  act(() => openNav('dev', 'trace'))
  await user.type(screen.getByRole('textbox', { name: 'Header name 1' }), 'trace-id')
  await user.type(screen.getByRole('textbox', { name: 'Value 1' }), 'abc')
  await user.click(screen.getByRole('button', { name: 'Run trace' }))
  await screen.findByRole('table', { name: 'Trace timeline' })
  await user.selectOptions(screen.getByRole('combobox', { name: 'View' }), 'graph')
  const graph = await screen.findByRole('application', { name: 'Trace graph' })
  // The consumers are read after the messages: wait for their nodes.
  await screen.findByRole('img', { name: /^Consumer billing on PAY/ })
  return graph
}

const node = (name: RegExp): HTMLElement => screen.getByRole('img', { name })
// Clicks on the graph use fireEvent: user-event's mousedown has no window, which d3-zoom needs.
const current = (): string[] =>
  screen
    .getAllByRole('img')
    .filter((e) => e.getAttribute('aria-current') === 'true')
    .map((e) => e.getAttribute('aria-label')!)
const detail = (): HTMLElement => screen.getByRole('complementary', { name: 'Message detail' })

let restore: () => void
beforeEach(() => {
  restore = stubMotionPreference()
})
afterEach(() => restore())

describe('PBI-138 phase 3: Graph view', () => {
  it('is a lazy entry of the registry with its own controls', () => {
    const graph = TRACE_VIEWS.find((v) => v.id === 'graph')!
    expect(graph.label).toBe('Graph')
    // React.lazy: loaded on first use, so the graph library is a chunk of its own.
    expect((graph.Component as unknown as { $$typeof: symbol }).$$typeof).toBe(
      Symbol.for('react.lazy')
    )
    expect(graph.controls?.map((c) => [c.id, c.placement ?? 'bar'])).toEqual([
      ['showConsumers', 'bar'],
      ['animate', 'bar'],
      ['groupSubjects', 'more']
    ])
    // The same setting as Lanes, so "Group similar subjects" carries across views.
    const lanes = TRACE_VIEWS.find((v) => v.id === 'lanes')!
    expect(lanes.controls?.some((c) => c.id === 'groupSubjects')).toBe(true)
  })

  it('loads on switching to Graph and draws subjects and consumers with a text summary', async () => {
    const user = userEvent.setup()
    const graph = await openGraph(user)
    expect(tab().view).toBe('graph')
    expect(node(/^Subject orders\.new, stream ORDERS, 1 message$/)).toBeInTheDocument()
    expect(node(/^Subject pay\.charge, stream PAY, 2 messages$/)).toBeInTheDocument()
    expect(node(/^Subject ship\.pack, stream SHIP, 1 message$/)).toBeInTheDocument()
    expect(node(/^Consumer order-svc on ORDERS: 1 done$/)).toBeInTheDocument()
    expect(node(/^Consumer billing on PAY: 2 done$/)).toBeInTheDocument()
    // The summary is the text alternative of the picture.
    const summary = document.getElementById(graph.getAttribute('aria-describedby')!)!
    expect(summary).toHaveTextContent(
      '3 subjects, 2 consumers, 4 messages, 1 repeat. Slowest hop: +4.0 s before pay.charge.'
    )
    // Edges are named too: known deliveries and inferred hops, with the repeat.
    expect(
      screen.getByRole('img', {
        name: 'orders.new to order-svc: delivered (known)'
      })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('img', {
        name: /^billing to pay\.charge: next message \(inferred from time\), a repeat, about 4\.0 s, slowest hop$/
      })
    ).toBeInTheDocument()
    expect(screen.getAllByTestId('graph-edge-label').map((e) => e.textContent)).toContain(
      'repeat · ~4.0 s'
    )
    expect(screen.getByText('SLOWEST')).toBeInTheDocument()
  })

  it('its controls are view settings in the tab spec; consumers off routes subject to subject', async () => {
    const user = userEvent.setup()
    await openGraph(user)
    expect(screen.getByRole('checkbox', { name: 'Show consumers' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Animate' })).toBeChecked()
    await user.click(screen.getByRole('checkbox', { name: 'Show consumers' }))
    expect(screen.queryByRole('img', { name: /^Consumer / })).toBeNull()
    expect(screen.getByRole('img', { name: /^orders\.new to pay\.charge: next message/ }))
    expect(tab().viewSettings).toEqual({ showConsumers: false })
    await user.click(screen.getByRole('button', { name: 'More' }))
    expect(screen.getByRole('checkbox', { name: /Group similar subjects/ })).toBeChecked()
  })

  it('moves dots along the edges, and none when the system asks for reduced motion or Animate is off', async () => {
    const user = userEvent.setup()
    await openGraph(user)
    expect(screen.getAllByTestId('graph-dot').length).toBeGreaterThan(0)
    const motion = screen.getAllByTestId('graph-dot')[0].querySelector('animateMotion')!
    expect(motion.getAttribute('path')).toMatch(/^M/)
    await user.click(screen.getByRole('checkbox', { name: 'Animate' }))
    expect(screen.queryAllByTestId('graph-dot')).toHaveLength(0)
    await user.click(screen.getByRole('checkbox', { name: 'Animate' }))
    expect(screen.getAllByTestId('graph-dot').length).toBeGreaterThan(0)

    let undo = (): void => {}
    try {
      act(() => {
        undo = reducedMotion()
      })
      await waitFor(() => expect(screen.queryAllByTestId('graph-dot')).toHaveLength(0))
      expect(screen.getByText(/the system asks for reduced motion/)).toBeInTheDocument()
    } finally {
      act(() => undo())
    }
  })

  it('a click on a node selects its message, again steps to its next one; the pane opens', async () => {
    const user = userEvent.setup()
    await openGraph(user)
    fireEvent.click(node(/^Subject pay\.charge/))
    expect(within(detail()).getAllByText('pay.charge').length).toBeGreaterThan(0)
    expect(within(detail()).getByText(/^Message #1$/i)).toBeInTheDocument()
    expect(current()).toEqual([expect.stringMatching(/^Subject pay\.charge.*, selected$/)])
    fireEvent.click(node(/^Subject pay\.charge/))
    expect(within(detail()).getByText(/^Message #2$/i)).toBeInTheDocument()
    // A consumer selects the message it received; an edge the message it leads to.
    fireEvent.click(node(/^Consumer order-svc/))
    expect(within(detail()).getAllByText('orders.new').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('img', { name: /^pay\.charge to billing/ }))
    expect(within(detail()).getAllByText('pay.charge').length).toBeGreaterThan(0)
  })

  it('is one tab stop: arrows move through the messages in time, Enter opens, closing gives focus back', async () => {
    const user = userEvent.setup()
    const graph = await openGraph(user)
    graph.focus()
    await user.keyboard('{ArrowRight}')
    expect(current()).toEqual([expect.stringMatching(/^Subject orders\.new/)])
    expect(screen.queryByRole('complementary', { name: 'Message detail' })).toBeNull()
    await user.keyboard('{ArrowRight}')
    expect(current()).toEqual([expect.stringMatching(/^Subject pay\.charge/)])
    // The edge the message arrived by is marked in its name too.
    expect(
      screen.getByRole('img', { name: /^order-svc to pay\.charge.*the selected message arrived/ })
    ).toBeInTheDocument()
    await user.keyboard('{End}')
    expect(current()).toEqual([expect.stringMatching(/^Subject ship\.pack/)])
    await user.keyboard('{Home}')
    expect(current()).toEqual([expect.stringMatching(/^Subject orders\.new/)])
    await user.keyboard('{Enter}')
    expect(within(detail()).getAllByText('orders.new').length).toBeGreaterThan(0)
    await user.keyboard('{ArrowRight}')
    expect(within(detail()).getAllByText('pay.charge').length).toBeGreaterThan(0)
    // One application role (the library's wrapper), not one inside another.
    expect(screen.getAllByRole('application')).toHaveLength(1)
    // Nodes and edges are not tab stops of their own.
    expect(
      graph.querySelectorAll('.react-flow__node[tabindex], .react-flow__edge[tabindex]')
    ).toHaveLength(0)
    await user.click(within(detail()).getByRole('button', { name: 'Close message detail' }))
    await waitFor(() =>
      expect(screen.queryByRole('complementary', { name: 'Message detail' })).toBeNull()
    )
    expect(screen.getByRole('application', { name: 'Trace graph' })).toHaveFocus()
  })

  it('keeps the selection when the view changes', async () => {
    const user = userEvent.setup()
    await openGraph(user)
    fireEvent.click(node(/^Subject ship\.pack/))
    await user.selectOptions(screen.getByRole('combobox', { name: 'View' }), 'timeline')
    const rows = (await screen.findAllByRole('row')).slice(1)
    expect(rows[3]).toHaveAttribute('aria-selected', 'true')
    await user.selectOptions(screen.getByRole('combobox', { name: 'View' }), 'graph')
    await screen.findByRole('application', { name: 'Trace graph' })
    expect(current()).toEqual([expect.stringMatching(/^Subject ship\.pack/)])
  })

  it('removes the dots while the page is hidden, and puts them back', async () => {
    const user = userEvent.setup()
    await openGraph(user)
    expect(screen.getAllByTestId('graph-dot').length).toBeGreaterThan(0)
    let state: DocumentVisibilityState = 'hidden'
    const original = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState')!
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
    try {
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'))
      })
      expect(screen.queryAllByTestId('graph-dot')).toHaveLength(0)
      state = 'visible'
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'))
      })
      expect(screen.getAllByTestId('graph-dot').length).toBeGreaterThan(0)
    } finally {
      delete (document as unknown as Record<string, unknown>).visibilityState
      expect(Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState')).toEqual(
        original
      )
    }
  })

  it('removes the dots while the Trace tab is not the active tab, and puts them back', async () => {
    const user = userEvent.setup()
    function Switchable(): ReactNode {
      const [active, setActive] = useState(true)
      return (
        <>
          <button onClick={() => setActive(!active)}>Switch tab</button>
          <TabActiveContext.Provider value={active}>
            <Host />
          </TabActiveContext.Provider>
        </>
      )
    }
    await openGraph(user, <Switchable />)
    expect(screen.getAllByTestId('graph-dot').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Switch tab' }))
    expect(screen.queryAllByTestId('graph-dot')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Switch tab' }))
    expect(screen.getAllByTestId('graph-dot').length).toBeGreaterThan(0)
  })
})
