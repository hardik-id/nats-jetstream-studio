import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Button, Menu } from '@renderer/components/ui'
import { MessageBrowser } from '@renderer/features/messages/MessageBrowser'
import { createFakeGateway, type FakeGateway } from '@renderer/gateway/fake'
import type { Favorite } from '@renderer/lib/favorites'
import type { SavedFilter } from '@renderer/lib/messages'
import { buildSavedExport, serializeSavedExport } from '@renderer/lib/savedExport'
import { Toaster, useToasts } from '@renderer/state/toasts'
import { renderWithGateway } from './render'

const SAVED_KEY = 'conn:dev:savedFilters'
const FAVORITES_KEY = 'conn:dev:favorites'

const STORED_FILTERS: SavedFilter[] = [
  { name: 'EU paid', subject: 'orders.eu.old', filters: {} },
  { name: 'Mine', subject: 'mine.>', filters: {} }
]
const STORED_FAVORITES: Favorite[] = [{ kind: 'stream', stream: 'JOBS' }]

/** What the imported file holds: one filter that replaces a stored one, one new, one new favourite. */
const FILE_FILTERS: SavedFilter[] = [
  { name: 'EU paid', subject: 'orders.eu.paid', filters: {} },
  { name: 'Hot CPUs', subject: 'alerts.cpu>90', filters: {} }
]
const FILE_FAVORITES: Favorite[] = [
  { kind: 'stream', stream: 'JOBS' },
  { kind: 'consumer', stream: 'ORDERS', consumer: 'billing' }
]
const exportFile = (): File =>
  new File(
    [serializeSavedExport(buildSavedExport(FILE_FILTERS, FILE_FAVORITES))],
    'saved-filters-Dev.json',
    { type: 'application/json' }
  )

function seededGateway(): FakeGateway {
  const gateway = createFakeGateway({ connections: [{ id: 'dev', name: 'Dev' }] })
  gateway.streams.set('ORDERS', {
    config: {
      name: 'ORDERS',
      subjects: ['orders.>'],
      storage: 'file',
      retention: 'limits',
      num_replicas: 1
    },
    messages: [{ seq: 1, subject: 'orders.eu', payload: '{}', time: '2026-01-01T00:00:00Z' }],
    consumers: []
  })
  gateway.settings.set(SAVED_KEY, structuredClone(STORED_FILTERS))
  gateway.settings.set(FAVORITES_KEY, structuredClone(STORED_FAVORITES))
  return gateway
}

async function renderBrowser(gateway: FakeGateway): Promise<void> {
  const info = await gateway.streamInfo('dev', 'ORDERS')
  gateway.calls.length = 0
  renderWithGateway(
    <>
      <MessageBrowser connId="dev" info={info} />
      <Toaster />
    </>,
    gateway
  )
  await screen.findByRole('table', { name: 'Messages in ORDERS' })
}

const openMenu = async (): Promise<HTMLElement> => {
  if (!screen.queryByRole('menu'))
    await userEvent.click(screen.getByRole('button', { name: 'Saved' }))
  return screen.getByRole('menu')
}
const closeMenu = async (): Promise<void> => {
  if (screen.queryByRole('menu')) await userEvent.keyboard('{Escape}')
}
const item = (menu: HTMLElement, name: string): HTMLElement =>
  within(menu).getByRole('menuitem', { name })
const savedNames = async (): Promise<string[]> => {
  const menu = await openMenu()
  const names = within(menu)
    .getAllByRole('menuitem')
    .map((m) => m.textContent ?? '')
    .filter((n) => !/\.\.\.$|^Remove all/.test(n))
  await closeMenu()
  return names
}

/** Picks the "Import" entry and hands `file` to the file chooser it opens. */
async function importFile(file: File): Promise<void> {
  await userEvent.click(item(await openMenu(), 'Import filters and favourites...'))
  const chooser = document.body.querySelector<HTMLInputElement>('input[type="file"]')
  expect(chooser, 'the file chooser').not.toBeNull()
  fireEvent.change(chooser!, { target: { files: [file] } })
}

