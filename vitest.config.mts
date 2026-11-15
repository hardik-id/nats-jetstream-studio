import { resolve } from 'path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const alias = {
  '@shared': resolve('src/shared'),
  '@core': resolve('src/core'),
  '@renderer': resolve('src/renderer/src')
}

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: { name: 'unit', environment: 'node', include: ['tests/unit/**/*.test.ts'] }
      },
      {
        resolve: { alias },
        test: {
          name: 'core',
          environment: 'node',
          include: ['tests/core/**/*.test.ts'],
          globalSetup: ['tests/helpers/nats-global-setup.ts'],
          testTimeout: 30000,
          hookTimeout: 30000,
          fileParallelism: false
        }
      },
      {
        resolve: { alias },
        plugins: [react()],
        test: {
          name: 'ui',
          environment: 'jsdom',
          include: ['tests/ui/**/*.test.{ts,tsx}'],
          setupFiles: ['tests/ui/setup.ts'],
          testTimeout: 15000
        }
      }
    ]
  }
})
