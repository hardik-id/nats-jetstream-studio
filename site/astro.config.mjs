// @ts-check
import { defineConfig } from 'astro/config'
import { site, base } from './site.config.mjs'

export default defineConfig({
  site,
  base,
  trailingSlash: 'always',
  build: { format: 'directory' },
  // Resolve TypeScript settings from this project only (never the app's tsconfig one level up).
  vite: { tsconfig: './tsconfig.json' }
})
