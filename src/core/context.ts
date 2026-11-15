import { AsyncLocalStorage } from 'node:async_hooks'

export interface RequestUser {
  name: string
  email?: string
}

const storage = new AsyncLocalStorage<{ user?: RequestUser }>()

/** Runs `fn` on behalf of a signed-in user (web mode), so audit entries can name who did it. */
export function runAs<T>(user: RequestUser | undefined, fn: () => T): T {
  return storage.run({ user }, fn)
}

export function currentUser(): RequestUser | undefined {
  return storage.getStore()?.user
}
