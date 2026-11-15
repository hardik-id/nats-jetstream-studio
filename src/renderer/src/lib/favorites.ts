import { useCallback } from 'react'
import { useSetting } from './hooks'
import type { TabSpec } from '../state/tabs'

export type Favorite =
  | { kind: 'stream'; stream: string }
  | { kind: 'consumer'; stream: string; consumer: string }
  | { kind: 'subject'; stream: string; subject: string }

export const favoriteKey = (f: Favorite): string =>
  f.kind === 'stream'
    ? `s:${f.stream}`
    : f.kind === 'consumer'
      ? `c:${f.stream}:${f.consumer}`
      : `j:${f.stream}:${f.subject}`

export const favoriteLabel = (f: Favorite): string =>
  f.kind === 'stream' ? f.stream : f.kind === 'consumer' ? `${f.stream} / ${f.consumer}` : f.subject

export function favoriteTab(connId: string, f: Favorite): TabSpec {
  if (f.kind === 'stream') return { kind: 'stream', connId, stream: f.stream }
  if (f.kind === 'consumer')
    return { kind: 'consumer', connId, stream: f.stream, consumer: f.consumer }
  return { kind: 'stream', connId, stream: f.stream, section: 'messages', subject: f.subject }
}

/** Starred streams, consumers and subjects of a connection (PBI-091). */
export function useFavorites(connId: string): {
  favorites: Favorite[]
  isFavorite: (f: Favorite) => boolean
  toggle: (f: Favorite) => void
  /** Stores a whole new list, for an import. */
  replace: (favorites: Favorite[]) => void
} {
  const [favorites, setFavorites] = useSetting<Favorite[]>(`conn:${connId}:favorites`, [])
  const isFavorite = useCallback(
    (f: Favorite) => favorites.some((x) => favoriteKey(x) === favoriteKey(f)),
    [favorites]
  )
  const toggle = useCallback(
    (f: Favorite) => {
      const key = favoriteKey(f)
      setFavorites(
        favorites.some((x) => favoriteKey(x) === key)
          ? favorites.filter((x) => favoriteKey(x) !== key)
          : [...favorites, f]
      )
    },
    [favorites, setFavorites]
  )
  return { favorites, isFavorite, toggle, replace: setFavorites }
}
