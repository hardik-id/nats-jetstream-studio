import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import App from '@renderer/App'
import { DataTable, type Column } from '@renderer/components/DataTable'
import { PayloadViewer } from '@renderer/components/PayloadViewer'
import { ConfirmDialog } from '@renderer/components/ui'
import { ConnectionForm } from '@renderer/features/connections/ConnectionForm'
import { createFakeGateway } from '@renderer/gateway/fake'
import { textToBase64, toBase64 } from '@shared/encoding'
import { renderWithGateway } from './render'

function seededGateway(): ReturnType<typeof createFakeGateway> {
  const gateway = createFakeGateway({
    connections: [
      { id: 'dev', name: 'Dev', envLabel: 'dev', color: '#059669' },
      { id: 'prod', name: 'Prod', envLabel: 'prod', readOnly: true, color: '#dc2626' }
    ]
  })
  gateway.streams.set('ORDERS', {
    config: {
      name: 'ORDERS',
      subjects: ['orders.>'],
      storage: 'file',
      retention: 'limits',
      num_replicas: 1
    },
    messages: Array.from({ length: 120 }, (_, i) => ({
      seq: i + 1,
      subject: i % 2 ? 'orders.eu' : 'orders.us',
      payload: JSON.stringify({ n: i + 1 }),
      time: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()
    })),
    consumers: []
  })
  gateway.streams.set('EVENTS', {
    config: {
      name: 'EVENTS',
      subjects: ['events.>'],
      storage: 'memory',
      retention: 'interest',
      num_replicas: 1
    },
    messages: [],
    consumers: []
  })
  return gateway
}

describe('PBI-003 app shell with the fake gateway', () => {
  it('shows an empty state that leads to adding a connection', async () => {
    renderWithGateway(<App status="ready" />)
    expect(await screen.findByText('Connect to a NATS server to get started')).toBeInTheDocument()
    await userEvent.click(
      within(screen.getByRole('main')).getByRole('button', { name: 'Add connection' })
    )
    expect(await screen.findByRole('dialog', { name: 'Add connection' })).toBeInTheDocument()
  })

  it('connects, opens tabs and follows connection status events', async () => {
    const gateway = seededGateway()
    renderWithGateway(<App status="ready" />, gateway)
    const sidebar = await screen.findByRole('navigation', { name: 'Connections' })
    const dev = await within(sidebar).findByRole('group', { name: 'Dev' })
    expect(within(dev).getByRole('img', { name: 'Not connected' })).toBeInTheDocument()

    await userEvent.click(within(dev).getAllByRole('button', { name: /Dev/ })[0])
    expect(await within(dev).findByRole('img', { name: 'Connected' })).toBeInTheDocument()
    expect(gateway.calls.some((c) => c.method === 'connect' && c.args[0] === 'dev')).toBe(true)
    expect(await screen.findByTestId('active-connection')).toHaveTextContent('Dev')
    expect(await screen.findByTestId('connection-state')).toHaveTextContent(/^Connected/)

    await userEvent.click(within(dev).getByRole('button', { name: 'Streams' }))
    const table = await screen.findByRole('table', { name: 'Streams' })
    expect(await within(table).findByRole('button', { name: 'ORDERS' })).toBeInTheDocument()
    expect(within(table).getByRole('button', { name: 'EVENTS' })).toBeInTheDocument()
    expect(screen.getByRole('tablist', { name: 'Open tabs' })).toHaveTextContent('Streams')

    // The gateway reports a lost connection; the UI shows it without being asked.
    gateway.emit({
      type: 'connection',
      state: { id: 'dev', status: 'reconnecting', reconnects: 0 }
    })
    expect(await within(dev).findByRole('img', { name: 'Reconnecting' })).toBeInTheDocument()
    // Every open tab of that connection carries the warning (hidden tabs are still in the page).
    expect(
      (await screen.findAllByText(/The connection to Dev was lost\. Reconnecting/)).length
    ).toBeGreaterThanOrEqual(1)
    expect(screen.getByTestId('connection-state')).toHaveTextContent('Reconnecting')
    gateway.emit({ type: 'connection', state: { id: 'dev', status: 'connected', reconnects: 1 } })
    await waitFor(() =>
      expect(screen.queryAllByText(/The connection to Dev was lost/)).toHaveLength(0)
    )
  })

  it('disables changes on a read-only connection and explains why', async () => {
    const gateway = seededGateway()
    renderWithGateway(<App status="ready" />, gateway)
    const prod = await within(
      await screen.findByRole('navigation', { name: 'Connections' })
    ).findByRole('group', { name: 'Prod' })
    expect(within(prod).getByLabelText('Read-only')).toBeInTheDocument()
    await userEvent.click(within(prod).getAllByRole('button', { name: /Prod/ })[0])
    await userEvent.click(await within(prod).findByRole('button', { name: 'Streams' }))
    const button = await screen.findByRole('button', { name: 'New stream' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', expect.stringMatching(/read-only/))
    expect(screen.getByTestId('active-connection')).toHaveTextContent('Read-only')
    // And the gateway refuses anyway, as the real one does.
    await expect(
      gateway.createStream('prod', { name: 'X', subjects: ['x'] })
    ).rejects.toMatchObject({ kind: 'read_only' })
  })

  it('opens the shortcut list with "?" but not while typing', async () => {
    renderWithGateway(<App status="ready" />, seededGateway())
    await screen.findByRole('navigation', { name: 'Connections' })
    fireEvent.keyDown(window, { key: '?' })
    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Keyboard shortcuts' }), { key: 'Escape' })
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).not.toBeInTheDocument()
    )

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    const input = await screen.findByRole('combobox')
    fireEvent.keyDown(input, { key: '?' })
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).not.toBeInTheDocument()
  })

  it('tells the user when the studio server is unreachable or the session ended', async () => {
    const { unmount } = renderWithGateway(<App status="lost" />, seededGateway())
    expect(await screen.findByRole('alertdialog')).toHaveTextContent(
      'Lost the connection to the studio server'
    )
    unmount()
    renderWithGateway(<App status="signed-out" />, seededGateway())
    expect(await screen.findByText('You are signed out')).toBeInTheDocument()
  })
})

