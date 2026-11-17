import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { ContentFilters, ScanRequest } from '@shared/api'
import { MessageBrowser } from '@renderer/features/messages/MessageBrowser'
import { createFakeGateway } from '@renderer/gateway/fake'
import { renderWithGateway } from './render'

const docs = [
  { type: 'order', status: 'ok', n: 1, tags: ['a', 'b'] },
  { type: 'order', status: 'bad', n: 2, tags: ['b'] },
  { type: 'refund', status: 'ok', n: 3, tags: ['c'] }
]

async function setup(settings: Record<string, unknown> = {}) {
  const gateway = createFakeGateway({ connections: [{ id: 'dev', name: 'Dev' }] })
  for (const [k, v] of Object.entries(settings)) gateway.settings.set(k, v)
  gateway.streams.set('EV', {
    config: {
      name: 'EV',
      subjects: ['ev.>'],
      storage: 'file',
      retention: 'limits',
      num_replicas: 1
    },
    messages: docs.map((d, i) => ({
      seq: i + 1,
      subject: `ev.${d.type}`,
      payload: JSON.stringify(d),
      time: '2026-01-01T00:00:00Z',
      headers: [
        ['Region', i === 0 ? 'eu' : 'us'],
        ['Trace-Id', `t-${i}`]
      ]
    })),
    consumers: []
  })
  const info = await gateway.streamInfo('dev', 'EV')
  renderWithGateway(<MessageBrowser connId="dev" info={info} />, gateway)
  return gateway
}

const scans = (gateway: Awaited<ReturnType<typeof setup>>): ScanRequest[] =>
  gateway.calls
    .filter((c) => c.method === 'open:scan')
    .map((c) => (c.args[0] as { request: ScanRequest }).request)

const lastFilters = (gateway: Awaited<ReturnType<typeof setup>>): ContentFilters =>
  scans(gateway).at(-1)!.filters

const open = async (seq: number): Promise<void> => {
  // Each document has its own "n", equal to its sequence; the table shows the payload text.
  const row = await waitFor(() => {
    const found = screen
      .getAllByRole('row')
      .find((r) => (r.textContent ?? '').includes(`"n":${seq}`))
    if (!found) throw new Error(`row ${seq} not shown`)
    return found
  })
  await userEvent.click(row)
  await screen.findByRole('complementary', { name: 'Message detail' })
}
const rows = (): string[] =>
  screen
    .queryAllByRole('row')
    .map((r) => r.textContent ?? '')
    .filter((t) => /ev\./.test(t))

