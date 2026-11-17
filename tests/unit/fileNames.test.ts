import { readdirSync, statSync } from 'node:fs'
import { extname, join, parse } from 'node:path'
import { describe, expect, it } from 'vitest'

// Windows and macOS file systems ignore case, so `./SubjectTree` can resolve to `subjectTree.ts`
// instead of `SubjectTree.tsx` there. Script module names in one folder must differ by more than
// case or extension (a stylesheet next to a module of the same name is fine).
const MODULES = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'])

function collisions(dir: string, found: string[] = []): string[] {
  const seen = new Map<string, string>()
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      collisions(full, found)
      continue
    }
    if (!MODULES.has(extname(entry))) continue
    const key = parse(entry).name.toLowerCase()
    const other = seen.get(key)
    if (other && other !== entry) found.push(`${join(dir, other)} and ${entry}`)
    else seen.set(key, entry)
  }
  return found
}

describe('source file names', () => {
  it('never differ only by case or extension in one folder (modules)', () => {
    expect(collisions('src')).toEqual([])
  })
})
