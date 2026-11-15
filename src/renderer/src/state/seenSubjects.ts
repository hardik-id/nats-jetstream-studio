import { create } from 'zustand'

const MAX_SUBJECTS = 5000

interface SeenSubjects {
  /** Per connection: subject -> messages seen in live tails during this session. */
  byConn: Record<string, Record<string, number>>
  record(connId: string, counts: Map<string, number>): void
}

/** Subjects observed in live tails, so the subject tree can show core NATS traffic too (PBI-061). */
export const useSeenSubjects = create<SeenSubjects>((set, get) => ({
  byConn: {},
  record(connId, counts) {
    if (counts.size === 0) return
    const current = { ...(get().byConn[connId] ?? {}) }
    let size = Object.keys(current).length
    for (const [subject, n] of counts) {
      if (subject in current) current[subject] += n
      else if (size < MAX_SUBJECTS) {
        current[subject] = n
        size++
      }
    }
    set({ byConn: { ...get().byConn, [connId]: current } })
  }
}))
