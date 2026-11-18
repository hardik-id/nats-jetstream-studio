import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { ReactNode } from 'react'
import type { TraceQuery } from '@shared/trace'
import type { ConsumerInfoDto, GatewayStreams, ScanRequest } from '@shared/api'
import { MessageDetail } from '@renderer/components/MessageDetail'
import { openNav } from '@renderer/features/shell/nav'
import { followQuery, followValue } from '@renderer/features/trace/followValue'
import { TraceTab } from '@renderer/features/trace/TraceTab'
import { TraceToolbar } from '@renderer/features/trace/TraceToolbar'
import { TRACE_VIEWS } from '@renderer/features/trace/views/registry'
import { createFakeGateway, type FakeGateway } from '@renderer/gateway/fake'
import { useTabs } from '@renderer/state/tabs'
import { renderWithGateway } from './render'

const ago = (seconds: number): string => new Date(Date.now() - seconds * 1000).toISOString()
const stream = (name: string) => ({
  name,
  subjects: [`${name.toLowerCase()}.>`],
  storage: 'file' as const,
  retention: 'limits' as const,
  num_replicas: 1
})
const consumer = (name: string, streamName: string, floor: number): ConsumerInfoDto =>
  ({
    stream_name: streamName,
    name,
    created: ago(86_400),
    config: { ack_policy: 'explicit', deliver_policy: 'all' },
    delivered: { consumer_seq: floor, stream_seq: floor },
    ack_floor: { consumer_seq: floor, stream_seq: floor },
    num_ack_pending: 0,
    num_redelivered: 0,
    num_waiting: 0,
    num_pending: 0
  }) as ConsumerInfoDto

function gatewayWithRequest(): FakeGateway {
  const gateway = createFakeGateway({ connections: [{ id: 'dev', name: 'Dev' }] })
  gateway.streams.set('ORDERS', {
    config: stream('ORDERS'),
    messages: [
      {
        seq: 1,
        subject: 'orders.new',
        payload: '{"order":{"id":"abc"}}',
        time: ago(100),
        headers: [['trace-id', 'abc']]
      },
      {
        seq: 2,
        subject: 'orders.new',
        payload: '{"order":{"id":"zzz"}}',
        time: ago(99),
        headers: [['trace-id', 'zzz']]
      }
    ],
    consumers: []
  })
  gateway.streams.set('PAY', {
    config: stream('PAY'),
    messages: [
      {
        seq: 1,
        subject: 'pay.charge',
        payload: '{"amount":5}',
        time: ago(98),
        headers: [['trace-id', 'abc']]
      }
    ],
    consumers: [consumer('billing', 'PAY', 1)]
  })
  gateway.streams.set('SHIP', {
    config: stream('SHIP'),
    messages: [{ seq: 1, subject: 'ship.pack', payload: '{"ref":{"order":"abc"}}', time: ago(90) }],
    consumers: []
  })
  // System streams are not searched.
  gateway.streams.set('KV_cfg', {
    config: stream('KV_cfg'),
    messages: [
      {
        seq: 1,
        subject: '$KV.cfg.a',
        payload: 'abc',
        time: ago(50),
        headers: [['trace-id', 'abc']]
      }
    ],
    consumers: []
  })
  return gateway
}

/** Renders the first Trace tab of `dev` from the tab store, as the tab host does. */
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

function setup(gateway: FakeGateway): void {
  renderWithGateway(<Host />, gateway)
  act(() => openNav('dev', 'trace'))
}

const scans = (gateway: FakeGateway): { stream: string; request: ScanRequest }[] =>
  gateway.calls
    .filter((c) => c.method === 'open:scan')
    .map((c) => c.args[0] as { stream: string; request: ScanRequest })

async function runHeader(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByRole('textbox', { name: 'Header name 1' }), 'trace-id')
  await user.type(screen.getByRole('textbox', { name: 'Value 1' }), 'abc')
  await user.click(screen.getByRole('button', { name: 'Run trace' }))
}

const rowsText = (): string[] =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((r) => r.textContent ?? '')

