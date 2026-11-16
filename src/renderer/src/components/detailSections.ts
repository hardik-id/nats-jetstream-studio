import { createContext, useContext } from 'react'

export type DetailSectionId = 'details' | 'headers' | 'consumers' | 'payload'
export type DetailSections = Record<DetailSectionId, boolean>

export const DEFAULT_DETAIL_SECTIONS: DetailSections = {
  details: true,
  // Headers and Consumers start closed (their summary says what is in them), so the payload has
  // the height; Details and Payload start open.
  headers: false,
  // Consumers is the tallest and least often needed section, so it starts closed.
  consumers: false,
  payload: true
}

/** Reads a stored value, ignoring unknown keys and anything that is not a boolean. */
export function normalizeSections(stored: unknown): DetailSections {
  const out = { ...DEFAULT_DETAIL_SECTIONS }
  if (stored && typeof stored === 'object') {
    for (const id of Object.keys(out) as DetailSectionId[]) {
      const v = (stored as Record<string, unknown>)[id]
      if (typeof v === 'boolean') out[id] = v
    }
  }
  return out
}

export const DetailSectionsContext = createContext<{
  sections: DetailSections
  toggle: (id: DetailSectionId) => void
}>({ sections: DEFAULT_DETAIL_SECTIONS, toggle: () => {} })

/** The open state of one section of the message detail panel, and how to flip it. */
export function useDetailSection(id: DetailSectionId): { open: boolean; toggle: () => void } {
  const ctx = useContext(DetailSectionsContext)
  return { open: ctx.sections[id], toggle: () => ctx.toggle(id) }
}
