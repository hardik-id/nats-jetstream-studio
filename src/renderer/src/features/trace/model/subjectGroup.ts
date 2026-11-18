/**
 * Collapsing id-like subject tokens (PBI-138 phase 2), so that `orders.123.paid` and
 * `orders.456.paid` share one lane. It is a heuristic and only for grouping: the real subject is
 * always what is shown in a tooltip and in the detail.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEX = /^[0-9a-f]{8,}$/i
/** Numbers joined by `-`, `_` or `:` such as a date (`2026-03-01`) or a range (`10-20`). */
const NUMERIC_PARTS = /^\d+(?:[-_:]\d+)+$/
const ALNUM = /^[A-Za-z0-9]+$/
/** Shortest mixed letters-and-digits token taken for a random id (shorter ones are `ipv4`, `oauth2`). */
const MIN_RANDOM_LENGTH = 10

/**
 * Whether a token looks like an identifier rather than a word: all digits, a UUID, a long hex
 * string with a digit in it, a date or a range of numbers, or a long random-looking token of
 * letters and digits (base62, ULID). Words (`orders`), versions (`v2`), and short names with
 * digits (`s3`, `ipv4`, `oauth2`, `h264`) are not.
 */
export function isIdToken(token: string): boolean {
  if (token === '' || token === '*' || token === '>') return false
  // A prefixed id: `order-1234`, `cust_0001`, `usr_8f3a9c21`. The rest must look like an id on
  // its own, and a bare number after a prefix needs four digits (`sha-256`, `utf-8` are words).
  const prefixed = /^[A-Za-z]+[-_](.+)$/.exec(token)
  if (prefixed) {
    const rest = prefixed[1]
    return /^\d+$/.test(rest) ? rest.length >= 4 : isIdToken(rest)
  }
  if (/^\d+$/.test(token)) return true
  if (UUID.test(token)) return true
  if (HEX.test(token) && /\d/.test(token)) return true
  if (NUMERIC_PARTS.test(token)) return true
  if (token.length < MIN_RANDOM_LENGTH || !ALNUM.test(token) || !/[A-Za-z]/.test(token))
    return false
  // Random ids have several digits, or both cases with a digit; `kubernetes2` has neither.
  const digits = token.replace(/\D/g, '').length
  return digits >= 2 || (digits === 1 && /[a-z]/.test(token) && /[A-Z]/.test(token))
}

/**
 * The lane key of a subject: id-like tokens become `*`. The first token is a namespace and is
 * never collapsed, and wildcards stay as they are.
 */
export function groupSubject(subject: string): string {
  return subject
    .split('.')
    .map((token, i) => (i > 0 && isIdToken(token) ? '*' : token))
    .join('.')
}
