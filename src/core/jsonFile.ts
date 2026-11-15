import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** A small JSON document on disk, written atomically. */
export class JsonFile<T> {
  private cache: T | undefined

  constructor(
    private readonly path: string,
    private readonly defaults: () => T
  ) {}

  read(): T {
    if (this.cache !== undefined) return this.cache
    if (!existsSync(this.path)) {
      this.cache = this.defaults()
      return this.cache
    }
    try {
      this.cache = { ...this.defaults(), ...JSON.parse(readFileSync(this.path, 'utf8')) }
    } catch {
      // A corrupt file should not stop the app; keep it for inspection and start fresh.
      try {
        renameSync(this.path, `${this.path}.corrupt-${Date.now()}`)
      } catch {
        // ignore
      }
      this.cache = this.defaults()
    }
    return this.cache!
  }

  write(value: T): void {
    this.cache = value
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
    renameSync(tmp, this.path)
  }

  update(fn: (value: T) => void): T {
    const value = this.read()
    fn(value)
    this.write(value)
    return value
  }
}
