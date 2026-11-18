import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { SubjectsTab } from '@renderer/features/subjects/SubjectsTab'
import { createFakeGateway, type FakeGateway } from '@renderer/gateway/fake'
import { useSeenSubjects } from '@renderer/state/seenSubjects'
import { useTabs } from '@renderer/state/tabs'
import { GatewayError } from '@shared/api'
import { renderWithGateway } from './render'

type Counts = Record<string, [string, number][]>

const DEFAULT: Counts = {
  ORDERS: [
    ['orders.eu.created', 4],
    ['orders.eu.shipped', 2],
    ['orders.us.created', 1]
  ],
  TELEMETRY: [['telemetry.dev1', 5]]
}

function setup(
  counts: Counts = DEFAULT,
  opts: { readOnly?: boolean; delay?: Record<string, Promise<void>>; fail?: string[] } = {}
): FakeGateway {
  const gateway = createFakeGateway({
    connections: [{ id: 'dev', name: 'Dev', readOnly: opts.readOnly ?? false }]
  })
  for (const name of Object.keys(counts)) {
    gateway.streams.set(name, {
      config: {
        name,
        subjects: [`${name.toLowerCase()}.>`],
        storage: 'file',
        retention: 'limits',
        num_replicas: 1
      },
      messages: [],
      consumers: []
    })
  }
  const g = gateway as unknown as Record<string, unknown>
  g.streamSubjects = async (_c: string, stream: string) => {
    gateway.calls.push({ method: 'streamSubjects', args: [stream] })
    await opts.delay?.[stream]
    if (opts.fail?.includes(stream))
      throw new GatewayError({ kind: 'internal', message: `boom ${stream}` })
    const subjects = (counts[stream] ?? []).map(([subject, count]) => ({ subject, count }))
    return { subjects, total: subjects.length, offset: 0 }
  }
  return gateway
}

const grid = () => screen.findByRole('treegrid', { name: 'Subjects' })
const row = (name: string) => screen.getByRole('row', { name })
const hasRow = (name: string) => screen.queryByRole('row', { name }) !== null

