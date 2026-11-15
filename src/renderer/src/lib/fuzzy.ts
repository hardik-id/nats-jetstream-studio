/**
 * Scores how well `query` matches `text` as a subsequence. Higher is better, null is no match.
 * Consecutive characters and matches at word starts score more, so "ordcre" finds "orders.created".
 */
export function fuzzyScore(query: string, text: string): number | null {
  if (!query) return 0
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  const exact = t.indexOf(q)
  if (exact >= 0) return 1000 - exact - (t.length - q.length) * 0.1

  let score = 0
  let ti = 0
  let streak = 0
  let first = -1
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi]
    let found = -1
    for (let i = ti; i < t.length; i++) {
      if (t[i] === ch) {
        found = i
        break
      }
    }
    if (found < 0) return null
    if (first < 0) first = found
    // Letters scattered across a long name are a coincidence, not a match.
    if (found - first + 1 > q.length * 2 + 2) return null
    const atWordStart = found === 0 || /[._\-\s:/>]/.test(t[found - 1])
    streak = found === ti && qi > 0 ? streak + 1 : 0
    score += 10 + streak * 5 + (atWordStart ? 8 : 0) - (found - ti) * 0.5
    ti = found + 1
  }
  return score - t.length * 0.05
}

export function fuzzyFilter<T>(
  items: T[],
  query: string,
  text: (item: T) => string,
  limit = 50
): T[] {
  if (!query.trim()) return items.slice(0, limit)
  const scored: { item: T; score: number }[] = []
  for (const item of items) {
    const score = fuzzyScore(query.trim(), text(item))
    if (score !== null) scored.push({ item, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map((s) => s.item)
}