const toasts = (): string[] => useToasts.getState().toasts.map((t) => `${t.tone}: ${t.message}`)
/** The settings the UI asked the gateway to store, in order, whether or not that has finished. */
const writes = (gateway: FakeGateway): string[] =>
  gateway.calls.filter((c) => c.method === 'setSetting').map((c) => String(c.args[0]))

/**
 * Makes `setSetting` wait for, or fail with, whatever `before` does. The call is recorded first,
 * as the fake gateway does, so `writes` also lists a write that is still on its way.
 */
function interceptWrites(
  gateway: FakeGateway,
  before: (key: string) => Promise<void> | void
): void {
  const store = (key: string, value: unknown): void => {
    if (value === null || value === undefined) gateway.settings.delete(key)
    else gateway.settings.set(key, value)
  }
  gateway.setSetting = async (key, value) => {
    gateway.calls.push({ method: 'setSetting', args: [key, value] })
    await before(key)
    store(key, value)
  }
}

/** Lets a test decide when, and how, a call to the gateway ends. */
function gate(): { wait: Promise<void>; open: () => void; fail: (reason: Error) => void } {
  let open!: () => void
  let fail!: (reason: Error) => void
  const wait = new Promise<void>((resolve, reject) => {
    open = resolve
    fail = reject
  })
  wait.catch(() => {})
  return { wait, open, fail }
}

