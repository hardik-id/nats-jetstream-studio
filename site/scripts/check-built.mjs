// Static checks over the built HTML in dist/: no third-party origins, internal links and #anchors
// resolve (honouring the base path), one h1 per page, ordered headings, alt text, unique title and
// description, canonical URL, social tags and structured data. Exits 1 on any problem.
import fs from 'node:fs'
import path from 'node:path'
import { parse } from 'node-html-parser'
import { site, base } from '../site.config.mjs'
import { dist } from './serve.mjs'

const problems = []
const fail = (page, msg) => problems.push(`${page}: ${msg}`)
const own = new URL(site).origin

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const f = path.join(dir, e.name)
    return e.isDirectory() ? walk(f) : [f]
  })
}
const htmlFiles = walk(dist).filter((f) => f.endsWith('.html'))
const pageOf = (f) =>
  base +
  path
    .relative(dist, f)
    .replace(/index\.html$/, '')
    .replace(/\\/g, '/')

const docs = new Map(htmlFiles.map((f) => [pageOf(f), parse(fs.readFileSync(f, 'utf8'))]))
const ids = new Map(
  [...docs].map(([p, d]) => [p, new Set(d.querySelectorAll('[id]').map((e) => e.id))])
)

function exists(p) {
  const f = path.join(dist, p.slice(base.length - 1))
  return (
    fs.existsSync(f) && (!fs.statSync(f).isDirectory() || fs.existsSync(path.join(f, 'index.html')))
  )
}

const loaders = [
  ['script[src]', 'src'],
  ['link[rel~=stylesheet]', 'href'],
  ['link[rel~=preload]', 'href'],
  ['link[rel~=icon]', 'href'],
  ['img[src]', 'src'],
  ['source[src]', 'src'],
  ['video[src]', 'src'],
  ['video[poster]', 'poster'],
  ['iframe[src]', 'src'],
  ['audio[src]', 'src'],
  ['embed[src]', 'src'],
  ['object[data]', 'data']
]

const titles = new Map()
const descriptions = new Map()
let linkCount = 0

