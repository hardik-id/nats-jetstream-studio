import type { TestProject } from 'vitest/node'
import { startNatsServer, type TestServer } from './natsServer'

let server: TestServer | undefined

/** One shared nats-server for the core test project. Tests that need special config start their own. */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  server = await startNatsServer()
  project.provide('natsUrl', server.url)
  return async () => {
    await server?.stop()
  }
}

declare module 'vitest' {
  export interface ProvidedContext {
    natsUrl: string
  }
}