describe('PBI-091 importing saved filters and favourites in the message browser', () => {
  it('imports only after both stored lists were read, and says why it waits', async () => {
    const gateway = seededGateway()
    const reading = gate()
    const getSetting = gateway.getSetting.bind(gateway)
    gateway.getSetting = async (key) => {
      if (key === FAVORITES_KEY) await reading.wait
      return getSetting(key)
    }
    await renderBrowser(gateway)

    // The saved filters are there, the favourites are still on their way: importing now would
    // merge into an empty favourites list and store that over the real one.
    let menu = await openMenu()
    expect(item(menu, 'EU paid')).toBeInTheDocument()
    for (const name of ['Import filters and favourites...', 'Export filters and favourites...']) {
      expect(item(menu, name)).toBeDisabled()
      expect(item(menu, name)).toHaveAttribute(
        'title',
        'The favourites of this connection are still being read'
      )
    }
    await userEvent.click(item(menu, 'Import filters and favourites...'))
    expect(document.body.querySelector('input[type="file"]')).toBeNull()
    await closeMenu()

    reading.open()
    await waitFor(async () => {
      menu = await openMenu()
      expect(item(menu, 'Import filters and favourites...')).toBeEnabled()
    })
    expect(item(menu, 'Export filters and favourites...')).toBeEnabled()
    expect(item(menu, 'Import filters and favourites...')).toHaveAttribute(
      'title',
      'Import filters and favourites...'
    )
    await closeMenu()

    await importFile(exportFile())
    await waitFor(() =>
      expect(toasts()).toEqual(['ok: Imported 2 saved filters (1 replaced) and 1 favourite'])
    )
    // Merged into what was stored, not into an empty list.
    expect(gateway.settings.get(SAVED_KEY)).toEqual([
      FILE_FILTERS[0],
      STORED_FILTERS[1],
      FILE_FILTERS[1]
    ])
    expect(gateway.settings.get(FAVORITES_KEY)).toEqual([STORED_FAVORITES[0], FILE_FAVORITES[1]])
  })

  it('refuses to import or export when the stored lists could not be read', async () => {
    const gateway = seededGateway()
    const getSetting = gateway.getSetting.bind(gateway)
    gateway.getSetting = async (key) => {
      if (key === SAVED_KEY) throw new Error('settings.json is damaged')
      return getSetting(key)
    }
    await renderBrowser(gateway)

    const menu = await openMenu()
    const reason =
      'The saved filters of this connection could not be read. settings.json is damaged'
    await waitFor(() =>
      expect(item(menu, 'Import filters and favourites...')).toHaveAttribute('title', reason)
    )
    for (const name of [
      'Import filters and favourites...',
      'Export filters and favourites...',
      'Save current filters...'
    ]) {
      expect(item(menu, name)).toBeDisabled()
      expect(item(menu, name)).toHaveAttribute('title', reason)
    }
    await userEvent.click(item(menu, 'Import filters and favourites...'))
    expect(document.body.querySelector('input[type="file"]')).toBeNull()
    expect(writes(gateway)).toEqual([])
    // What is stored is untouched.
    expect(gateway.settings.get(SAVED_KEY)).toEqual(STORED_FILTERS)
    expect(gateway.settings.get(FAVORITES_KEY)).toEqual(STORED_FAVORITES)
  })

  it('reports the import only once both lists are stored', async () => {
    const gateway = seededGateway()
    const storing: Record<string, ReturnType<typeof gate>> = {
      [SAVED_KEY]: gate(),
      [FAVORITES_KEY]: gate()
    }
    interceptWrites(gateway, (key) => storing[key]?.wait)
    await renderBrowser(gateway)
    await importFile(exportFile())

    // The first write is on its way. Nothing is announced, and the second has not started.
    await waitFor(() => expect(writes(gateway)).toEqual([SAVED_KEY]))
    await new Promise((r) => setTimeout(r, 50))
    expect(toasts()).toEqual([])

    storing[SAVED_KEY].open()
    await waitFor(() => expect(writes(gateway)).toEqual([SAVED_KEY, FAVORITES_KEY]))
    await new Promise((r) => setTimeout(r, 50))
    expect(toasts()).toEqual([])

    storing[FAVORITES_KEY].open()
    await waitFor(() =>
      expect(toasts()).toEqual(['ok: Imported 2 saved filters (1 replaced) and 1 favourite'])
    )
    expect(await savedNames()).toEqual(['EU paid', 'Mine', 'Hot CPUs'])
  })

  it('shows the error and what is really stored when the first write fails', async () => {
    const gateway = seededGateway()
    const storing = gate()
    interceptWrites(gateway, (key) => (key === SAVED_KEY ? storing.wait : undefined))
    await renderBrowser(gateway)
    await importFile(exportFile())
    await waitFor(() => expect(writes(gateway)).toEqual([SAVED_KEY]))
    storing.fail(new Error('the disk is full'))

    await waitFor(() =>
      expect(toasts()).toEqual(['error: This change could not be saved. the disk is full'])
    )
    // The failed import stops there: the favourites are not written, nothing claims success, and
    // the menu shows the stored filters again, not the ones that were never saved.
    await new Promise((r) => setTimeout(r, 50))
    expect(writes(gateway)).toEqual([SAVED_KEY])
    expect(toasts()).toHaveLength(1)
    expect(await savedNames()).toEqual(['EU paid', 'Mine'])
    expect(screen.getByRole('alert')).toHaveTextContent('the disk is full')
    await userEvent.click(item(await openMenu(), 'EU paid'))
    expect(screen.getByLabelText('Subject filter')).toHaveValue('orders.eu.old')
    expect(gateway.settings.get(SAVED_KEY)).toEqual(STORED_FILTERS)
    expect(gateway.settings.get(FAVORITES_KEY)).toEqual(STORED_FAVORITES)
  })

  it('says what was imported and what was not when the second write fails', async () => {
    const gateway = seededGateway()
    interceptWrites(gateway, (key) => {
      if (key === FAVORITES_KEY) throw new Error('the disk is full')
    })
    await renderBrowser(gateway)
    await importFile(exportFile())

    await waitFor(() =>
      expect(toasts()).toEqual([
        'error: This change could not be saved. the disk is full',
        'info: Only part of the file was imported: 2 saved filters. Its favourites were not.'
      ])
    )
    expect(toasts().some((t) => t.startsWith('ok:'))).toBe(false)
    expect(await savedNames()).toEqual(['EU paid', 'Mine', 'Hot CPUs'])
    expect(gateway.settings.get(FAVORITES_KEY)).toEqual(STORED_FAVORITES)
  })

  it('says so when a file brings nothing new, and refuses a file that is not an export', async () => {
    const gateway = seededGateway()
    await renderBrowser(gateway)
    await importFile(
      new File([serializeSavedExport(buildSavedExport([], STORED_FAVORITES))], 'same.json')
    )
    await waitFor(() =>
      expect(toasts()).toEqual([
        'info: Nothing to import. The file has no saved filters and no new favourites.'
      ])
    )
    useToasts.setState({ toasts: [] })
    await importFile(new File(['{"version": 2}'], 'other.json'))
    await waitFor(() =>
      expect(toasts()).toEqual(['error: This file has version 2. Only version 1 can be imported.'])
    )
    expect(writes(gateway)).toEqual([])
  })
})

