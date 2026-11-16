// @ts-check
import { defineConfig } from 'astro/config'
import sitemap from '@astrojs/sitemap'
import { site, base } from './site.config.mjs'

export default defineConfig({
  site,
  base,
  integrations: [sitemap({ filter: (page) => !page.endsWith('/404/') })],
  markdown: {
    // Both themes are emitted as CSS variables; global.css picks one by the page theme.
    shikiConfig: { themes: { light: 'github-light', dark: 'github-dark' }, defaultColor: false }
  },
  trailingSlash: 'always',
  build: { format: 'directory' },
  // Resolve TypeScript settings from this project only (never the app's tsconfig one level up).
  vite: { tsconfig: './tsconfig.json' }
})
