// Content loader for the docs pages. Seven pages, one mechanism:
//   - install and web-mode are read from ../docs/ (the repository's own docs, no copies),
//   - the others are site/src/content/docs/*.md.
// Before rendering, the loader drops the leading "# Title" (the page shows the site-map title),
// rewrites links so none of them break on the site, and expands {{shot name}} into the dark and
// light screenshots listed in public/media/manifest.json.
import { readFileSync } from 'node:fs'
import { posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Loader } from 'astro/loaders'
import { repo } from '../../../site.config.mjs'
import { url } from '../../lib/url'

export interface DocSource {
  slug: string
  /** Path from the repository root. */
  file: string
}

export const docSources: DocSource[] = [
  { slug: 'getting-started', file: 'site/src/content/docs/getting-started.md' },
  { slug: 'install', file: 'docs/install.md' },
  { slug: 'connections', file: 'site/src/content/docs/connections.md' },
  { slug: 'web-mode', file: 'docs/web-mode.md' },
  { slug: 'keyboard-shortcuts', file: 'site/src/content/docs/keyboard-shortcuts.md' },
  { slug: 'security', file: 'site/src/content/docs/security.md' },
  { slug: 'faq', file: 'site/src/content/docs/faq.md' }
]

const bySourceFile = new Map(docSources.map((s) => [s.file, s.slug]))

/** Where a repository file lives on GitHub. */
export function githubBlob(file: string): string {
  return `${repo}/blob/main/${file}`
}

function rewriteLinks(markdown: string, file: string): string {
  return markdown.replace(/\]\(([^)\s]+)\)/g, (whole, target: string) => {
    if (/^([a-z][a-z0-9+.-]*:|#)/i.test(target)) return whole
    const [pathPart, hash] = target.split('#')
    const suffix = hash ? `#${hash}` : ''
    // Site paths written as /docs/... or /features/...
    if (pathPart.startsWith('/')) return `](${url(pathPart)}${suffix})`
    // Relative to the source file: resolve to a repository path.
    const repoPath = posix.normalize(posix.join(posix.dirname(file), pathPart))
    const slug = bySourceFile.get(repoPath)
    if (slug) return `](${url(`/docs/${slug}/`)}${suffix})`
    return `](${githubBlob(repoPath)}${suffix})`
  })
}

interface MediaFile {
  file: string
  group: string
  name: string
  theme: 'dark' | 'light'
  width: number
  height: number
  alt: string
}

const escapeAttr = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')

function expandShots(markdown: string, media: MediaFile[]): string {
  return markdown.replace(/^\{\{shot ([a-z0-9-]+)\}\}$/gm, (_, key: string) => {
    const imgs = (['dark', 'light'] as const).map((theme) => {
      const m = media.find((f) => `${f.group}-${f.name}` === key && f.theme === theme)
      if (!m) throw new Error(`Docs: no ${theme} screenshot "${key}" in media/manifest.json`)
      return `<img class="shot-${theme}" src="${url(`/media/${m.file}`)}" width="${m.width}" height="${m.height}" alt="${escapeAttr(m.alt)}" loading="lazy" decoding="async">`
    })
    return `<figure class="shot">${imgs.join('')}</figure>`
  })
}

export function docsLoader(): Loader {
  return {
    name: 'docs-loader',
    load: async ({ store, renderMarkdown, config, watcher, logger }) => {
      const siteRoot = fileURLToPath(config.root)
      const repoRoot = posix.join(siteRoot.replace(/\\/g, '/'), '..')
      const media = (
        JSON.parse(readFileSync(posix.join(siteRoot.replace(/\\/g, '/'), 'public/media/manifest.json'), 'utf8')) as {
          files: MediaFile[]
        }
      ).files

      const loadAll = async (): Promise<void> => {
        store.clear()
        for (const { slug, file } of docSources) {
          const raw = readFileSync(posix.join(repoRoot, file), 'utf8').replace(/\r\n/g, '\n')
          const body = expandShots(rewriteLinks(raw.replace(/^# .*\n+/, ''), file), media)
          store.set({
            id: slug,
            data: { slug, file },
            body,
            rendered: await renderMarkdown(body)
          })
        }
        logger.info(`Loaded ${docSources.length} docs pages`)
      }

      await loadAll()
      for (const { file } of docSources) watcher?.add(posix.join(repoRoot, file))
      watcher?.on('change', (changed) => {
        const p = changed.replace(/\\/g, '/')
        if (docSources.some((s) => p.endsWith(`/${s.file}`))) void loadAll()
      })
    }
  }
}
