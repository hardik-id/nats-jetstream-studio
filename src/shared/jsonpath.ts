/**
 * A small JSONPath evaluator with an optional comparison, used by the message filter (PBI-048).
 *
 *   $.order.total > 100
 *   $.items[*].sku == "A-1"
 *   $..status != "ok"
 *   $.customer.email =~ /@example\.com$/i
 *   $.tags contains "urgent"
 *   $.error            (matches when the path selects a value that is not null or false)
 *
 * Written by hand, with no eval, so a filter can never run code.
 */

type Step =
  | { kind: 'child'; name: string }
  | { kind: 'index'; index: number }
  | { kind: 'wildcard' }
  | { kind: 'descendant'; name: string | null }

export type JsonPathOperator = '==' | '!=' | '>' | '>=' | '<' | '<=' | '=~' | 'contains'

export interface JsonPathFilter {
  steps: Step[]
  operator?: JsonPathOperator
  value?: string | number | boolean | null | RegExp
}

export class JsonPathSyntaxError extends Error {
  constructor(message: string, position: number) {
    super(`${message} (at position ${position + 1})`)
    this.name = 'JsonPathSyntaxError'
  }
}

const NAME = /[^\s.[\]=!<>~'"()]+/y
const OPERATORS: JsonPathOperator[] = ['==', '!=', '>=', '<=', '=~', '>', '<', 'contains']

export function parseJsonPathFilter(source: string): JsonPathFilter {
  const text = source.trim()
  let pos = 0

  if (text[pos] !== '$') throw new JsonPathSyntaxError('Expression must start with $', pos)
  pos++

  const steps: Step[] = []
  for (;;) {
    const ch = text[pos]
    if (ch === '.') {
      if (text[pos + 1] === '.') {
        pos += 2
        if (text[pos] === '*') {
          steps.push({ kind: 'descendant', name: null })
          pos++
        } else {
          steps.push({ kind: 'descendant', name: readName() })
        }
      } else {
        pos++
        if (text[pos] === '*') {
          steps.push({ kind: 'wildcard' })
          pos++
        } else {
          steps.push({ kind: 'child', name: readName() })
        }
      }
    } else if (ch === '[') {
      pos++
      skipSpaces()
      if (text[pos] === '*') {
        steps.push({ kind: 'wildcard' })
        pos++
      } else if (text[pos] === "'" || text[pos] === '"') {
        steps.push({ kind: 'child', name: readString() })
      } else {
        const m = /-?\d+/y
        m.lastIndex = pos
        const found = m.exec(text)
        if (!found) throw new JsonPathSyntaxError('Expected an index, a quoted name or *', pos)
        steps.push({ kind: 'index', index: Number(found[0]) })
        pos = m.lastIndex
      }
      skipSpaces()
      if (text[pos] !== ']') throw new JsonPathSyntaxError('Expected ]', pos)
      pos++
    } else {
      break
    }
  }

  skipSpaces()
  if (pos >= text.length) return { steps }

  const operator = OPERATORS.find((op) => text.startsWith(op, pos))
  if (!operator)
    throw new JsonPathSyntaxError('Expected a comparison such as ==, >, =~ or contains', pos)
  pos += operator.length
  skipSpaces()
  if (pos >= text.length)
    throw new JsonPathSyntaxError('Expected a value after the comparison', pos)

  const value = readLiteral(operator)
  skipSpaces()
  if (pos < text.length) throw new JsonPathSyntaxError('Unexpected text after the value', pos)
  return { steps, operator, value }

  function skipSpaces(): void {
    while (pos < text.length && /\s/.test(text[pos])) pos++
  }

  function readName(): string {
    NAME.lastIndex = pos
    const found = NAME.exec(text)
    if (!found) throw new JsonPathSyntaxError('Expected a field name', pos)
    pos = NAME.lastIndex
    return found[0]
  }

  function readString(): string {
    const quote = text[pos]
    let out = ''
    let i = pos + 1
    for (; i < text.length; i++) {
      const c = text[i]
      if (c === '\\' && i + 1 < text.length) {
        out += text[++i]
      } else if (c === quote) {
        pos = i + 1
        return out
      } else {
        out += c
      }
    }
    throw new JsonPathSyntaxError('Unterminated string', pos)
  }

  function readLiteral(op: JsonPathOperator): JsonPathFilter['value'] {
    const c = text[pos]
    if (c === "'" || c === '"') {
      const s = readString()
      if (op === '=~') return compileRegex(s, '', pos)
      return s
    }
    if (c === '/') {
      const end = text.lastIndexOf('/')
      if (end <= pos) throw new JsonPathSyntaxError('Unterminated regular expression', pos)
      const flags = /^[a-z]*/.exec(text.slice(end + 1))?.[0] ?? ''
      const body = text.slice(pos + 1, end)
      const start = pos
      pos = end + 1 + flags.length
      if (op !== '=~')
        throw new JsonPathSyntaxError('A regular expression needs the =~ comparison', start)
      return compileRegex(body, flags, start)
    }
    const word = /[^\s]+/y
    word.lastIndex = pos
    const found = word.exec(text)
    const token = found ? found[0] : ''
    const start = pos
    pos = word.lastIndex
    if (op === '=~') return compileRegex(token, '', start)
    if (token === 'true') return true
    if (token === 'false') return false
    if (token === 'null') return null
    if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(token)) return Number(token)
    throw new JsonPathSyntaxError('Expected a number, a quoted string, true, false or null', start)
  }

  function compileRegex(body: string, flags: string, at: number): RegExp {
    try {
      return new RegExp(body, flags)
    } catch (err) {
      throw new JsonPathSyntaxError(`Invalid regular expression: ${(err as Error).message}`, at)
    }
  }
}