describe('useSetting: a write that fails', () => {
  it('is reported and undone for a caller that does not wait for it', async () => {
    const gateway = seededGateway()
    let refuse = true
    interceptWrites(gateway, () => {
      if (refuse) throw new Error('the studio server is not reachable')
    })
    await renderBrowser(gateway)

    // "Remove all saved filters" just calls the setter.
    await userEvent.click(item(await openMenu(), 'Remove all saved filters'))
    await waitFor(() =>
      expect(toasts()).toEqual([
        'error: This change could not be saved. the studio server is not reachable'
      ])
    )
    // The stored value was read again, so the filters that could not be removed are back.
    await waitFor(async () => expect(await savedNames()).toEqual(['EU paid', 'Mine']))
    expect(
      gateway.calls.filter((c) => c.method === 'getSetting' && c.args[0] === SAVED_KEY).length
    ).toBeGreaterThanOrEqual(2)

    // Once the gateway works again the same action goes through, with no error.
    refuse = false
    useToasts.setState({ toasts: [] })
    await userEvent.click(item(await openMenu(), 'Remove all saved filters'))
    await waitFor(() => expect(gateway.settings.has(SAVED_KEY)).toBe(true))
    await waitFor(() => expect(gateway.settings.get(SAVED_KEY)).toEqual([]))
    expect(await savedNames()).toEqual([])
    expect(toasts()).toEqual([])
  })
})

describe('Menu', () => {
  it('shows two entries with the same label and tells them apart', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const first = vi.fn()
    const second = vi.fn()
    renderWithGateway(
      <Menu
        trigger={(props) => <Button {...props}>Open</Button>}
        items={[
          { label: 'Save current filters...', onSelect: first },
          { label: 'Other', onSelect: () => {} },
          { label: 'Save current filters...', onSelect: second }
        ]}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: 'Open' }))
    const same = screen.getAllByRole('menuitem', { name: 'Save current filters...' })
    expect(same).toHaveLength(2)
    // React reports two children with the same key through console.error.
    expect(errors.mock.calls.filter((c) => /same key/.test(String(c[0])))).toEqual([])
    await userEvent.click(same[1])
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
    errors.mockRestore()
  })

  it('keeps a long label on one line, cut short, with the whole text as the tooltip', async () => {
    const long = 'orders-eu-paid-'.repeat(20)
    renderWithGateway(
      <Menu
        trigger={(props) => <Button {...props}>Open</Button>}
        items={[
          { label: long, onSelect: () => {} },
          { label: 'Export', title: 'Nothing to export', disabled: true, onSelect: () => {} }
        ]}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: 'Open' }))
    const entry = screen.getByRole('menuitem', { name: long })
    expect(entry).toHaveAttribute('title', long)
    const text = within(entry).getByText(long)
    expect(text).toHaveClass('truncate', 'min-w-0')
    expect(screen.getByRole('menu')).toHaveClass('max-w-80')
    // A tooltip the caller chose is kept as it is.
    expect(screen.getByRole('menuitem', { name: 'Export' })).toHaveAttribute(
      'title',
      'Nothing to export'
    )
  })
})
