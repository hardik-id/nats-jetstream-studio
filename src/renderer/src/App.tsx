import { useEffect, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ConnectionSummary } from '@shared/api'
import { Button, EmptyState } from './components/ui'
import { ConnectionForm } from './features/connections/ConnectionForm'
import { SecretPrompt } from './features/connections/SecretPrompt'
import { CommandPalette } from './features/shell/CommandPalette'
import { AboutDialog, HelpOverlay, UpdateBanner } from './features/shell/Overlays'
import { Sidebar } from './features/shell/Sidebar'
import { TabBar } from './features/shell/TabBar'
import { TabHost } from './features/shell/TabHost'
import { TopBar } from './features/shell/TopBar'
import { useGateway, type GatewayStatus } from './gateway'
import { useAlertFeed } from './state/alerts'
import { useTabs } from './state/tabs'
import { toast, Toaster } from './state/toasts'
import { resolveTheme, useOverlays, useUi } from './state/ui'

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return (
    !!el &&
    (el.tagName === 'INPUT' ||
      el.tagName === 'TEXTAREA' ||
      el.tagName === 'SELECT' ||
      el.isContentEditable)
  )
}

export default function App({ status }: { status: GatewayStatus }): ReactNode {
  const gateway = useGateway()
  const client = useQueryClient()
  const theme = useUi((s) => s.theme)
  const overlays = useOverlays()

  // Theme: follow the OS unless the user chose one.
  useEffect(() => {
    const apply = (): void => {
      document.documentElement.dataset.theme = resolveTheme(theme)
    }
    apply()
    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    media?.addEventListener('change', apply)
    return () => media?.removeEventListener('change', apply)
  }, [theme])

  // Events that are not tied to a request: connection status, alerts, server notices.
  useEffect(() => {
    return gateway.open('events', {}, (event) => {
      switch (event.type) {
        case 'connection': {
          const previous = client
            .getQueryData<ConnectionSummary[]>(['connections'])
            ?.find((c) => c.id === event.state.id)?.state
          client.setQueryData<ConnectionSummary[]>(['connections'], (list) =>
            list?.map((c) => (c.id === event.state.id ? { ...c, state: event.state } : c))
          )
          // Back after an outage: everything shown for this connection may be stale, so reload it
          // now instead of waiting for the next poll.
          if (event.state.status === 'connected' && previous?.status === 'reconnecting') {
            void client.invalidateQueries({ predicate: (q) => q.queryKey[1] === event.state.id })
          }
          break
        }
        case 'connections_changed':
          void client.invalidateQueries({ queryKey: ['connections'] })
          break
        case 'alert':
          useAlertFeed.getState().add(event.alert)
          break
        case 'notice':
          if (event.level === 'error') toast.error(event.message)
          else toast.info(event.message)
          break
      }
    })
  }, [gateway, client])

  // Global shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      const tabs = useTabs.getState()
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        useOverlays.getState().set({ palette: true })
      } else if (mod && e.key.toLowerCase() === 'w' && tabs.activeId) {
        e.preventDefault()
        tabs.close(tabs.activeId)
      } else if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault()
        tabs.cycle(e.shiftKey ? -1 : 1)
      } else if (e.key === '?' && !mod && !isTyping(e.target)) {
        e.preventDefault()
        useOverlays.getState().set({ help: true })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (status === 'signed-out') {
    return (
      <EmptyState title="You are signed out">
        <Button variant="primary" onClick={() => (location.href = '/auth/login')}>
          Sign in
        </Button>
      </EmptyState>
    )
  }

  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <UpdateBanner />
        <TabBar />
        <div className="min-h-0 flex-1 bg-bg">
          <TabHost />
        </div>
      </main>

      {overlays.connectionForm && (
        <ConnectionForm
          id={overlays.connectionForm === 'new' ? null : overlays.connectionForm}
          onClose={() => overlays.set({ connectionForm: null })}
        />
      )}
      {overlays.secretPrompt && (
        <SecretPrompt
          id={overlays.secretPrompt}
          onClose={() => overlays.set({ secretPrompt: null })}
        />
      )}
      {overlays.palette && <CommandPalette onClose={() => overlays.set({ palette: false })} />}
      {overlays.help && <HelpOverlay onClose={() => overlays.set({ help: false })} />}
      {overlays.about && <AboutDialog onClose={() => overlays.set({ about: false })} />}
      <Toaster />

      {status === 'lost' && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/55">
          <div
            role="alertdialog"
            aria-label="Connection to the studio server lost"
            className="rounded-lg border border-line bg-panel p-6 text-center shadow-2xl"
          >
            <p className="mb-1 text-sm font-semibold">Lost the connection to the studio server</p>
            <p className="mb-4 text-muted">Reload to reconnect. Open tabs are restored.</p>
            <Button variant="primary" onClick={() => location.reload()}>
              Reload
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
