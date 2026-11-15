import type { ReactElement, ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import { GatewayContext } from '@renderer/gateway'
import { createFakeGateway, type FakeGateway } from '@renderer/gateway/fake'
import { useTabs } from '@renderer/state/tabs'
import { useToasts } from '@renderer/state/toasts'
import { useOverlays, useUi } from '@renderer/state/ui'

/** Renders UI against the in-memory fake gateway, with fresh app state. */
export function renderWithGateway(ui: ReactElement, gateway: FakeGateway = createFakeGateway()) {
  localStorage.clear()
  useTabs.setState({ tabs: [], activeId: null, counter: 1 })
  useUi.setState({ theme: 'light', collapsed: {} })
  useOverlays.setState({
    palette: false,
    help: false,
    about: false,
    connectionForm: null,
    secretPrompt: null
  })
  useToasts.setState({ toasts: [] })
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 }, mutations: { retry: false } }
  })
  const wrapper = ({ children }: { children: ReactNode }): ReactElement => (
    <GatewayContext.Provider value={gateway}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </GatewayContext.Provider>
  )
  return { ...render(ui, { wrapper }), gateway }
}
