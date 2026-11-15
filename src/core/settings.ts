import { join } from 'node:path'
import { JsonFile } from './jsonFile'

/** Key-value settings shared by every window: saved filters, favourites, templates, thresholds. */
export class SettingsStore {
  private readonly file: JsonFile<Record<string, unknown>>

  constructor(dataDir: string) {
    this.file = new JsonFile<Record<string, unknown>>(join(dataDir, 'settings.json'), () => ({}))
  }

  get<T>(key: string): T | undefined {
    return this.file.read()[key] as T | undefined
  }

  set(key: string, value: unknown): void {
    this.file.update((data) => {
      if (value === null || value === undefined) delete data[key]
      else data[key] = value
    })
  }

  /** Removes every key that belongs to a deleted connection. */
  removeConnection(connId: string): void {
    this.file.update((data) => {
      for (const key of Object.keys(data)) {
        if (key.startsWith(`conn:${connId}:`)) delete data[key]
      }
    })
  }
}