describe('PBI-011 connection form', () => {
  it('validates before saving and never echoes a stored secret', async () => {
    const gateway = createFakeGateway({
      connections: [
        {
          id: 'c1',
          name: 'Existing',
          auth: 'userpass',
          user: 'svc',
          storedSecrets: { password: true }
        }
      ]
    })
    const onClose = vi.fn()
    renderWithGateway(<ConnectionForm id="c1" onClose={onClose} />, gateway)
    const dialog = await screen.findByRole('dialog', { name: 'Edit connection: Existing' })
    const password = within(dialog).getByLabelText('Password') as HTMLInputElement
    expect(password.value).toBe('')
    expect(within(dialog).getByText('Saved. Leave empty to keep it.')).toBeInTheDocument()

    await userEvent.clear(within(dialog).getByLabelText('Name'))
    await userEvent.clear(within(dialog).getByLabelText('Server URLs'))
    await userEvent.type(within(dialog).getByLabelText('Server URLs'), 'ws://example.com:8080')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(within(dialog).getByText('Name is required')).toBeInTheDocument()
    expect(within(dialog).getByText(/WebSocket URLs are not supported/)).toBeInTheDocument()
    expect(gateway.calls.some((c) => c.method === 'saveConnection')).toBe(false)

    await userEvent.type(within(dialog).getByLabelText('Name'), 'Renamed')
    await userEvent.clear(within(dialog).getByLabelText('Server URLs'))
    await userEvent.type(within(dialog).getByLabelText('Server URLs'), 'nats://10.0.0.1:4222')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    const saved = gateway.calls.find((c) => c.method === 'saveConnection')!.args[0] as {
      name: string
      password?: string
      servers: string[]
    }
    expect(saved).toMatchObject({ name: 'Renamed', servers: ['nats://10.0.0.1:4222'] })
    // An untouched password field means "keep the stored one", so nothing is sent.
    expect(saved.password).toBeUndefined()
  })

  it('switches read-only on for a production label until the user decides otherwise', async () => {
    renderWithGateway(<ConnectionForm id={null} onClose={() => {}} />, createFakeGateway())
    const dialog = await screen.findByRole('dialog', { name: 'Add connection' })
    const readOnly = within(dialog).getByLabelText(/^Read-only/) as HTMLInputElement
    expect(readOnly.checked).toBe(false)
    await userEvent.type(within(dialog).getByLabelText('Environment'), 'prod')
    await waitFor(() => expect(readOnly.checked).toBe(true))
    await userEvent.click(readOnly)
    expect(readOnly.checked).toBe(false)
    await userEvent.type(within(dialog).getByLabelText('Environment'), 'uction')
    expect(readOnly.checked).toBe(false)
  })

  it('warns when no keychain protects saved secrets', async () => {
    renderWithGateway(
      <ConnectionForm id={null} onClose={() => {}} />,
      createFakeGateway({ appInfo: { secretStorage: false } })
    )
    const dialog = await screen.findByRole('dialog', { name: 'Add connection' })
    await userEvent.selectOptions(within(dialog).getByLabelText('Method'), 'token')
    expect(
      await within(dialog).findByText(/No operating system keychain is available/)
    ).toBeInTheDocument()
    await userEvent.click(within(dialog).getByLabelText(/Save the secret on this computer/))
    expect(
      within(dialog).queryByText(/No operating system keychain is available/)
    ).not.toBeInTheDocument()
  })

  /** Every value the form asked the gateway to store as the test timeout, in order. */
  const storedTimeouts = (gateway: ReturnType<typeof createFakeGateway>): unknown[] =>
    gateway.calls
      .filter((c) => c.method === 'setSetting' && c.args[0] === 'testTimeoutMs')
      .map((c) => c.args[1])

  it('PBI-012 stores the test timeout on Enter or when the field is left, never while typing', async () => {
    const gateway = createFakeGateway()
    gateway.settings.set('testTimeoutMs', 8000)
    const onClose = vi.fn()
    renderWithGateway(<ConnectionForm id={null} onClose={onClose} />, gateway)
    const dialog = await screen.findByRole('dialog', { name: 'Add connection' })
    const field = within(dialog).getByLabelText('Test timeout (seconds)') as HTMLInputElement
    // The stored value is shown in seconds, and the hint says what it applies to.
    await waitFor(() => expect(field.value).toBe('8'))
    expect(within(dialog).getByText(/Applies to every connection test/)).toBeInTheDocument()

    // Typed one key at a time. On the way to "30" the field holds "3", which is a valid timeout
    // too: neither that nor "30" may be stored while the field still has the focus.
    await userEvent.clear(field)
    await userEvent.type(field, '30')
    expect(field.value).toBe('30')
    expect(field).not.toHaveAttribute('aria-invalid')
    await new Promise((r) => setTimeout(r, 50))
    expect(storedTimeouts(gateway)).toEqual([])
    expect(gateway.settings.get('testTimeoutMs')).toBe(8000)

    // Leaving the field stores what it holds, in milliseconds, once.
    await userEvent.tab()
    await waitFor(() => expect(gateway.settings.get('testTimeoutMs')).toBe(30000))
    expect(storedTimeouts(gateway)).toEqual([30000])
    await waitFor(() => expect(field.value).toBe('30'))

    // Enter stores as well. It does not submit the form: nothing is validated or saved and the
    // dialog stays open.
    await userEvent.clear(field)
    await userEvent.type(field, '2.5{Enter}')
    await waitFor(() => expect(gateway.settings.get('testTimeoutMs')).toBe(2500))
    expect(storedTimeouts(gateway)).toEqual([30000, 2500])
    expect(within(dialog).queryByText('Name is required')).not.toBeInTheDocument()
    expect(gateway.calls.some((c) => c.method === 'saveConnection')).toBe(false)
    expect(onClose).not.toHaveBeenCalled()
    // Confirming the same value again stores nothing new.
    await userEvent.type(field, '{Enter}')
    await userEvent.tab()
    expect(storedTimeouts(gateway)).toEqual([30000, 2500])

    // Out of range or not a number: an inline error, and neither Enter nor leaving stores it.
    for (const bad of ['0', '0.9', '61', '600', '-5', 'abc', '1e1', '']) {
      await userEvent.clear(field)
      if (bad) await userEvent.type(field, bad)
      await userEvent.type(field, '{Enter}')
      await userEvent.tab()
      expect(field.value).toBe(bad)
      expect(within(dialog).getByRole('alert')).toHaveTextContent(
        'Enter a number of seconds from 1 to 60'
      )
      expect(field).toHaveAttribute('aria-invalid', 'true')
    }
    expect(storedTimeouts(gateway)).toEqual([30000, 2500])
    expect(onClose).not.toHaveBeenCalled()

    // The limits themselves are accepted.
    await userEvent.clear(field)
    await userEvent.type(field, '60{Enter}')
    await waitFor(() => expect(gateway.settings.get('testTimeoutMs')).toBe(60000))
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument()
    await userEvent.clear(field)
    await userEvent.type(field, '1')
    await userEvent.tab()
    await waitFor(() => expect(gateway.settings.get('testTimeoutMs')).toBe(1000))
    expect(storedTimeouts(gateway)).toEqual([30000, 2500, 60000, 1000])
  })

  it('PBI-012 closing the dialog drops a timeout that was typed but not confirmed', async () => {
    const closeWith: Record<string, (dialog: HTMLElement) => Promise<unknown>> = {
      Cancel: (dialog) => userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' })),
      'the close button': (dialog) =>
        userEvent.click(within(dialog).getByRole('button', { name: 'Close' })),
      Escape: () => userEvent.keyboard('{Escape}')
    }
    for (const [how, close] of Object.entries(closeWith)) {
      const gateway = createFakeGateway()
      gateway.settings.set('testTimeoutMs', 8000)
      const onClose = vi.fn()
      const { unmount } = renderWithGateway(<ConnectionForm id={null} onClose={onClose} />, gateway)
      const dialog = await screen.findByRole('dialog', { name: 'Add connection' })
      const field = within(dialog).getByLabelText('Test timeout (seconds)') as HTMLInputElement
      await waitFor(() => expect(field.value).toBe('8'))
      await userEvent.clear(field)
      await userEvent.type(field, '12')
      await close(dialog)
      expect(onClose, how).toHaveBeenCalled()
      await new Promise((r) => setTimeout(r, 50))
      expect(storedTimeouts(gateway), how).toEqual([])
      expect(gateway.settings.get('testTimeoutMs'), how).toBe(8000)
      unmount()
    }
  })

  it('PBI-012 a changed timeout clears the last verdict and is stored before the next test', async () => {
    const gateway = createFakeGateway()
    renderWithGateway(<ConnectionForm id={null} onClose={() => {}} />, gateway)
    const dialog = await screen.findByRole('dialog', { name: 'Add connection' })
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Local')
    const testButton = within(dialog).getByRole('button', { name: 'Test connection' })
    await userEvent.click(testButton)
    expect(await within(dialog).findByText(/Connected to/)).toBeInTheDocument()

    // The verdict was reached with the old timeout, so it goes as soon as the timeout changes.
    const field = within(dialog).getByLabelText('Test timeout (seconds)') as HTMLInputElement
    await userEvent.clear(field)
    expect(within(dialog).queryByText(/Connected to/)).not.toBeInTheDocument()
    await userEvent.type(field, '9')

    // Pressing "Test connection" leaves the field: the new timeout is stored first, then used.
    await userEvent.click(testButton)
    expect(await within(dialog).findByText(/Connected to/)).toBeInTheDocument()
    const order = gateway.calls
      .filter((c) => c.method === 'testConnection' || c.args[0] === 'testTimeoutMs')
      .filter((c) => c.method !== 'getSetting')
      .map((c) => (c.method === 'setSetting' ? `store ${String(c.args[1])}` : 'test'))
    expect(order).toEqual(['test', 'store 9000', 'test'])
  })

  it('PBI-012 the test timeout stays editable for a NATS CLI connection', async () => {
    const gateway = createFakeGateway({
      connections: [{ id: 'cli', name: 'from-cli', source: 'cli' }]
    })
    renderWithGateway(<ConnectionForm id="cli" onClose={() => {}} />, gateway)
    const dialog = await screen.findByRole('dialog', { name: 'Edit connection: from-cli' })
    expect(within(dialog).getByLabelText('Name')).toBeDisabled()
    const field = within(dialog).getByLabelText('Test timeout (seconds)') as HTMLInputElement
    await waitFor(() => expect(field.value).toBe('5'))
    expect(field).toBeEnabled()
    await userEvent.clear(field)
    await userEvent.type(field, '30{Enter}')
    await waitFor(() => expect(gateway.settings.get('testTimeoutMs')).toBe(30000))
    expect(storedTimeouts(gateway)).toEqual([30000])
  })
})

