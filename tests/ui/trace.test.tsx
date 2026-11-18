import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { ReactNode } from 'react'
import type { ConsumerInfoDto, GatewayStreams, ScanRequest } from '@shared/api'
import { MessageDetail } from '@renderer/components/MessageDetail'
import { openNav } from '@renderer/features/shell/nav'
import { followQuery, followValue } from '@renderer/features/trace/followValue'
import { TraceTab } from '@renderer/features/trace/TraceTab'
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
  return <TraceTab tabId={tab.id} connId={tab.spec.connId} query={tab.spec.query} />
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
  it('explains what a trace is before anything is run, and offers no View dropdown for one view', async () => {
    setup(gatewayWithRequest())
    expect(await screen.findByText('Follow a request across streams')).toBeInTheDocument()
    expect(screen.getByText(/trace id in a header/)).toBeInTheDocument()
    expect(TRACE_VIEWS).toHaveLength(1)
    expect(screen.queryByLabelText('View')).toBeNull()
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
    await user.keyboard('{ArrowDown}')
    const panel = await screen.findByRole('complementary', { name: 'Message detail' })
    expect(within(panel).getByText('Message #1')).toBeInTheDocument()
    await user.keyboard('{ArrowDown}')
    expect(await within(panel).findByText('Message #1')).toBeInTheDocument()
    expect(within(screen.getAllByRole('row')[2]).getByText('PAY')).toBeInTheDocument()
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