describe('PBI-127 subjects screen', () => {
  it('shows the hierarchy with counts, the top level open and columns', async () => {
    renderWithGateway(<SubjectsTab connId="dev" />, setup())
    await grid()
    await waitFor(() => expect(hasRow('orders')).toBe(true))
    expect(within(row('orders')).getByText('7')).toBeInTheDocument()
    expect(within(row('telemetry')).getByText('5')).toBeInTheDocument()
    expect(row('orders')).toHaveAttribute('aria-expanded', 'true')
    expect(row('orders')).toHaveAttribute('aria-level', '1')
    expect(hasRow('orders.eu')).toBe(true)
    expect(hasRow('orders.eu.created')).toBe(false)
    // The stream is shown where it changes, not on every row.
    expect(within(row('orders')).getByText('ORDERS')).toBeInTheDocument()
    expect(within(row('orders.eu')).queryByText('ORDERS')).toBeNull()
    expect(screen.getByRole('columnheader', { name: 'Messages' })).toBeInTheDocument()
  })

  it('leaves KV and Object Store streams out', async () => {
    const gateway = setup({ ...DEFAULT, KV_cfg: [['$KV.cfg.a', 3]] })
    renderWithGateway(<SubjectsTab connId="dev" />, gateway)
    await waitFor(() => expect(hasRow('orders')).toBe(true))
    expect(hasRow('$KV')).toBe(false)
    expect(gateway.calls.filter((c) => c.method === 'streamSubjects')).toHaveLength(2)
  })

  it('Expand all, Collapse all and Levels', async () => {
    renderWithGateway(<SubjectsTab connId="dev" />, setup())
    await waitFor(() => expect(hasRow('orders')).toBe(true))
    await userEvent.click(screen.getByRole('button', { name: 'Expand all' }))
    expect(hasRow('orders.eu.created')).toBe(true)
    expect(hasRow('telemetry.dev1')).toBe(true)
    await userEvent.click(screen.getByRole('button', { name: 'Collapse all' }))
    expect(hasRow('orders')).toBe(true)
    expect(hasRow('orders.eu')).toBe(false)
    const levels = within(screen.getByRole('group', { name: 'Levels' }))
    await userEvent.click(levels.getByRole('button', { name: '3' }))
    expect(hasRow('orders.eu.created')).toBe(true)
    await userEvent.click(levels.getByRole('button', { name: '1' }))
    expect(hasRow('orders.eu')).toBe(false)
    await userEvent.click(levels.getByRole('button', { name: '2' }))
    expect(hasRow('orders.eu')).toBe(true)
    expect(hasRow('orders.eu.created')).toBe(false)
  })

  it('tells when Expand all stopped at the row cap', async () => {
    // 6,000 subjects at level 3, 12 at level 2: expanding to the deepest level would be too many.
    const many: [string, number][] = Array.from({ length: 6000 }, (_, i) => [
      `big.g${i % 12}.s${i}`,
      1
    ])
    renderWithGateway(<SubjectsTab connId="dev" />, setup({ BIG: many }))
    await waitFor(() => expect(hasRow('big')).toBe(true))
    await userEvent.click(screen.getByRole('button', { name: 'Expand all' }))
    expect(await screen.findByText(/Opened 11 of 13 branches/)).toBeInTheDocument()
  })

  it('searches: keeps ancestors, marks the match, counts, and restores the tree on clear', async () => {
    renderWithGateway(<SubjectsTab connId="dev" />, setup())
    await waitFor(() => expect(hasRow('orders')).toBe(true))
    await userEvent.type(screen.getByLabelText('Search subjects'), 'us.cre')
    await waitFor(() => expect(hasRow('orders.us.created')).toBe(true))
    expect(hasRow('orders')).toBe(true)
    expect(hasRow('orders.us')).toBe(true)
    expect(hasRow('orders.eu')).toBe(false)
    expect(hasRow('telemetry')).toBe(false)
    expect(screen.getByText('1 match')).toBeInTheDocument()
    const marks = row('orders.us.created').querySelectorAll('mark')
    expect(marks).toHaveLength(1)
    expect(marks[0].textContent).toBe('cre')
    await userEvent.clear(screen.getByLabelText('Search subjects'))
    await waitFor(() => expect(hasRow('telemetry')).toBe(true))
    expect(hasRow('orders.eu')).toBe(true)
    expect(hasRow('orders.us.created')).toBe(false)
  })

  it('a query without a highlight range does not break rendering', async () => {
    renderWithGateway(<SubjectsTab connId="dev" />, setup())
    await waitFor(() => expect(hasRow('orders')).toBe(true))
    await userEvent.type(screen.getByLabelText('Search subjects'), 'orders.')
    await waitFor(() => expect(hasRow('orders.eu')).toBe(true))
    expect(document.querySelectorAll('mark')).toHaveLength(0)
  })

  it('searching never changes what the user opened: closing in a search stays in the search', async () => {
    renderWithGateway(<SubjectsTab connId="dev" />, setup())
    await waitFor(() => expect(hasRow('orders')).toBe(true))
    await userEvent.type(screen.getByLabelText('Search subjects'), 'created')
    await waitFor(() => expect(hasRow('orders.eu.created')).toBe(true))
    // A revealed ancestor is open; closing it hides the matches below it.
    await userEvent.click(screen.getByRole('button', { name: 'Collapse orders.eu' }))
    expect(hasRow('orders.eu.created')).toBe(false)
    expect(hasRow('orders.us.created')).toBe(true)
    await userEvent.click(screen.getByRole('button', { name: 'Expand orders.eu' }))
    expect(hasRow('orders.eu.created')).toBe(true)
    await userEvent.clear(screen.getByLabelText('Search subjects'))
    await waitFor(() => expect(hasRow('telemetry')).toBe(true))
    // The tree is as before the search: top level open, deeper closed.
    expect(hasRow('orders.eu')).toBe(true)
    expect(hasRow('orders.eu.created')).toBe(false)
  })

  it('Expand all and Levels while searching only open what the search shows', async () => {
    renderWithGateway(<SubjectsTab connId="dev" />, setup())
    await waitFor(() => expect(hasRow('orders')).toBe(true))
    await userEvent.type(screen.getByLabelText('Search subjects'), 'created')
    await waitFor(() => expect(hasRow('orders.eu.created')).toBe(true))
    await userEvent.click(screen.getByRole('button', { name: 'Collapse all' }))
    expect(hasRow('orders.eu')).toBe(false)
    await userEvent.click(screen.getByRole('button', { name: 'Expand all' }))
    expect(hasRow('orders.eu.created')).toBe(true)
    // Nothing outside the search appears: eu.shipped does not match.
    expect(hasRow('orders.eu.shipped')).toBe(false)
    expect(hasRow('telemetry')).toBe(false)
    const levels = within(screen.getByRole('group', { name: 'Levels' }))
    await userEvent.click(levels.getByRole('button', { name: '2' }))
    expect(hasRow('orders.eu')).toBe(true)
    expect(hasRow('orders.eu.created')).toBe(false)
    expect(hasRow('telemetry')).toBe(false)
  })

  it('Expand all on a big tree with an active query opens branches up to the cap', async () => {
    const many: [string, number][] = Array.from({ length: 6000 }, (_, i) => [
      `big.g${i % 12}.s${i}`,
      1
    ])
    renderWithGateway(<SubjectsTab connId="dev" />, setup({ BIG: many }))
    await waitFor(() => expect(hasRow('big')).toBe(true))
    await userEvent.type(screen.getByLabelText('Search subjects'), 's')
    await waitFor(() => expect(screen.getByText('6,000 matches')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: 'Collapse all' }))
    expect(hasRow('big.g0')).toBe(false)
    await userEvent.click(screen.getByRole('button', { name: 'Expand all' }))
    expect(await screen.findByText(/Opened 11 of 13 branches/)).toBeInTheDocument()
    expect(hasRow('big.g0')).toBe(true)
    const tree = await grid()
    expect(Number(tree.getAttribute('aria-rowcount'))).toBeGreaterThan(5000)
    // Another query clears the note.
    await userEvent.type(screen.getByLabelText('Search subjects'), '1')
    await waitFor(() => expect(screen.queryByText(/Opened 11 of 13/)).toBeNull())
  })

  it('Expand all while searching also opens the subtree of a match', async () => {
    renderWithGateway(<SubjectsTab connId="dev" />, setup())
    await waitFor(() => expect(hasRow('orders')).toBe(true))
    await userEvent.type(screen.getByLabelText('Search subjects'), 'orders')
    await waitFor(() => expect(hasRow('telemetry')).toBe(false))
    expect(hasRow('orders.eu')).toBe(false)
    await userEvent.click(screen.getByRole('button', { name: 'Expand all' }))
    expect(hasRow('orders.eu.created')).toBe(true)
    expect(hasRow('telemetry')).toBe(false)
    await userEvent.click(screen.getByRole('button', { name: 'Collapse all' }))
    expect(hasRow('orders.eu')).toBe(false)
  })

  it('says so when Expand all cannot open anything more because of the cap', async () => {
    const many: [string, number][] = Array.from({ length: 6000 }, (_, i) => [
      `big.g${i % 12}.s${i}`,
      1
    ])
    renderWithGateway(<SubjectsTab connId="dev" />, setup({ BIG: many }))
    await waitFor(() => expect(hasRow('big')).toBe(true))
    await userEvent.click(screen.getByRole('button', { name: 'Expand all' }))
    expect(await screen.findByText(/Opened 11 of 13 branches/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Expand all' }))
    expect(
      await screen.findByText(/Already showing [\d,]+ rows; the limit is 5,000/)
    ).toBeInTheDocument()
  })

  it('a pattern query matches whole tokens', async () => {
    renderWithGateway(<SubjectsTab connId="dev" />, setup())
    await waitFor(() => expect(hasRow('orders')).toBe(true))
    await userEvent.type(screen.getByLabelText('Search subjects'), 'orders.*.created')
    await waitFor(() => expect(hasRow('orders.us.created')).toBe(true))
    expect(hasRow('orders.eu.created')).toBe(true)
    expect(screen.getByText('2 matches')).toBeInTheDocument()
  })

  it('shows "no match" with a way to clear the search', async () => {
    renderWithGateway(<SubjectsTab connId="dev" />, setup())
    await waitFor(() => expect(hasRow('orders')).toBe(true))
    await userEvent.type(screen.getByLabelText('Search subjects'), 'zzz')
    expect(await screen.findByText('No subjects match "zzz".')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    await waitFor(() => expect(hasRow('orders')).toBe(true))
  })

  it('sorts by name and filters', async () => {
    useSeenSubjects.setState({ byConn: { dev: { 'zlive.x': 3 } } })
    renderWithGateway(<SubjectsTab connId="dev" />, setup())
    await waitFor(() => expect(hasRow('orders')).toBe(true))
    const names = (): string[] =>
      screen
        .getAllByRole('row')
        .map((r) => r.getAttribute('aria-label'))
        .filter((n): n is string => !!n)
    expect(names().slice(0, 2)).toEqual(['orders', 'orders.eu'])
    await userEvent.selectOptions(screen.getByLabelText('Sort subjects'), 'name')
    expect(names()[0]).toBe('orders')
    expect(names()).toContain('telemetry')
    // Live-only subject is labelled and can be filtered.
    expect(within(row('zlive')).getByText('live')).toBeInTheDocument()
    await userEvent.click(screen.getByLabelText('With messages'))
    expect(hasRow('zlive')).toBe(false)
    await userEvent.click(screen.getByLabelText('With messages'))
    await userEvent.selectOptions(screen.getByLabelText('Source'), 'live')
    expect(hasRow('zlive')).toBe(true)
    expect(hasRow('orders')).toBe(false)
    useSeenSubjects.setState({ byConn: {} })
  })

  describe('keyboard', () => {
    it('has one tab stop and moves with the arrow keys', async () => {
      renderWithGateway(<SubjectsTab connId="dev" />, setup())
      await waitFor(() => expect(hasRow('orders')).toBe(true))
      const rows = screen.getAllByRole('row').filter((r) => r.hasAttribute('data-path'))
      expect(rows.filter((r) => r.tabIndex === 0)).toHaveLength(1)
      expect(rows[0].tabIndex).toBe(0)
      row('orders').focus()
      await userEvent.keyboard('{ArrowDown}')
      expect(row('orders.eu')).toHaveFocus()
      // Right on a closed node opens it, Right again enters it.
      await userEvent.keyboard('{ArrowRight}')
      expect(row('orders.eu')).toHaveAttribute('aria-expanded', 'true')
      await userEvent.keyboard('{ArrowRight}')
      expect(row('orders.eu.created')).toHaveFocus()
      // Left on a leaf goes to the parent, Left on an open node closes it.
      await userEvent.keyboard('{ArrowLeft}')
      expect(row('orders.eu')).toHaveFocus()
      await userEvent.keyboard('{ArrowLeft}')
      expect(row('orders.eu')).toHaveAttribute('aria-expanded', 'false')
      await userEvent.keyboard('{End}')
      expect(row('telemetry.dev1')).toHaveFocus()
      await userEvent.keyboard('{Home}')
      expect(row('orders')).toHaveFocus()
    })

    it('* opens all siblings and type-ahead jumps to a row', async () => {
      renderWithGateway(<SubjectsTab connId="dev" />, setup())
      await waitFor(() => expect(hasRow('orders')).toBe(true))
      row('orders.eu').focus()
      await userEvent.keyboard('*')
      expect(row('orders.eu')).toHaveAttribute('aria-expanded', 'true')
      expect(row('orders.us')).toHaveAttribute('aria-expanded', 'true')
      row('orders').focus()
      await userEvent.keyboard('t')
      expect(row('telemetry')).toHaveFocus()
    })

    it('Space selects; Enter and double-click select and open the pane, never navigate', async () => {
      const gateway = setup()
      gateway.settings.set('subjects.ui.dev', { paneCollapsed: true })
      renderWithGateway(<SubjectsTab connId="dev" />, gateway)
      await waitFor(() => expect(hasRow('orders')).toBe(true))
      row('orders.us').focus()
      await userEvent.keyboard(' ')
      expect(row('orders.us')).toHaveAttribute('aria-selected', 'true')
      // Space leaves a collapsed pane alone.
      expect(screen.queryByTestId('subject-detail')).toBeNull()
      row('orders.eu').focus()
      await userEvent.keyboard('{Enter}')
      expect(row('orders.eu')).toHaveAttribute('aria-selected', 'true')
      const pane = await screen.findByTestId('subject-detail')
      expect(within(pane).getByRole('heading', { name: 'orders.eu' })).toBeInTheDocument()
      expect(useTabs.getState().tabs).toHaveLength(0)
      await userEvent.dblClick(row('orders.us'))
      expect(within(pane).getByRole('heading', { name: 'orders.us' })).toBeInTheDocument()
      expect(useTabs.getState().tabs).toHaveLength(0)
    })

    it('Shift+F10 opens the row menu, Esc closes it and returns to the row', async () => {
      renderWithGateway(<SubjectsTab connId="dev" />, setup())
      await waitFor(() => expect(hasRow('orders')).toBe(true))
      row('orders.eu').focus()
      await userEvent.keyboard('{Shift>}{F10}{/Shift}')
      const menu = await screen.findByRole('menu')
      expect(within(menu).getAllByRole('menuitem')[0]).toHaveFocus()
      await userEvent.keyboard('{Escape}')
      expect(screen.queryByRole('menu')).toBeNull()
      await waitFor(() => expect(row('orders.eu')).toHaveFocus())
    })
  })

  describe('row menu and read-only', () => {
    it('opens a tail and the stream browser from the menu', async () => {
      renderWithGateway(<SubjectsTab connId="dev" />, setup())
      await waitFor(() => expect(hasRow('orders')).toBe(true))
      await userEvent.click(screen.getByRole('button', { name: 'Actions for orders.eu' }))
      await userEvent.click(
        screen.getByRole('menuitem', { name: /Browse stored messages on orders.eu.>/ })
      )
      const open = useTabs.getState().tabs.at(-1)!.spec
      expect(open).toMatchObject({ kind: 'messages', stream: 'ORDERS', subject: 'orders.eu.>' })
      await userEvent.click(screen.getByRole('button', { name: 'Actions for orders.eu' }))
      await userEvent.click(
        screen.getByRole('menuitem', { name: /Start live tail on orders.eu.>/ })
      )
      expect(useTabs.getState().tabs.at(-1)!.spec).toMatchObject({
        kind: 'tail',
        subject: 'orders.eu.>'
      })
    })

    it('disables Publish on a read-only connection and sends nothing', async () => {
      const gateway = setup(DEFAULT, { readOnly: true })
      renderWithGateway(<SubjectsTab connId="dev" />, gateway)
      await waitFor(() => expect(hasRow('orders')).toBe(true))
      await userEvent.click(screen.getByRole('button', { name: 'Actions for orders.eu' }))
      const item = screen.getByRole('menuitem', { name: /Publish message to orders.eu/ })
      expect(item).toHaveAttribute('aria-disabled', 'true')
      // The reason is on screen, and the item can still be reached with the arrow keys.
      expect(within(item).getByText(/read-only/)).toBeInTheDocument()
      expect(gateway.calls.some((c) => c.method === 'publish')).toBe(false)
    })
  })

  describe('persistence', () => {
    it('writes the expanded set, sort and selection per connection after a change', async () => {
      const gateway = setup()
      renderWithGateway(<SubjectsTab connId="dev" />, gateway)
      await waitFor(() => expect(hasRow('orders')).toBe(true))
      await userEvent.click(screen.getByRole('button', { name: 'Expand all' }))
      await userEvent.selectOptions(screen.getByLabelText('Sort subjects'), 'name')
      await userEvent.click(row('orders.eu.created'))
      await waitFor(() => {
        const stored = gateway.settings.get('subjects.ui.dev') as Record<string, unknown>
        expect(stored.sort).toBe('name')
        expect(stored.selected).toBe('orders.eu.created')
        expect(stored.expanded).toEqual(expect.arrayContaining(['orders', 'orders.eu']))
      })
    })

    it('restores what was stored and drops paths that no longer exist', async () => {
      const gateway = setup()
      gateway.settings.set('subjects.ui.dev', {
        expanded: ['orders', 'orders.eu', 'gone.branch'],
        selected: 'orders.us',
        sort: 'name',
        onlyWithMessages: false,
        source: 'all',
        paneWidth: 400,
        paneCollapsed: false
      })
      renderWithGateway(<SubjectsTab connId="dev" />, gateway)
      await waitFor(() => expect(hasRow('orders.eu.created')).toBe(true))
      expect(row('orders.us')).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByLabelText('Sort subjects')).toHaveValue('name')
      // The next change is written without the vanished path.
      await userEvent.click(screen.getByRole('button', { name: 'Collapse orders.eu' }))
      await waitFor(() => {
        const stored = gateway.settings.get('subjects.ui.dev') as { expanded: string[] }
        expect(stored.expanded).toEqual(['orders'])
      })
    })

    it('never writes before the stored value has been read', async () => {
      const gateway = setup()
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      const read = gateway.getSetting.bind(gateway)
      gateway.getSetting = async (key: string) => {
        await gate
        return read(key)
      }
      gateway.settings.set('subjects.ui.dev', { sort: 'name', expanded: ['orders'] })
      renderWithGateway(<SubjectsTab connId="dev" />, gateway)
      await waitFor(() =>
        expect(gateway.calls.filter((c) => c.method === 'streamSubjects').length).toBe(2)
      )
      // Controls may be used while the saved view loads; nothing may be written yet.
      fireEvent.click(screen.getByRole('button', { name: 'Expand all' }))
      expect(gateway.calls.some((c) => c.method === 'setSetting')).toBe(false)
      release()
      await waitFor(() => expect(hasRow('orders')).toBe(true))
      expect(gateway.settings.get('subjects.ui.dev')).toEqual({
        sort: 'name',
        expanded: ['orders']
      })
    })
  })

  describe('large trees', () => {
    it('keeps the DOM small with 10,000 subjects', async () => {
      const many: [string, number][] = Array.from({ length: 10000 }, (_, i) => [
        `big.g${i % 100}.s${i}`,
        1
      ])
      renderWithGateway(<SubjectsTab connId="dev" />, setup({ BIG: many }))
      await waitFor(() => expect(hasRow('big')).toBe(true))
      await userEvent.click(
        within(screen.getByRole('group', { name: 'Levels' })).getByRole('button', { name: '2' })
      )
      const rendered = screen.getAllByRole('row').filter((r) => r.hasAttribute('data-path'))
      expect(rendered.length).toBeLessThan(100)
      const tree = await grid()
      // The header row plus 1 + 100 + ... rows are announced even though few exist.
      expect(Number(tree.getAttribute('aria-rowcount'))).toBeGreaterThan(100)
    })
  })

  describe('loading and errors', () => {
    it('shows rows as each stream answers', async () => {
      let release!: () => void
      const slow = new Promise<void>((r) => (release = r))
      renderWithGateway(
        <SubjectsTab connId="dev" />,
        setup(DEFAULT, { delay: { TELEMETRY: slow } })
      )
      await waitFor(() => expect(hasRow('orders')).toBe(true))
      expect(hasRow('telemetry')).toBe(false)
      expect(screen.getByText('Reading 1 of 2 streams...')).toBeInTheDocument()
      release()
      await waitFor(() => expect(hasRow('telemetry')).toBe(true))
      expect(screen.queryByText(/Reading 1 of 2/)).toBeNull()
    })

    it('keeps the rows of streams that worked when one fails', async () => {
      renderWithGateway(<SubjectsTab connId="dev" />, setup(DEFAULT, { fail: ['TELEMETRY'] }))
      await waitFor(() => expect(hasRow('orders')).toBe(true))
      expect(
        await screen.findByText(/Could not read the subjects of TELEMETRY/)
      ).toBeInTheDocument()
      expect(hasRow('telemetry')).toBe(false)
    })

    it('shows an empty state with the next steps', async () => {
      renderWithGateway(<SubjectsTab connId="dev" />, setup({ ORDERS: [] }))
      expect(await screen.findByText(/No subjects yet/)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Start a live tail' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Publish a message' })).toBeInTheDocument()
    })
  })

  it('focus goes to the counterpart button when the pane collapses and opens', async () => {
    renderWithGateway(<SubjectsTab connId="dev" />, setup())
    await waitFor(() => expect(hasRow('orders')).toBe(true))
    await userEvent.click(screen.getByRole('button', { name: 'Collapse details' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Show subject details' })).toHaveFocus()
    )
    await userEvent.click(screen.getByRole('button', { name: 'Show subject details' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Collapse details' })).toHaveFocus()
    )
  })

  it('works from memory when the saved view cannot be read', async () => {
    const gateway = setup()
    gateway.getSetting = async () => {
      throw new Error('settings are unavailable')
    }
    renderWithGateway(<SubjectsTab connId="dev" />, gateway)
    await waitFor(() => expect(hasRow('orders')).toBe(true))
    await userEvent.click(screen.getByRole('button', { name: 'Collapse all' }))
    expect(hasRow('orders.eu')).toBe(false)
    await userEvent.click(row('orders'))
    expect(row('orders')).toHaveAttribute('aria-selected', 'true')
    await userEvent.selectOptions(screen.getByLabelText('Sort subjects'), 'name')
    expect(screen.getByLabelText('Sort subjects')).toHaveValue('name')
    await userEvent.selectOptions(screen.getByLabelText('Source'), 'live')
    expect(hasRow('orders')).toBe(false)
    expect(await screen.findByText(/No subjects to show with Source: Live/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Reset filters' }))
    expect(hasRow('orders')).toBe(true)
    // Nothing is ever written.
    expect(gateway.calls.some((c) => c.method === 'setSetting')).toBe(false)
  })

  it('the scope chosen in the pane does not reach the menu after the subject is reselected', async () => {
    renderWithGateway(<SubjectsTab connId="dev" />, setup())
    await waitFor(() => expect(hasRow('orders')).toBe(true))
    await userEvent.click(row('orders.eu'))
    await userEvent.click(screen.getByLabelText(/^One level below/))
    await userEvent.click(row('orders.us'))
    await userEvent.click(row('orders.eu'))
    await userEvent.click(screen.getByRole('button', { name: 'Actions for orders.eu' }))
    expect(
      screen.getByRole('menuitem', { name: /Start live tail on orders.eu.>/ })
    ).toBeInTheDocument()
  })

  it('shows a quiet note when the saved view cannot be read', async () => {
    const gateway = setup()
    gateway.getSetting = async () => {
      throw new Error('settings are unavailable')
    }
    renderWithGateway(<SubjectsTab connId="dev" />, gateway)
    expect(
      await screen.findByText('View settings could not be loaded; changes will not be saved.')
    ).toBeInTheDocument()
  })

  describe('narrow screen', () => {
    const original = globalThis.ResizeObserver
    const narrow = (): void => {
      globalThis.ResizeObserver = class {
        constructor(private cb: ResizeObserverCallback) {}
        observe(el: Element): void {
          this.cb(
            [{ target: el, contentRect: { width: 600 } } as ResizeObserverEntry],
            this as never
          )
        }
        unobserve(): void {}
        disconnect(): void {}
      } as unknown as typeof ResizeObserver
    }
    it('starts as a rail, and a click selection opens the pane unless it was collapsed on purpose', async () => {
      narrow()
      try {
        renderWithGateway(<SubjectsTab connId="dev" />, setup())
        await waitFor(() => expect(hasRow('orders')).toBe(true))
        expect(
          screen.getByRole('complementary', { name: 'Subject details (collapsed)' })
        ).toBeVisible()
        await userEvent.click(row('orders.eu'))
        const pane = await screen.findByTestId('subject-detail')
        expect(within(pane).getByRole('button', { name: 'Browse stored messages' })).toBeVisible()
      } finally {
        globalThis.ResizeObserver = original
      }
    })

    it('keeps a pane the user collapsed on purpose closed on click', async () => {
      narrow()
      try {
        const gateway = setup()
        gateway.settings.set('subjects.ui.dev', { paneCollapsed: true })
        renderWithGateway(<SubjectsTab connId="dev" />, gateway)
        await waitFor(() => expect(hasRow('orders')).toBe(true))
        await userEvent.click(row('orders.eu'))
        expect(row('orders.eu')).toHaveAttribute('aria-selected', 'true')
        expect(screen.queryByTestId('subject-detail')).toBeNull()
      } finally {
        globalThis.ResizeObserver = original
      }
    })
  })

  it('the row menu of the selected row uses the scope chosen in the pane', async () => {
    renderWithGateway(<SubjectsTab connId="dev" />, setup())
    await waitFor(() => expect(hasRow('orders')).toBe(true))
    await userEvent.click(row('orders.eu'))
    await userEvent.click(screen.getByLabelText(/^One level below/))
    await userEvent.click(screen.getByRole('button', { name: 'Actions for orders.eu' }))
    expect(
      screen.getByRole('menuitem', { name: /Start live tail on orders.eu.\*/ })
    ).toBeInTheDocument()
  })

  it('collapses the pane to a rail and back', async () => {
    const gateway = setup()
    renderWithGateway(<SubjectsTab connId="dev" />, gateway)
    await waitFor(() => expect(hasRow('orders')).toBe(true))
    await userEvent.click(screen.getByRole('button', { name: 'Collapse details' }))
    expect(screen.getByRole('complementary', { name: 'Subject details (collapsed)' })).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Show subject details' }))
    expect(screen.getByTestId('subject-detail')).toBeVisible()
    await waitFor(() =>
      expect(
        (gateway.settings.get('subjects.ui.dev') as { paneCollapsed: boolean }).paneCollapsed
      ).toBe(false)
    )
  })
})
