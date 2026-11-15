import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import type { AppInfo, ConnectionSummary } from '@shared/api'
import { useGateway } from '../gateway'

/** True while the tab that renders this component is the visible one. Hidden tabs do not poll. */
export const TabActiveContext = createContext(true)
export const useTabActive = (): boolean => useContext(TabActiveContext)

export const REFRESH_MS = 5000

/** Polling interval for the current tab, or false to pause while it is hidden. */
export function useRefetchInterval(ms = REFRESH_MS, enabled = true): number | false {
  const active = useTabActive()
  return active && enabled ? ms : false
}

export function useConnections(): UseQueryResult<ConnectionSummary[]> {
  const gateway = useGateway()
  return useQuery({
    queryKey: ['connections'],
    queryFn: () => gateway.listConnections(),
    staleTime: Infinity
  })
}

export function useConnection(connId: string | undefined): ConnectionSummary | undefined {
  const { data } = useConnections()
  return connId ? data?.find((c) => c.id === connId) : undefined
}

export function useAppInfo(): AppInfo | undefined {
  const gateway = useGateway()
  return useQuery({ queryKey: ['appInfo'], queryFn: () => gateway.appInfo(), staleTime: Infinity })
    .data
}

/**
 * A value stored by the gateway (saved filters, favourites, templates...).
 * Returns the value, a setter that saves it, and whether the first load has finished.
 */
export function useSetting<T>(key: string, fallback: T): [T, (value: T) => void, boolean] {
  const gateway = useGateway()
  const client = useQueryClient()
  const query = useQuery({
    queryKey: ['setting', key],
    queryFn: () => gateway.getSetting(key) as Promise<T | null>,
    staleTime: Infinity
  })
  const mutation = useMutation({
    mutationFn: (value: T) => gateway.setSetting(key, value),
    onMutate: (value) => client.setQueryData(['setting', key], value)
  })
  const { mutate } = mutation
  const set = useCallback((value: T) => mutate(value), [mutate])
  return [query.data ?? fallback, set, query.isSuccess]
}

/** Keeps the latest value of something in a ref, for callbacks that should not re-subscribe. */
export function useLatest<T>(value: T): React.RefObject<T> {
  const ref = useRef(value)
  useEffect(() => {
    ref.current = value
  })
  return ref
}

export function useDebounced<T>(value: T, ms = 200): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return debounced
}

/** Re-renders on an interval, for "3s ago" labels. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  const active = useTabActive()
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(timer)
  }, [ms, active])
  return now
}