/**
 * A string as the parser above reads it: in double quotes, with only `\` and `"` escaped (the
 * parser takes a backslash to mean "the next character, as it is", so JSON escapes such as `\n`
 * would not come back as a newline).
 */
export function quoteJsonPath(text: string): string {
  return `"${text.replace(/[\\"]/g, '\\$&')}"`
}

/** A JSON primitive as a comparison value: `"text"`, `12.5`, `true`, `false` or `null`. */
export function jsonPathLiteral(value: string | number | boolean | null): string {
  return typeof value === 'string' ? quoteJsonPath(value) : String(value)
}

/** Returns every value the path selects. */
export function queryJsonPath(steps: Step[], doc: unknown): unknown[] {
  let current: unknown[] = [doc]
  for (const step of steps) {
    const next: unknown[] = []
    for (const value of current) {
      switch (step.kind) {
        case 'child':
          if (isObject(value) && step.name in value) next.push(value[step.name])
          break
        case 'index':
          if (Array.isArray(value)) {
            const i = step.index < 0 ? value.length + step.index : step.index
            if (i >= 0 && i < value.length) next.push(value[i])
          }
          break
        case 'wildcard':
          if (Array.isArray(value)) next.push(...value)
          else if (isObject(value)) next.push(...Object.values(value))
          break
        case 'descendant':
          collectDescendants(value, step.name, next)
          break
      }
    }
    current = next
    if (current.length === 0) break
  }
  return current
}

function collectDescendants(value: unknown, name: string | null, out: unknown[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (name === null) out.push(item)
      collectDescendants(item, name, out)
    }
  } else if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (name === null || key === name) out.push(item)
      collectDescendants(item, name, out)
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function matchesJsonPath(filter: JsonPathFilter, doc: unknown): boolean {
  const values = queryJsonPath(filter.steps, doc)
  if (!filter.operator) return values.some((v) => v !== null && v !== false && v !== undefined)
  return values.some((v) => compare(v, filter.operator!, filter.value))
}

function compare(
  actual: unknown,
  op: JsonPathOperator,
  expected: JsonPathFilter['value']
): boolean {
  switch (op) {
    case '==':
      return actual === expected
    case '!=':
      return actual !== expected
    case '=~':
      return typeof actual === 'string' && expected instanceof RegExp && expected.test(actual)
    case 'contains':
      if (typeof actual === 'string')
        return typeof expected === 'string' && actual.includes(expected)
      if (Array.isArray(actual)) return actual.includes(expected)
      return false
    default: {
      const comparable =
        (typeof actual === 'number' && typeof expected === 'number') ||
        (typeof actual === 'string' && typeof expected === 'string')
      if (!comparable) return false
      const a = actual as number | string
      const b = expected as number | string
      if (op === '>') return a > b
      if (op === '>=') return a >= b
      if (op === '<') return a < b
      return a <= b
    }
  }
}
