import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { cspPlugin } from './csp'

const alias = {
  '@shared': resolve('src/shared'),
  '@core': resolve('src/core'),
  '@renderer': resolve('src/renderer/src')
}

export default defineConfig({
  main: {
    resolve: { alias }
  },
  preload: {
    resolve: { alias },
    // The preload script runs in a sandboxed renderer, so it must be one self-contained file.
    build: { externalizeDeps: false }
  },
  renderer: {
    resolve: { alias },
    plugins: [react(), tailwindcss(), cspPlugin()]
  }
})