for (const [page, doc] of docs) {
  const is404 = page.endsWith('/404.html')

  // Third-party resources: anything that loads must be same-origin or relative.
  for (const [sel, attr] of loaders)
    for (const el of doc.querySelectorAll(sel)) {
      const v = el.getAttribute(attr)
      if (/^(https?:)?\/\//i.test(v) && new URL(v, site).origin !== own)
        fail(page, `external ${sel}: ${v}`)
      if (v && !/^(https?:)?\/\//i.test(v) && !v.startsWith('data:')) {
        const u = new URL(v, `http://local${page}`)
        if (!u.pathname.startsWith(base) || !exists(u.pathname)) fail(page, `broken asset ${v}`)
      }
    }
  for (const s of doc.querySelectorAll('style'))
    if (/@import|url\(\s*['"]?https?:/i.test(s.text)) fail(page, 'external url() in inline style')

  // Links
  for (const a of doc.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href')
    if (/^(mailto:|tel:|javascript:)/i.test(href)) continue
    const u = new URL(href, `http://local${page}`)
    if (u.origin !== 'http://local') continue // external links are not fetched
    linkCount++
    if (!u.pathname.startsWith(base)) {
      fail(page, `internal link outside base path: ${href}`)
      continue
    }
    if (!exists(u.pathname)) {
      fail(page, `broken link ${href}`)
      continue
    }
    if (u.hash.length > 1) {
      const key = u.pathname.endsWith('/') ? u.pathname : u.pathname
      if (!ids.get(key)?.has(decodeURIComponent(u.hash.slice(1))))
        fail(page, `missing anchor ${href}`)
    }
  }

  // Structure
  const h1 = doc.querySelectorAll('h1')
  if (h1.length !== 1) fail(page, `${h1.length} h1 elements`)
  let last = 0
  for (const h of doc.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
    const n = Number(h.tagName[1])
    if (last && n > last + 1)
      fail(page, `heading jumps from h${last} to h${n} ("${h.text.trim().slice(0, 40)}")`)
    last = n
  }
  for (const img of doc.querySelectorAll('img'))
    if (img.getAttribute('alt') === undefined)
      fail(page, `img without alt: ${img.getAttribute('src')}`)
  if (!doc.querySelector('html[lang]')) fail(page, 'no html lang')

  // Metadata (404 is noindex and has no canonical)
  const title = doc.querySelector('title')?.text.trim()
  const desc = doc.querySelector('meta[name=description]')?.getAttribute('content')
  if (!title) fail(page, 'no title')
  if (!desc) fail(page, 'no description')
  if (is404) continue
  if (titles.has(title)) fail(page, `title also used by ${titles.get(title)}`)
  if (descriptions.has(desc)) fail(page, `description also used by ${descriptions.get(desc)}`)
  titles.set(title, page)
  descriptions.set(desc, page)
  const canonical = doc.querySelector('link[rel=canonical]')?.getAttribute('href')
  if (canonical !== new URL(page, site).href) fail(page, `canonical is ${canonical}`)
  for (const [attr, name] of [
    ['property', 'og:title'],
    ['property', 'og:description'],
    ['property', 'og:image'],
    ['property', 'og:url'],
    ['name', 'twitter:card'],
    ['name', 'twitter:image']
  ]) {
    const c = doc.querySelector(`meta[${attr}="${name}"]`)?.getAttribute('content')
    if (!c) fail(page, `no ${name}`)
    else if (name.endsWith('image') && !c.startsWith(`${site}${base}`))
      fail(page, `${name} is not absolute: ${c}`)
  }
  const ld = doc
    .querySelectorAll('script[type="application/ld+json"]')
    .map((s) => JSON.parse(s.text))
  const want = page === base ? 'SoftwareApplication' : 'BreadcrumbList'
  if (!ld.some((x) => x['@type'] === want)) fail(page, `no ${want} structured data`)
  const bc = ld.find((x) => x['@type'] === 'BreadcrumbList')
  if (bc) {
    const visible = doc.querySelectorAll('nav[aria-label=Breadcrumb] li').map((l) => l.text.trim())
    const data = bc.itemListElement.map((i) => i.name)
    if (JSON.stringify(visible) !== JSON.stringify(data))
      fail(page, `breadcrumbs differ: ${visible} vs ${data}`)
  }
}

// CSS: no remote @import, url() or fonts
for (const f of walk(dist).filter((f) => f.endsWith('.css'))) {
  const css = fs.readFileSync(f, 'utf8')
  for (const m of css.matchAll(/(?:@import\s+(?:url\()?|url\()\s*['"]?(?:https?:)?\/\/[^)'"\s]+/g))
    fail(path.relative(dist, f), `external ${m[0]}`)
}
// JS: no remote origin strings other than known harmless ones
for (const f of walk(dist).filter((f) => f.endsWith('.js'))) {
  const js = fs.readFileSync(f, 'utf8')
  for (const m of js.matchAll(/https?:\/\/[a-z0-9.-]+/gi))
    if (!/w3\.org|hardik-id\.github\.io/.test(m[0]))
      fail(path.relative(dist, f), `remote origin in script: ${m[0]}`)
}

for (const f of ['robots.txt', 'sitemap-index.xml', 'sitemap-0.xml', 'social-preview.png'])
  if (!fs.existsSync(path.join(dist, f))) problems.push(`dist/${f} is missing`)
const sm = fs.readFileSync(path.join(dist, 'sitemap-0.xml'), 'utf8')
for (const p of docs.keys())
  if (!p.endsWith('404.html') && !sm.includes(`<loc>${new URL(p, site).href}</loc>`))
    problems.push(`sitemap lacks ${p}`)

console.log(`Checked ${docs.size} pages, ${linkCount} internal links.`)
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n` + problems.map((p) => '  - ' + p).join('\n'))
  process.exit(1)
}
console.log('OK: no external origins, no broken links or anchors, structure and metadata correct.')