describe('shared components', () => {
  interface Row {
    id: number
    name: string
    size: number
  }
  const rows: Row[] = [
    { id: 1, name: 'beta', size: 30 },
    { id: 2, name: 'alpha', size: 10 },
    { id: 3, name: 'gamma', size: 20 }
  ]
  const columns: Column<Row>[] = [
    { id: 'name', header: 'Name', sort: (r) => r.name, cell: (r) => r.name },
    { id: 'size', header: 'Size', align: 'right', sort: (r) => r.size, cell: (r) => r.size }
  ]
  const names = (): string[] =>
    screen
      .getAllByRole('row')
      .slice(1)
      .map((r) => within(r).getAllByRole('cell')[0].textContent ?? '')

  it('DataTable sorts by column and is usable from the keyboard', async () => {
    const onOpen = vi.fn()
    renderWithGateway(
      <div style={{ height: 400 }}>
        <DataTable
          ariaLabel="Things"
          rows={rows}
          columns={columns}
          rowKey={(r) => r.id}
          onOpen={onOpen}
        />
      </div>
    )
    expect(names()).toEqual(['beta', 'alpha', 'gamma'])
    await userEvent.click(screen.getByRole('button', { name: 'Name' }))
    expect(names()).toEqual(['alpha', 'beta', 'gamma'])
    expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveAttribute(
      'aria-sort',
      'ascending'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Name' }))
    expect(names()).toEqual(['gamma', 'beta', 'alpha'])
    await userEvent.click(screen.getByRole('button', { name: 'Size' }))
    expect(names()).toEqual(['alpha', 'gamma', 'beta'])

    const table = screen.getByRole('table', { name: 'Things' })
    fireEvent.keyDown(table, { key: 'ArrowDown' })
    fireEvent.keyDown(table, { key: 'ArrowDown' })
    expect(screen.getByRole('row', { selected: true })).toHaveTextContent('gamma')
    fireEvent.keyDown(table, { key: 'End' })
    expect(screen.getByRole('row', { selected: true })).toHaveTextContent('beta')
    fireEvent.keyDown(table, { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledWith(rows[0])
  })

  it('DataTable only renders the rows in view', () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ id: i, name: `row-${i}`, size: i }))
    renderWithGateway(
      <div style={{ height: 400 }}>
        <DataTable ariaLabel="Many" rows={many} columns={columns} rowKey={(r) => r.id} />
      </div>
    )
    expect(screen.getByRole('table', { name: 'Many' })).toHaveAttribute('aria-rowcount', '5000')
    expect(screen.getAllByRole('row').length).toBeLessThan(80)
  })

  it('PayloadViewer detects JSON, text and binary, and offers the full payload when truncated', async () => {
    const { rerender } = renderWithGateway(
      <PayloadViewer payload={textToBase64('{"a":1,"b":{"c":[1,2]}}')} size={23} />
    )
    expect(screen.getByRole('tab', { name: 'JSON' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('payload-body')).toHaveTextContent('"a": 1')

    rerender(<PayloadViewer payload={textToBase64('just some text')} size={14} />)
    expect(screen.getByRole('tab', { name: 'Text' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('tab', { name: 'JSON' })).not.toBeInTheDocument()

    rerender(<PayloadViewer payload={toBase64(new Uint8Array([0, 1, 2, 255, 254]))} size={5} />)
    expect(screen.getByRole('tab', { name: 'Hex' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('payload-body')).toHaveTextContent('00 01 02 ff fe')
    await userEvent.click(screen.getByRole('tab', { name: 'Base64' }))
    expect(screen.getByTestId('payload-body')).toHaveTextContent('AAEC//4=')

    rerender(<PayloadViewer payload="" size={0} />)
    expect(screen.getByTestId('payload-body')).toHaveTextContent('Empty payload')

    const onLoadFull = vi.fn()
    rerender(
      <PayloadViewer
        payload={textToBase64('{"cut": "off')}
        size={2_000_000}
        truncated
        onLoadFull={onLoadFull}
      />
    )
    expect(screen.getByText(/Showing the first 12 B of 1\.91 MiB/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Load full payload' }))
    expect(onLoadFull).toHaveBeenCalled()
  })

  it('ConfirmDialog needs the exact name typed and shows a failure without closing', async () => {
    const onConfirm = vi
      .fn()
      .mockRejectedValueOnce(new Error('server said no'))
      .mockResolvedValueOnce(undefined)
    const onClose = vi.fn()
    renderWithGateway(
      <ConfirmDialog
        title="Delete stream ORDERS"
        confirmLabel="Delete stream"
        typeToConfirm="ORDERS"
        onConfirm={onConfirm}
        onClose={onClose}
      >
        This cannot be undone.
      </ConfirmDialog>
    )
    const button = screen.getByRole('button', { name: 'Delete stream' })
    expect(button).toBeDisabled()
    await userEvent.type(screen.getByRole('textbox'), 'orders')
    expect(button).toBeDisabled()
    await userEvent.clear(screen.getByRole('textbox'))
    await userEvent.type(screen.getByRole('textbox'), 'ORDERS')
    expect(button).toBeEnabled()
    await userEvent.click(button)
    expect(await screen.findByRole('alert')).toHaveTextContent('server said no')
    expect(onClose).not.toHaveBeenCalled()
    await userEvent.click(button)
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })
})
