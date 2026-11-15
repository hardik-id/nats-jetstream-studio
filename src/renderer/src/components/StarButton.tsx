import type { ReactNode } from 'react'
import { Star } from 'lucide-react'
import { useFavorites, type Favorite } from '../lib/favorites'
import { cx } from './ui'

/** Adds or removes a favourite (PBI-091). Favourites show up in the sidebar under the connection. */
export function StarButton({
  connId,
  favorite,
  className
}: {
  connId: string
  favorite: Favorite
  className?: string
}): ReactNode {
  const { isFavorite, toggle } = useFavorites(connId)
  const on = isFavorite(favorite)
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={on ? 'Remove from favourites' : 'Add to favourites'}
      title={on ? 'Remove from favourites' : 'Add to favourites'}
      onClick={(e) => {
        e.stopPropagation()
        toggle(favorite)
      }}
      className={cx(
        'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-hover',
        on ? 'text-warn' : 'text-faint hover:text-fg',
        className
      )}
    >
      <Star className="h-3.5 w-3.5" fill={on ? 'currentColor' : 'none'} aria-hidden />
    </button>
  )
}
