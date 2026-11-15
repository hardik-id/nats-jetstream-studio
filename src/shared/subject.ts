/** NATS subject helpers. */

/** True when `subject` is matched by `pattern`, where `*` matches one token and `>` the rest. */
export function subjectMatches(pattern: string, subject: string): boolean {
  if (pattern === '>' || pattern === subject) return true
  const p = pattern.split('.')
  const s = subject.split('.')
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '>') return i === p.length - 1 && s.length > i
    if (i >= s.length) return false
    if (p[i] !== '*' && p[i] !== s[i]) return false
  }
  return p.length === s.length
}

/** Returns a message when the subject (or wildcard filter) is not valid, otherwise null. */
export function validateSubject(subject: string, allowWildcards = true): string | null {
  if (!subject) return 'Subject is required'
  if (/\s/.test(subject)) return 'Subject cannot contain whitespace'
  const tokens = subject.split('.')
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === '') return 'Subject cannot have empty tokens'
    if (token === '>') {
      if (!allowWildcards) return 'Wildcards are not allowed here'
      if (i !== tokens.length - 1) return '">" is only allowed as the last token'
    } else if (token === '*') {
      if (!allowWildcards) return 'Wildcards are not allowed here'
    } else if (token.includes('*') || token.includes('>')) {
      return 'Wildcards must be a whole token'
    }
  }
  return null
}

export function hasWildcard(subject: string): boolean {
  return subject.split('.').some((t) => t === '*' || t === '>')
}

/** True when two subject patterns can match at least one common subject. */
export function subjectsOverlap(a: string, b: string): boolean {
  const x = a.split('.')
  const y = b.split('.')
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i]
    const q = y[i]
    if (p === '>' || q === '>') return p !== undefined && q !== undefined
    if (p === undefined || q === undefined) return false
    if (p !== '*' && q !== '*' && p !== q) return false
  }
  return true
}

export interface SubjectNode {
  token: string
  /** Full subject up to and including this token. */
  path: string
  /** Messages stored on exactly this subject. */
  count: number
  /** Messages stored on this subject and everything below it. */
  total: number
  children: Map<string, SubjectNode>
}

/** Builds a token tree from subject counts (PBI-061). */
export function buildSubjectTree(
  subjects: Iterable<{ subject: string; count: number }>
): SubjectNode {
  const root: SubjectNode = { token: '', path: '', count: 0, total: 0, children: new Map() }
  for (const { subject, count } of subjects) {
    let node = root
    root.total += count
    const tokens = subject.split('.')
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]
      let child = node.children.get(token)
      if (!child) {
        child = {
          token,
          path: node.path ? `${node.path}.${token}` : token,
          count: 0,
          total: 0,
          children: new Map()
        }
        node.children.set(token, child)
      }
      child.total += count
      if (i === tokens.length - 1) child.count += count
      node = child
    }
  }
  return root
}