describe('PBI-126 filter from a message', () => {
  it('keeps the filter buttons out of reach until the row has focus, then reaches them by keyboard', async () => {
    const user = userEvent.setup()
    await setup()
    await screen.findByText('ev.refund')
    await open(3)
    const row = screen.getByRole('treeitem', { name: '$.type: refund' })
    row.focus()
    await user.tab() // Copy path
    await user.tab() // Copy value
    await user.tab()
    expect(document.activeElement).toHaveAccessibleName('Filter to type equals refund')
    await user.tab()
    expect(document.activeElement).toHaveAccessibleName('Exclude type equals refund')
  })

  it('"Filter to this value" adds an include chip and reruns the scan', async () => {
    const gateway = await setup()
    await open(3)
    await userEvent.click(screen.getByRole('button', { name: 'Filter to type equals refund' }))
    expect(lastFilters(gateway)).toEqual({
      conditions: [{ kind: 'jsonPath', expr: '$.type == "refund"' }]
    })
    const chips = await screen.findByLabelText('Active filters')
    expect(chips).toHaveTextContent('JSONPath $.type == "refund"')
    expect(within(chips).queryByText('not')).toBeNull()
    expect(screen.getByRole('button', { name: 'Filters, 1 active' })).toBeInTheDocument()
    await waitFor(() => expect(rows()).toHaveLength(1))
    // The message is still in the result, so it stays open and the focus stays on the button.
    expect(screen.getByRole('complementary', { name: 'Message detail' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Filter to type equals refund' })).toHaveFocus()
  })

  it('"Exclude this value" adds a chip marked "not", ANDed with the first', async () => {
    const gateway = await setup()
    await open(1)
    await userEvent.click(screen.getByRole('button', { name: 'Filter to type equals order' }))
    await waitFor(() => expect(rows()).toHaveLength(2))
    await userEvent.click(screen.getByRole('button', { name: 'Exclude status equals ok' }))
    expect(lastFilters(gateway).conditions).toEqual([
      { kind: 'jsonPath', expr: '$.type == "order"' },
      { kind: 'jsonPath', expr: '$.status == "ok"', exclude: true }
    ])
    const chips = screen.getByLabelText('Active filters')
    const excluded = within(chips).getByRole('group', {
      name: 'Exclude filter: JSONPath $.status == "ok"'
    })
    expect(excluded).toHaveTextContent('not')
    expect(screen.getByRole('button', { name: 'Filters, 2 active' })).toBeInTheDocument()
    await waitFor(() => expect(rows()).toHaveLength(1))
    // Message 1 is gone from the result: the panel closed and focus is on the new chip.
    await waitFor(() =>
      expect(screen.queryByRole('complementary', { name: 'Message detail' })).toBeNull()
    )
    expect(within(excluded).getByRole('button', { name: /^Include instead: / })).toHaveFocus()
  })

  it('uses contains for an item of an array', async () => {
    const gateway = await setup()
    await open(2)
    await userEvent.click(screen.getByRole('button', { name: 'Filter to tags contains b' }))
    expect(lastFilters(gateway).conditions).toEqual([
      { kind: 'jsonPath', expr: '$.tags contains "b"' }
    ])
    await waitFor(() => expect(rows()).toHaveLength(2))
  })

  it('header rows have Include and Exclude buttons', async () => {
    const gateway = await setup()
    await open(1)
    await userEvent.click(screen.getByRole('button', { name: /^Headers/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Exclude header Region = eu' }))
    expect(lastFilters(gateway).conditions).toEqual([
      { kind: 'header', key: 'Region', value: 'eu', exclude: true }
    ])
    expect(await screen.findByLabelText('Active filters')).toHaveTextContent('Header Region = eu')
    await waitFor(() => expect(rows()).toHaveLength(2))
  })

  it('Include on a value that has an exclude flips it; the same click twice adds nothing', async () => {
    const gateway = await setup()
    await open(1)
    await userEvent.click(screen.getByRole('button', { name: 'Exclude type equals order' }))
    await waitFor(() => expect(rows()).toHaveLength(1))
    await open(3)
    await userEvent.click(screen.getByRole('button', { name: 'Exclude type equals refund' }))
    await waitFor(() => expect(rows()).toHaveLength(0))
    expect(lastFilters(gateway).conditions).toHaveLength(2)
    // The chips toggle flips the first one back to an include.
    const chips = screen.getByLabelText('Active filters')
    await userEvent.click(
      within(chips).getByRole('button', { name: 'Include instead: JSONPath $.type == "order"' })
    )
    expect(lastFilters(gateway).conditions).toEqual([
      { kind: 'jsonPath', expr: '$.type == "order"' },
      { kind: 'jsonPath', expr: '$.type == "refund"', exclude: true }
    ])
    await waitFor(() => expect(rows()).toHaveLength(2))
  })

  it('removes a chip', async () => {
    const gateway = await setup()
    await open(1)
    await userEvent.click(screen.getByRole('button', { name: 'Filter to type equals order' }))
    await userEvent.click(await screen.findByRole('button', { name: /^Remove filter: JSONPath/ }))
    await waitFor(() => expect(screen.queryByLabelText('Active filters')).toBeNull())
    await waitFor(() => expect(rows()).toHaveLength(3))
    expect(scans(gateway)).toHaveLength(1)
    expect(screen.getByRole('button', { name: /^Filters/ })).toHaveFocus()
  })

  it('shows no filter buttons without onFilter (Live tail)', async () => {
    const { MessageDetail } = await import('@renderer/components/MessageDetail')
    renderWithGateway(
      <MessageDetail
        message={{
          subject: 's',
          time: 0,
          size: 9,
          headers: [['K', 'v']],
          payload: btoa('{"a":"x"}'),
          truncated: false
        }}
        onClose={() => {}}
      />
    )
    expect(screen.getByRole('treeitem', { name: '$.a: x' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Filter to/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Exclude/ })).toBeNull()
  })
})

describe('PBI-126 filter panel conditions', () => {
  it('lists conditions, validates per row and applies include and exclude', async () => {
    const gateway = await setup()
    await screen.findByText('ev.refund')
    await userEvent.click(screen.getByRole('button', { name: /^Filters/ }))
    const panel = await screen.findByRole('form', { name: 'Message filters' })
    await userEvent.type(
      within(panel).getByLabelText('Condition 1 expression'),
      '$.type == "order"'
    )
    await userEvent.click(within(panel).getByRole('button', { name: 'Add condition' }))
    await userEvent.selectOptions(within(panel).getByLabelText('Condition 2 type'), 'regex')
    await userEvent.type(within(panel).getByLabelText('Condition 2 expression'), '(')
    expect(within(panel).getByRole('alert')).toBeInTheDocument()
    expect(within(panel).getByRole('button', { name: 'Apply filters' })).toBeDisabled()
    await userEvent.clear(within(panel).getByLabelText('Condition 2 expression'))
    await userEvent.type(within(panel).getByLabelText('Condition 2 expression'), '"n":2')
    await userEvent.selectOptions(within(panel).getByLabelText('Condition 2 mode'), 'exclude')
    await userEvent.click(within(panel).getByRole('button', { name: 'Add condition' }))
    await userEvent.selectOptions(within(panel).getByLabelText('Condition 3 type'), 'header')
    await userEvent.type(within(panel).getByLabelText('Condition 3 header name'), 'Region')
    await userEvent.type(within(panel).getByLabelText('Condition 3 header value'), 'eu')
    await userEvent.click(within(panel).getByRole('button', { name: 'Apply filters' }))
    expect(lastFilters(gateway).conditions).toEqual([
      { kind: 'jsonPath', expr: '$.type == "order"' },
      { kind: 'regex', expr: '"n":2', exclude: true },
      { kind: 'header', key: 'Region', value: 'eu' }
    ])
    expect(screen.getByRole('button', { name: 'Filters, 3 active' })).toBeInTheDocument()
    await waitFor(() => expect(rows()).toHaveLength(1))
  })

  it('removes a condition row', async () => {
    await setup()
    await screen.findByText('ev.refund')
    await userEvent.click(screen.getByRole('button', { name: /^Filters/ }))
    const panel = await screen.findByRole('form', { name: 'Message filters' })
    await userEvent.click(within(panel).getByRole('button', { name: 'Add condition' }))
    expect(within(panel).getByLabelText('Condition 2 expression')).toBeInTheDocument()
    await userEvent.click(within(panel).getByRole('button', { name: 'Remove condition 2' }))
    expect(within(panel).queryByLabelText('Condition 2 expression')).toBeNull()
  })

  it('opens saved filters of the old shape as conditions', async () => {
    const gateway = await setup({
      'conn:dev:savedFilters': [
        {
          name: 'Old',
          subject: '',
          filters: { payloadContains: 'refund', headers: [{ key: 'Region', value: 'us' }] }
        }
      ]
    })
    await screen.findByText('ev.refund')
    await userEvent.click(screen.getByRole('button', { name: 'Saved' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Old' }))
    await waitFor(() =>
      expect(lastFilters(gateway)).toEqual({
        conditions: [
          { kind: 'header', key: 'Region', value: 'us' },
          { kind: 'contains', expr: 'refund' }
        ]
      })
    )
    expect(screen.getByRole('button', { name: 'Filters, 2 active' })).toBeInTheDocument()
    await waitFor(() => expect(rows()).toHaveLength(1))
  })
})