describe('PBI-138 Trace screen', () => {
  it('explains what a trace is before anything is run, and offers the views in a View dropdown', async () => {
    setup(gatewayWithRequest())
    expect(await screen.findByText('Follow a request across streams')).toBeInTheDocument()
    expect(screen.getByText(/trace id in a header/)).toBeInTheDocument()
    const views = screen.getByRole('combobox', { name: 'View' })
    expect(
      within(views)
        .getAllByRole('option')
        .map((o) => o.textContent)
    ).toEqual(TRACE_VIEWS.map((v) => v.label))
    expect(views).toHaveValue('timeline')
    // The Timeline has no controls of its own.
    expect(screen.queryByRole('combobox', { name: 'Lane by' })).toBeNull()
    // Without an anchor the window offers the recent ranges and a custom one.
    const window = screen.getByRole('combobox', { name: 'Window' })
    expect(
      within(window)
        .getAllByRole('option')
        .map((o) => o.textContent)
    ).toEqual(['Last 1 h', 'Last 24 h', 'Last 7 days', 'Custom range'])
    expect(window).toHaveValue('last:24h')
  })

  it('runs a header rule over every stream and lists the hops in time order with consumers', async () => {
    const user = userEvent.setup()
    const gateway = gatewayWithRequest()
    setup(gateway)
    await runHeader(user)
    const table = await screen.findByRole('table', { name: 'Trace timeline' })
    await waitFor(() => expect(rowsText()).toHaveLength(2))
    expect(rowsText()[0]).toContain('ORDERS')
    expect(rowsText()[0]).toContain('orders.new')
    expect(rowsText()[0]).toContain('start')
    expect(rowsText()[1]).toContain('PAY')
    expect(rowsText()[1]).toMatch(/\+2\.0 s/)
    // The consumer of PAY has a badge; ORDERS has no consumers.
    expect(within(table).getByText('billing')).toBeInTheDocument()
    // One scan per stream, none for the system stream, with the rule as a header condition.
    expect(
      scans(gateway)
        .map((s) => s.stream)
        .sort()
    ).toEqual(['ORDERS', 'PAY', 'SHIP'])
    expect(scans(gateway)[0].request.filters).toEqual({
      conditions: [{ kind: 'header', key: 'trace-id', value: 'abc' }]
    })
    expect(scans(gateway)[0].request.until).toBeUndefined()
    expect(screen.getByText(/2 messages · 2 subjects · 2 streams/)).toBeInTheDocument()
    // The tab is named after the value.
    expect(useTabs.getState().tabs[0].spec).toMatchObject({
      kind: 'trace',
      query: { rules: [{ value: 'abc' }] }
    })
  })

  it('"+ or" adds a rule; the results of both are merged', async () => {
    const user = userEvent.setup()
    const gateway = gatewayWithRequest()
    setup(gateway)
    await runHeader(user)
    await waitFor(() => expect(rowsText()).toHaveLength(2))
    await user.click(screen.getByRole('button', { name: /^or$/ }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Match type 2' }), 'json')
    await user.type(screen.getByRole('textbox', { name: 'JSON path 2' }), '$.ref.order')
    await user.type(screen.getByRole('textbox', { name: 'Value 2' }), 'abc')
    await user.click(screen.getByRole('button', { name: 'Run trace' }))
    await waitFor(() => expect(rowsText()).toHaveLength(3))
    expect(rowsText().map((t) => t.match(/ORDERS|PAY|SHIP/)![0])).toEqual(['ORDERS', 'PAY', 'SHIP'])
    expect(
      scans(gateway).some((s) =>
        s.request.filters.conditions?.some(
          (c) => c.kind === 'jsonPath' && c.expr === '$.ref.order == "abc"'
        )
      )
    ).toBe(true)
  })

  it('moves the selection with the arrows, opens the detail with Enter, and opens the message in Messages', async () => {
    const user = userEvent.setup()
    setup(gatewayWithRequest())
    await runHeader(user)
    const table = await screen.findByRole('table', { name: 'Trace timeline' })
    await waitFor(() => expect(rowsText()).toHaveLength(2))
    table.focus()
    // Arrows only move the selection: the pane stays closed.
    await user.keyboard('{ArrowDown}')
    expect(screen.getAllByRole('row')[1]).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('complementary', { name: 'Message detail' })).toBeNull()
    // Enter opens it; then it follows the selection.
    await user.keyboard('{Enter}')
    const panel = await screen.findByRole('complementary', { name: 'Message detail' })
    expect(within(panel).getByText('Message #1')).toBeInTheDocument()
    await user.keyboard('{ArrowDown}')
    expect(screen.getAllByRole('row')[2]).toHaveAttribute('aria-selected', 'true')
    // The panel shows the selected message (PAY, subject pay.charge).
    expect(within(panel).getAllByText('pay.charge').length).toBeGreaterThan(0)
    await user.click(within(panel).getByRole('button', { name: 'Open in Messages' }))
    expect(useTabs.getState().tabs.find((t) => t.id === 'messages:dev')?.spec).toMatchObject({
      kind: 'messages',
      stream: 'PAY',
      seq: 1
    })
  })

  it('opens the detail with a click and gives focus back to the timeline when it is closed', async () => {
    const user = userEvent.setup()
    setup(gatewayWithRequest())
    await runHeader(user)
    const table = await screen.findByRole('table', { name: 'Trace timeline' })
    await waitFor(() => expect(rowsText()).toHaveLength(2))
    await user.click(screen.getAllByRole('row')[2])
    const panel = await screen.findByRole('complementary', { name: 'Message detail' })
    await user.click(within(panel).getByRole('button', { name: 'Close message detail' }))
    await waitFor(() =>
      expect(screen.queryByRole('complementary', { name: 'Message detail' })).toBeNull()
    )
    expect(table).toHaveFocus()
    // Escape inside the pane does the same.
    await user.click(screen.getAllByRole('row')[1])
    const again = await screen.findByRole('complementary', { name: 'Message detail' })
    within(again).getByRole('button', { name: 'Close message detail' }).focus()
    await user.keyboard('{Escape}')
    await waitFor(() =>
      expect(screen.queryByRole('complementary', { name: 'Message detail' })).toBeNull()
    )
    expect(table).toHaveFocus()
  })

  it('closes its scans on Cancel and when the tab goes away', async () => {
    const user = userEvent.setup()
    const gateway = gatewayWithRequest()
    let opened = 0
    let closed = 0
    // Scans that never finish; each close is counted once.
    gateway.open = (() => {
      opened++
      let done = false
      return () => {
        if (!done) closed++
        done = true
      }
    }) as typeof gateway.open
    const { unmount } = renderWithGateway(<Host />, gateway)
    act(() => openNav('dev', 'trace'))
    await runHeader(user)
    await screen.findByTestId('trace-progress')
    await waitFor(() => expect(opened).toBe(3))
    await user.click(screen.getAllByRole('button', { name: 'Cancel' })[0])
    await waitFor(() => expect(closed).toBe(3))
    // Run again; closing the tab stops that run's scans too.
    await user.click(screen.getByRole('button', { name: 'Run trace' }))
    await screen.findByTestId('trace-progress')
    await waitFor(() => expect(opened).toBe(6))
    unmount()
    expect(closed).toBe(6)
  })

  it('says a cancelled run is incomplete, also when it has matches', async () => {
    const user = userEvent.setup()
    const gateway = gatewayWithRequest()
    const open = gateway.open.bind(gateway)
    gateway.open = ((channel: 'scan', args: GatewayStreams['scan']['args'], on: never) =>
      args.stream === 'ORDERS' ? open(channel, args, on) : () => {}) as typeof gateway.open
    setup(gateway)
    await runHeader(user)
    const progress = await screen.findByTestId('trace-progress')
    await waitFor(() => expect(within(progress).getByText(/1 found/)).toBeInTheDocument())
    await user.click(within(progress).getByRole('button', { name: 'Cancel' }))
    const notices = await screen.findByTestId('trace-notices')
    expect(notices).toHaveTextContent('Cancelled: 1 of 3 streams were searched')
    expect(
      screen.getByText(/1 message ·.*Cancelled: 1 of 3 streams were searched/)
    ).toBeInTheDocument()
  })

  it('says so when nothing matches and suggests a wider window', async () => {
    const user = userEvent.setup()
    setup(gatewayWithRequest())
    await user.type(screen.getByRole('textbox', { name: 'Header name 1' }), 'trace-id')
    await user.type(screen.getByRole('textbox', { name: 'Value 1' }), 'nope')
    await user.click(screen.getByRole('button', { name: 'Run trace' }))
    expect(await screen.findByText('No message matches')).toBeInTheDocument()
    expect(screen.getByText(/Try a wider window/)).toBeInTheDocument()
  })

  it('refuses a query that cannot run, and says why', async () => {
    const user = userEvent.setup()
    const gateway = gatewayWithRequest()
    setup(gateway)
    await user.click(screen.getByRole('button', { name: 'Run trace' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter the name of the header')
    expect(scans(gateway)).toHaveLength(0)
  })

  it('shows progress per stream while scanning, and Cancel keeps what was found', async () => {
    const user = userEvent.setup()
    const gateway = gatewayWithRequest()
    const open = gateway.open.bind(gateway)
    // ORDERS answers; the others never finish.
    gateway.open = ((channel: 'scan', args: GatewayStreams['scan']['args'], on: never) =>
      args.stream === 'ORDERS' ? open(channel, args, on) : () => {}) as typeof gateway.open
    setup(gateway)
    await runHeader(user)
    const progress = await screen.findByTestId('trace-progress')
    expect(within(progress).getByText('ORDERS')).toBeInTheDocument()
    expect(within(progress).getByText('PAY')).toBeInTheDocument()
    await waitFor(() => expect(within(progress).getByText(/1 found/)).toBeInTheDocument())
    await user.click(within(progress).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByTestId('trace-progress')).toBeNull())
    // What ORDERS found stays.
    expect(await screen.findByRole('table', { name: 'Trace timeline' })).toBeInTheDocument()
    expect(rowsText()).toHaveLength(1)
  })

  it('reports a stream that failed without losing the others', async () => {
    const user = userEvent.setup()
    const gateway = gatewayWithRequest()
    const open = gateway.open.bind(gateway)
    gateway.open = ((
      channel: 'scan',
      args: GatewayStreams['scan']['args'],
      on: (e: GatewayStreams['scan']['event']) => void
    ) => {
      if (args.stream !== 'PAY') return open(channel, args, on as never)
      queueMicrotask(() =>
        on({
          type: 'done',
          reason: 'error',
          scanned: 0,
          matched: 0,
          skippedNonJson: 0,
          resumeSeq: null,
          error: { kind: 'permission', message: 'not allowed to read PAY' }
        })
      )
      return () => {}
    }) as typeof gateway.open
    setup(gateway)
    await runHeader(user)
    const notices = await screen.findByTestId('trace-notices')
    expect(notices).toHaveTextContent('PAY')
    expect(notices).toHaveTextContent('not allowed to read PAY')
    await waitFor(() => expect(rowsText()).toHaveLength(1))
    expect(rowsText()[0]).toContain('ORDERS')
  })

  it('marks a stream that hit its scan limit as partial and "Scan more" runs again with a higher limit', async () => {
    const user = userEvent.setup()
    const gateway = gatewayWithRequest()
    const open = gateway.open.bind(gateway)
    gateway.open = ((
      channel: 'scan',
      args: GatewayStreams['scan']['args'],
      on: (e: GatewayStreams['scan']['event']) => void
    ) =>
      open(channel, args, ((e: GatewayStreams['scan']['event']) =>
        on(
          e.type === 'done' && args.stream === 'SHIP' ? { ...e, reason: 'limit' } : e
        )) as never)) as typeof gateway.open
    setup(gateway)
    await runHeader(user)
    const notices = await screen.findByTestId('trace-notices')
    expect(notices).toHaveTextContent('Partial result')
    expect(notices).toHaveTextContent('SHIP')
    expect(notices).toHaveTextContent('10,000')
    const before = scans(gateway).length
    await user.click(within(notices).getByRole('button', { name: 'Scan more' }))
    await waitFor(() => expect(scans(gateway).length).toBeGreaterThan(before))
    expect(scans(gateway).at(-1)!.request.scanLimit).toBe(100_000)
  })

  it('restores the query of the tab and runs it when the tab is shown', async () => {
    const gateway = gatewayWithRequest()
    renderWithGateway(<Host />, gateway)
    act(() =>
      useTabs.getState().openNew({
        kind: 'trace',
        connId: 'dev',
        query: {
          rules: [{ kind: 'header', key: 'trace-id', value: 'abc' }],
          window: { kind: 'last', ms: 3_600_000 }
        }
      })
    )
    await waitFor(() => expect(rowsText()).toHaveLength(2))
    expect(screen.getByRole('textbox', { name: 'Value 1' })).toHaveValue('abc')
    expect(screen.getByRole('combobox', { name: 'Window' })).toHaveValue('last:1h')
  })
})

describe('PBI-138 follow this value', () => {
  const message = {
    subject: 'orders.new',
    time: '2026-01-01T00:00:00Z',
    size: 40,
    headers: [['trace-id', 'abc']] as [string, string][],
    payload: btoa('{"order":{"id":"A-1","qty":3}}'),
    truncated: false
  }

  it('offers Follow on a header and on a JSON value, only when asked for', async () => {
    const calls: unknown[] = []
    // The Headers section starts closed; open it for the test.
    const gateway = createFakeGateway()
    gateway.settings.set('messages.detailSections', { headers: true })
    const { unmount } = renderWithGateway(
      <MessageDetail message={message} onClose={() => {}} onFollow={(r) => calls.push(r)} />,
      gateway
    )
    await userEvent.click(
      await screen.findByRole('button', { name: 'Follow trace-id abc across streams' })
    )
    await userEvent.click(
      await screen.findByRole('button', { name: 'Follow id A-1 across streams' })
    )
    await userEvent.click(screen.getByRole('button', { name: 'Follow qty 3 across streams' }))
    expect(calls).toEqual([
      { kind: 'header', key: 'trace-id', value: 'abc' },
      { kind: 'json', path: '$.order.id', value: 'A-1' },
      { kind: 'json', path: '$.order.qty', value: '3', literal: true }
    ])
    unmount()
    renderWithGateway(<MessageDetail message={message} onClose={() => {}} />)
    expect(screen.queryByRole('button', { name: /^Follow / })).toBeNull()
  })

  it('opens a new Trace tab centred on the message and runs it at once', async () => {
    const gateway = gatewayWithRequest()
    renderWithGateway(<Host />, gateway)
    const time = ago(98)
    act(() => followValue('dev', { kind: 'header', key: 'trace-id', value: 'abc' }, time))
    const tab = useTabs.getState().tabs[0]
    expect(tab.id).toBe('trace:dev:1')
    expect(tab.spec).toMatchObject({
      kind: 'trace',
      query: {
        rules: [{ kind: 'header', key: 'trace-id', value: 'abc' }],
        window: { kind: 'around', anchor: new Date(time).toISOString(), ms: 15 * 60_000 }
      }
    })
    await waitFor(() => expect(rowsText()).toHaveLength(2))
    // The window offers the choices around the message, with ±15 min chosen.
    const window = screen.getByRole('combobox', { name: 'Window' })
    expect(window).toHaveValue('around:15m')
    expect(
      within(window)
        .getAllByRole('option')
        .map((o) => o.textContent)
    ).toEqual([
      '±5 min around the message',
      '±15 min around the message',
      '±1 h around the message',
      'Last 1 h',
      'Last 24 h',
      'Last 7 days',
      'Custom range'
    ])
    expect(scans(gateway)[0].request.until).toBe(
      new Date(new Date(time).getTime() + 15 * 60_000).toISOString()
    )
    // A second follow is a second tab, so two requests can be compared.
    act(() => followValue('dev', { kind: 'text', value: 'zzz' }, time))
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['trace:dev:1', 'trace:dev:2'])
    expect(followQuery({ kind: 'text', value: 'x' }, 0).window).toMatchObject({ kind: 'around' })
  })
})

describe('PBI-138 toolbar details', () => {
  const base: TraceQuery = {
    rules: [{ kind: 'header', key: 'k', value: 'v' }],
    window: { kind: 'range', from: '2026-03-01T10:00:00.000Z', to: '2026-03-01T11:00:00.000Z' }
  }
  const toolbar = (draft: TraceQuery, onChange: (q: TraceQuery) => void) =>
    renderWithGateway(
      <TraceToolbar
        draft={draft}
        onChange={onChange}
        streams={[{ name: 'ORDERS', messages: 1 }]}
        running={false}
        view={TRACE_VIEWS[0]}
        viewSettings={{}}
        onViewChange={() => {}}
        onViewSettingChange={() => {}}
        onRun={() => {}}
        onCancel={() => {}}
      />
    )

  it('makes the end of a custom range cover the whole minute', () => {
    const seen: TraceQuery[] = []
    toolbar(base, (q) => seen.push(q))
    fireEvent.change(screen.getByLabelText('Window end'), { target: { value: '2026-03-01T12:15' } })
    const to = (seen[0].window as { to: string }).to
    const expected = new Date('2026-03-01T12:15')
    expected.setSeconds(59, 999)
    expect(to).toBe(expected.toISOString())
  })

  it('switching system streams off keeps the rest of an explicit choice', async () => {
    const seen: TraceQuery[] = []
    toolbar({ ...base, streams: ['ORDERS', 'KV_cfg'], includeSystem: true }, (q) => seen.push(q))
    await userEvent.click(screen.getByRole('button', { name: 'More' }))
    await userEvent.click(screen.getByRole('checkbox', { name: /Include system streams/ }))
    expect(seen[0]).toMatchObject({ includeSystem: false, streams: ['ORDERS'] })
  })
})

describe('PBI-138 phase 2: Lanes view', () => {
  /** Four messages of one request: orders.101.new, pay.charge, ship.pack, orders.102.new (7 s later). */
  function gatewayForLanes(extra?: (g: FakeGateway) => void): FakeGateway {
    const gateway = createFakeGateway({ connections: [{ id: 'dev', name: 'Dev' }] })
    const h: [string, string][] = [['trace-id', 'abc']]
    const put = (name: string, subject: string, seconds: number, seq: number): void => {
      const s = gateway.streams.get(name)!
      s.messages.push({ seq, subject, payload: '{}', time: ago(seconds), headers: h })
    }
    for (const name of ['ORDERS', 'PAY', 'SHIP'])
      gateway.streams.set(name, { config: stream(name), messages: [], consumers: [] })
    put('ORDERS', 'orders.101.new', 100, 1)
    put('PAY', 'pay.charge', 98, 1)
    put('SHIP', 'ship.pack', 97, 1)
    put('ORDERS', 'orders.102.new', 90, 2)
    extra?.(gateway)
    return gateway
  }

  async function openLanes(
    user: ReturnType<typeof userEvent.setup>,
    gateway = gatewayForLanes()
  ): Promise<HTMLElement> {
    setup(gateway)
    await runHeader(user)
    await screen.findByRole('table', { name: 'Trace timeline' })
    await user.selectOptions(screen.getByRole('combobox', { name: 'View' }), 'lanes')
    return screen.findByRole('listbox', { name: 'Trace lanes' })
  }
  const labels = (): string[] =>
    screen.getAllByTestId('lane-label').map((e) => e.textContent!.replace(/\u00d7\d+$/, ''))
  const dots = (): HTMLElement[] =>
    within(screen.getByRole('listbox', { name: 'Trace lanes' })).getAllByRole('option')
  const selectedDots = (): number[] =>
    dots().flatMap((d, i) => (d.getAttribute('aria-selected') === 'true' ? [i] : []))
  const tab = () =>
    useTabs.getState().tabs[0].spec as Extract<
      ReturnType<typeof useTabs.getState>['tabs'][number]['spec'],
      { kind: 'trace' }
    >

  it('switches to Lanes from the View dropdown: lanes grouped by subject, one dot per message, own controls', async () => {
    const user = userEvent.setup()
    const box = await openLanes(user)
    expect(box).toBeInTheDocument()
    expect(screen.queryByRole('table', { name: 'Trace timeline' })).toBeNull()
    // Lanes in order of first appearance; the two orders subjects share a lane by default.
    expect(labels()).toEqual(['orders.*.new', 'pay.charge', 'ship.pack'])
    expect(screen.getAllByTestId('lane-label')[0].textContent).toContain('\u00d72')
    expect(dots()).toHaveLength(4)
    expect(screen.getAllByTestId(/^lane-link/)).toHaveLength(3)
    // The controls of the view are next to the dropdown, with their defaults.
    expect(screen.getByRole('combobox', { name: 'Lane by' })).toHaveValue('subject')
    expect(screen.getByRole('combobox', { name: 'Scale' })).toHaveValue('steps')
    expect(tab().view).toBe('lanes')
    // Back to the Timeline: the controls go away.
    await user.selectOptions(screen.getByRole('combobox', { name: 'View' }), 'timeline')
    expect(screen.queryByRole('combobox', { name: 'Lane by' })).toBeNull()
    expect(await screen.findByRole('table', { name: 'Trace timeline' })).toBeInTheDocument()
  })

  it('every dot has an accessible name, and the slowest hop is named in text', async () => {
    const user = userEvent.setup()
    const box = await openLanes(user)
    const names = dots().map((d) => d.getAttribute('aria-label')!)
    expect(names[0]).toMatch(/^orders\.101\.new, ORDERS, \d\d:\d\d:\d\d\.\d{3}, first message$/)
    expect(names[1]).toMatch(
      /^pay\.charge, PAY, \d\d:\d\d:\d\d\.\d{3}, \+2\.0 s after the previous message$/
    )
    expect(names[3]).toMatch(/\+7\.0 s after the previous message, slowest hop$/)
    // The summary is the text alternative, and the slowest link has a visible tag.
    const summary = document.getElementById(box.getAttribute('aria-describedby')!)!
    expect(summary).toHaveTextContent(/4 messages in 3 lanes by subject, one column per message/)
    expect(summary).toHaveTextContent('Slowest hop: +7.0 s before orders.102.new')
    const slow = screen.getByTestId('lane-link-slowest')
    expect(within(slow as unknown as HTMLElement).getByText('SLOWEST')).toBeInTheDocument()
    expect(within(slow as unknown as HTMLElement).getByText('+7.0 s')).toBeInTheDocument()
  })

  it('Lane by stream and the scale are view settings kept in the tab spec', async () => {
    const user = userEvent.setup()
    await openLanes(user)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Lane by' }), 'stream')
    expect(labels()).toEqual(['ORDERS', 'PAY', 'SHIP'])
    const firstX = (): string[] => dots().map((d) => d.querySelector('circle')!.getAttribute('cx')!)
    const steps = firstX()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Scale' }), 'time')
    expect(firstX()).not.toEqual(steps)
    expect(screen.getByText(/spaced by time/)).toBeInTheDocument()
    expect(tab().viewSettings).toEqual({ laneBy: 'stream', scale: 'time' })
    // Group similar subjects is in More; off, each subject has its own lane.
    await user.selectOptions(screen.getByRole('combobox', { name: 'Lane by' }), 'subject')
    expect(labels()).toHaveLength(3)
    await user.click(screen.getByRole('button', { name: 'More' }))
    await user.click(screen.getByRole('checkbox', { name: /Group similar subjects/ }))
    expect(labels()).toEqual(['orders.101.new', 'pay.charge', 'ship.pack', 'orders.102.new'])
    expect(tab().viewSettings).toMatchObject({ groupSubjects: false })
    // The real subject is kept in the name of the dot.
    expect(dots()[3].getAttribute('aria-label')).toContain('orders.102.new')
  })

  it('moves through the messages with the keyboard: arrows select, Enter opens, the pane follows', async () => {
    const user = userEvent.setup()
    const box = await openLanes(user)
    box.focus()
    expect(selectedDots()).toEqual([])
    await user.keyboard('{ArrowRight}')
    expect(selectedDots()).toEqual([0])
    expect(box).toHaveAttribute('aria-activedescendant', dots()[0].id)
    expect(screen.queryByRole('complementary', { name: 'Message detail' })).toBeNull()
    await user.keyboard('{ArrowRight}')
    expect(selectedDots()).toEqual([1])
    await user.keyboard('{ArrowLeft}{ArrowLeft}')
    expect(selectedDots()).toEqual([0]) // stops at the first
    // Down: the nearest message of the next lane, twice, then Up.
    await user.keyboard('{ArrowDown}')
    expect(selectedDots()).toEqual([1])
    await user.keyboard('{ArrowDown}')
    expect(selectedDots()).toEqual([2])
    await user.keyboard('{ArrowDown}')
    expect(selectedDots()).toEqual([2]) // last lane: stays
    await user.keyboard('{ArrowUp}')
    expect(selectedDots()).toEqual([1])
    await user.keyboard('{End}')
    expect(selectedDots()).toEqual([3])
    await user.keyboard('{ArrowRight}')
    expect(selectedDots()).toEqual([3])
    await user.keyboard('{Home}')
    expect(selectedDots()).toEqual([0])
    // Enter opens the detail; then the arrows move it.
    await user.keyboard('{Enter}')
    const panel = await screen.findByRole('complementary', { name: 'Message detail' })
    expect(within(panel).getAllByText('orders.101.new').length).toBeGreaterThan(0)
    await user.keyboard('{ArrowRight}')
    expect(within(panel).getAllByText('pay.charge').length).toBeGreaterThan(0)
    // The view is one tab stop: the dots are not focusable.
    expect(dots().every((d) => !d.hasAttribute('tabindex'))).toBe(true)
    // Closing the pane gives the focus back to the lanes.
    await user.click(within(panel).getByRole('button', { name: 'Close message detail' }))
    await waitFor(() =>
      expect(screen.queryByRole('complementary', { name: 'Message detail' })).toBeNull()
    )
    expect(screen.getByRole('listbox', { name: 'Trace lanes' })).toHaveFocus()
  })

  it('a click on a dot selects it and opens the detail; the tooltip names the message', async () => {
    const user = userEvent.setup()
    await openLanes(user)
    await user.hover(dots()[1])
    const tip = await screen.findByTestId('lane-tooltip')
    expect(tip).toHaveTextContent('pay.charge')
    expect(tip).toHaveTextContent('PAY #1')
    expect(tip).toHaveTextContent('+2.0 s after the previous message')
    expect(tip).toHaveTextContent('No consumers')
    await user.click(dots()[1])
    expect(selectedDots()).toEqual([1])
    const panel = await screen.findByRole('complementary', { name: 'Message detail' })
    expect(within(panel).getAllByText('pay.charge').length).toBeGreaterThan(0)
  })

  it('keeps the selection and the open detail when the view changes', async () => {
    const user = userEvent.setup()
    await openLanes(user)
    await user.click(dots()[2])
    const panel = await screen.findByRole('complementary', { name: 'Message detail' })
    expect(within(panel).getAllByText('ship.pack').length).toBeGreaterThan(0)
    await user.selectOptions(screen.getByRole('combobox', { name: 'View' }), 'timeline')
    const rows = (await screen.findAllByRole('row')).slice(1)
    expect(rows[2]).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('complementary', { name: 'Message detail' })).toBeInTheDocument()
    await user.selectOptions(screen.getByRole('combobox', { name: 'View' }), 'lanes')
    expect(selectedDots()).toEqual([2])
    expect(screen.getByRole('complementary', { name: 'Message detail' })).toBeInTheDocument()
  })

  it('restores the view and its settings from the tab spec, and keeps them when the trace runs again', async () => {
    const user = userEvent.setup()
    const gateway = gatewayForLanes()
    renderWithGateway(<Host />, gateway)
    act(() =>
      useTabs.getState().openNew({
        kind: 'trace',
        connId: 'dev',
        query: {
          rules: [{ kind: 'header', key: 'trace-id', value: 'abc' }],
          window: { kind: 'last', ms: 3_600_000 }
        },
        view: 'lanes',
        viewSettings: { laneBy: 'stream', scale: 'time', groupSubjects: false }
      })
    )
    await screen.findByRole('listbox', { name: 'Trace lanes' })
    expect(screen.getByRole('combobox', { name: 'View' })).toHaveValue('lanes')
    expect(screen.getByRole('combobox', { name: 'Lane by' })).toHaveValue('stream')
    expect(screen.getByRole('combobox', { name: 'Scale' })).toHaveValue('time')
    expect(labels()).toEqual(['ORDERS', 'PAY', 'SHIP'])
    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(dots()).toHaveLength(4))
    expect(screen.getByRole('combobox', { name: 'Lane by' })).toHaveValue('stream')
    await user.click(screen.getByRole('button', { name: 'Run trace' }))
    await waitFor(() => expect(dots()).toHaveLength(4))
    expect(tab().view).toBe('lanes')
    // A stored value that is not valid falls back to the default instead of breaking the view.
    act(() =>
      useTabs.getState().patch('trace:dev:1', { viewSettings: { laneBy: 'x', scale: 1 as never } })
    )
    await waitFor(() => expect(labels()).toEqual(['orders.*.new', 'pay.charge', 'ship.pack']))
    // An unknown view id shows the first view.
    act(() => useTabs.getState().patch('trace:dev:1', { view: 'graph' }))
    expect(await screen.findByRole('table', { name: 'Trace timeline' })).toBeInTheDocument()
  })

  it('works with one message and with two', async () => {
    const user = userEvent.setup()
    const g = gatewayForLanes((gw) => {
      gw.streams.get('PAY')!.messages = []
      gw.streams.get('SHIP')!.messages = []
      gw.streams.get('ORDERS')!.messages.pop()
    })
    await openLanes(user, g)
    expect(dots()).toHaveLength(1)
    expect(screen.queryByTestId('lane-link')).toBeNull()
    expect(screen.getByText(/1 message in 1 lane by subject/)).toBeInTheDocument()
    expect(screen.queryByText(/Slowest hop/)).toBeNull()
  })

  it('draws at most 1,000 messages and says so', async () => {
    const user = userEvent.setup()
    const g = gatewayForLanes((gw) => {
      for (const [name, base] of [
        ['ORDERS', 10],
        ['PAY', 500],
        ['SHIP', 900]
      ] as const)
        for (let i = 0; i < 400; i++)
          gw.streams.get(name)!.messages.push({
            seq: base + i,
            subject: `${name.toLowerCase()}.${i % 7}.ev`,
            payload: '{}',
            time: ago(80 - i / 10),
            headers: [['trace-id', 'abc']]
          })
    })
    await openLanes(user, g)
    await waitFor(() => expect(dots().length).toBe(1000))
    expect(screen.getByText(/Showing the first 1,000 of 1,204 messages/)).toBeInTheDocument()
  })
})
