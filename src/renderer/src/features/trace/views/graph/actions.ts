import { createContext } from 'react'

/** What the edges and their labels can ask of the Graph view. */
export interface GraphActionsValue {
  /** A click on an edge (or its label): select the message it leads to. */
  pickEdge: (id: string) => void
  /** Hovering an edge or its label holds the dots still, so its label can be read. */
  pause: () => void
  resume: () => void
}

export const GraphActions = createContext<GraphActionsValue>({
  pickEdge: () => {},
  pause: () => {},
  resume: () => {}
})
