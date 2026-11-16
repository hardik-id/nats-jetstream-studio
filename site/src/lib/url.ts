import { base, site, repo } from '../../site.config.mjs'

export { repo }

const b = base.endsWith('/') ? base : base + '/'

/** Prefix a site path ('/features/', '/favicon.svg') with the base path. Use for every internal link and asset. */
export function url(path: string): string {
  return b + path.replace(/^\/+/, '')
}

/** Absolute address of a site path, for canonical links and structured data. */
export function absoluteUrl(path: string): string {
  return new URL(url(path), site).href
}

/** The current request path without the base, always starting and ending with a slash. */
export function pathWithoutBase(pathname: string): string {
  let p = pathname.startsWith(b) ? '/' + pathname.slice(b.length) : pathname
  if (!p.endsWith('/')) p += '/'
  return p
}
