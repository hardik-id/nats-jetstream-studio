import { defineConfig } from '@playwright/test'

/**
 * End-to-end tests drive the real UI against a real nats-server.
 *   web       the UI in Chromium, served by the web-mode server (most flows)
 *   electron  the packaged desktop entry point, to prove the shell, preload and IPC work
 * Run "npm run test:e2e"; it builds both targets first.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [
    { name: 'web', testMatch: /web\/.*\.spec\.ts/ },
    { name: 'electron', testMatch: /electron\.spec\.ts/ }
  ]
})
