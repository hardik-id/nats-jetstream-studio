import './main.css'

import { StrictMode, useMemo, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import { createGateway, GatewayContext, type GatewayStatus } from './gateway'

function Root(): ReactNode {
  const [status, setStatus] = useState<GatewayStatus>('connecting')
  const gateway = useMemo(() => createGateway(setStatus), [])
  const client = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          // A NATS error will not go away by asking again straight away, so show it instead.
          queries: { retry: false, refetchOnWindowFocus: false, staleTime: 2000 },
          mutations: { retry: false }
        }
      }),
    []
  )
  return (
    <GatewayContext.Provider value={gateway}>
      <QueryClientProvider client={client}>
        <App status={status} />
      </QueryClientProvider>
    </GatewayContext.Provider>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>
)
