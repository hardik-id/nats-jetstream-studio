import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { cspPlugin } from './csp'

// Builds the same React UI for web/server mode (PBI-101). Output is served by src/server.
export default defineConfig({
  root: resolve('src/renderer'),
  base: './',
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@renderer': resolve('src/renderer/src')
    }
  },
  plugins: [react(), tailwindcss(), cspPlugin()],
  build: {
    outDir: resolve('dist/web'),
    emptyOutDir: true
  }
})
