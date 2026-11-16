// Reads the published GitHub releases once per build. It never throws: on any failure it returns
// `ok: false` and the pages link to the releases page instead.
import { Marked, type RendererObject } from 'marked'
import { repo } from '../../site.config.mjs'

export const releasesPageUrl = `${repo}/releases`
const apiUrl = repo.replace('https://github.com/', 'https://api.github.com/repos/') + '/releases?per_page=100'

export interface ReleaseAsset {
  name: string
  size: number
  url: string
}

export interface Release {
  version: string
  tag: string
  /** ISO date */
  date: string
  url: string
  /** Release notes as HTML (raw HTML in the Markdown is escaped, not passed through). */
  notesHtml: string
  notesText: string
  assets: ReleaseAsset[]
}

export interface ReleasesResult {
  ok: boolean
  releases: Release[]
}

const esc = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

/**
 * Markdown from this repo's releases, treated as untrusted: raw HTML is escaped, images become
 * their alt text, only http(s) and mailto links are kept, attribute values are fully escaped and
 * headings are moved down two levels so they sit under the entry's h2.
 */
export function renderNotes(md: string): string {
  const renderer: RendererObject = {
    html: ({ text }) => esc(text),
    heading({ tokens, depth }) {
      const level = Math.min(depth + 2, 6)
      return `<h${level}>${this.parser.parseInline(tokens)}</h${level}>\n`
    },
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens)
      if (!/^(https?:|mailto:)/i.test(href.trim())) return text
      const t = title ? ` title="${esc(title)}"` : ''
      return `<a href="${esc(href.trim())}"${t} rel="noopener">${text}</a>`
    },
    image: ({ text }) => esc(text)
  }
  const m = new Marked({ gfm: true, renderer })
  return m.parse(md, { async: false }) as string
}

let cache: Promise<ReleasesResult> | undefined

async function load(): Promise<ReleasesResult> {
  try {
    if (process.env.RELEASES_FORCE_FAIL) throw new Error('forced failure')
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'nats-jetstream-studio-site-build'
    }
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
    const res = await fetch(apiUrl, { headers, signal: AbortSignal.timeout(15000) })
    if (!res.ok) throw new Error(`GitHub API answered ${res.status}`)
    const data = (await res.json()) as any[]
    const releases: Release[] = data
      .filter((r) => !r.draft && !r.prerelease)
      .map((r) => {
        const body = String(r.body ?? '')
        return {
          version: String(r.tag_name).replace(/^v/, ''),
          tag: String(r.tag_name),
          date: String(r.published_at ?? r.created_at),
          url: String(r.html_url),
          notesHtml: renderNotes(body),
          notesText: body.replace(/\s+/g, ' ').trim(),
          assets: (r.assets ?? [])
            .filter((a: any) => !/\.(ya?ml|blockmap)$/i.test(a.name))
            .map((a: any) => ({ name: String(a.name), size: Number(a.size), url: String(a.browser_download_url) }))
        }
      })
      .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
    return { ok: true, releases }
  } catch (err) {
    console.warn(`[releases] Could not read releases, using the fallback: ${(err as Error).message}`)
    return { ok: false, releases: [] }
  }
}

/** Published releases (no drafts, no pre-releases), newest first. Fetched once per build. */
export function getReleases(): Promise<ReleasesResult> {
  return (cache ??= load())
}

export function formatSize(bytes: number): string {
  return `${Math.round(bytes / 1e6)} MB`
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
}
