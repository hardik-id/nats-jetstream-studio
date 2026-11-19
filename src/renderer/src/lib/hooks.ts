import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import type { AppInfo, ConnectionSummary } from '@shared/api'
import { errorMessage } from '../components/ui'
import { useGateway } from '../gateway'
import { toast } from '../state/toasts'

/** True while the tab that renders this component is the visible one. Hidden tabs do not poll. */
export const TabActiveContext = createContext(true)
export const useTabActive = (): boolean => useContext(TabActiveContext)

export const REFRESH_MS = 5000

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'
const subscribeReducedMotion = (onChange: () => void): (() => void) => {
  const media = window.matchMedia?.(REDUCED_MOTION)
  media?.addEventListener('change', onChange)
  return () => media?.removeEventListener('change', onChange)
}

/** True while the system asks for reduced motion; follows changes to the setting. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia?.(REDUCED_MOTION).matches ?? false,
    () => false
  )
}

const subscribeVisibility = (onChange: () => void): (() => void) => {
  document.addEventListener('visibilitychange', onChange)
  return () => document.removeEventListener('visibilitychange', onChange)
}

/** False while the page is hidden (a minimised window, another browser tab). */
export function useDocumentVisible(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState !== 'hidden',
    () => true
  )
}

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
 *
 * Returns the value, a setter, whether the stored value has been read, and the error when
 * reading it failed. Until it has been read the value is `fallback`, which says nothing about
 * what is stored: a caller that builds the next value from the current one (adding to a list,
 * merging an import) must wait for `loaded`, or it replaces the stored value with its fallback.
 *
 * The setter shows the new value at once and resolves to true when it has been stored. When the
 * write fails it says so in a toast, shows again what is really stored and resolves to false. It
 * never rejects, so a caller that does not wait for the result needs no error handling.
 */
export function useSetting<T>(
  key: string,
  fallback: T
): [value: T, set: (value: T) => Promise<boolean>, loaded: boolean, loadError: unknown] {
  const gateway = useGateway()
  const client = useQueryClient()
  const query = useQuery({
    queryKey: ['setting', key],
    queryFn: () => gateway.getSetting(key) as Promise<T | null>,
    staleTime: Infinity
  })
  const { mutateAsync } = useMutation({
    mutationFn: (value: T) => gateway.setSetting(key, value),
    onMutate: async (value) => {
      const queryKey = ['setting', key]
      // A read that is still on its way must not put the old value back when it arrives.
      await client.cancelQueries({ queryKey })
      const previous = client.getQueryData<T | null>(queryKey)
      client.setQueryData(queryKey, value)
      return { previous }
    },
    onError: (err, _value, context) => {
      const queryKey = ['setting', key]
      // Nothing was stored, so the value that was shown before is the best answer until the
      // stored one has been read again. Without one (the first read never finished) start over.
      if (context?.previous === undefined) {
        void client.resetQueries({ queryKey })
      } else {
        client.setQueryData(queryKey, context.previous)
        void client.invalidateQueries({ queryKey })
      }
      toast.error(`This change could not be saved. ${errorMessage(err)}`)
    }
  })
  const set = useCallback(
    (value: T) =>
      mutateAsync(value).then(
        () => true,
        () => false
      ),
    [mutateAsync]
  )
  return [query.data ?? fallback, set, query.isSuccess, query.isError ? query.error : null]
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
