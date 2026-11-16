// Negative tests for check-built.mjs: injects one violation at a time into a copy of dist/ and
// requires the check to fail with the expected message. `npm run check:built:negative`.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cases = [
  [
    'remote script',
    '<script src="https://cdn.example.com/a.js"></script>',
    /external script\[src\]/
  ],
  [
    'remote stylesheet',
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css">',
    /external/
  ],
  ['remote image', '<img src="https://example.com/a.png" alt="">', /external img/],
  [
    'remote srcset',
    '<img src="/nats-jetstream-studio/favicon.svg" alt="" srcset="https://example.com/a.png 2x">',
    /external srcset/
  ],
  [
    'style attribute url()',
    '<div style="background:url(https://example.com/a.png)"></div>',
    /style attribute/
  ],
  ['inline script origin', '<script>fetch("https://api.example.com/x")</script>', /inline script/],
  [
    'preconnect',
    '<link rel="preconnect" href="https://fonts.gstatic.com">',
    /external link rel=preconnect/
  ],
  [
    'dns-prefetch',
    '<link rel="dns-prefetch" href="//stats.example.com">',
    /external link rel=dns-prefetch/
  ],
  [
    'modulepreload',
    '<link rel="modulepreload" href="https://cdn.example.com/m.js">',
    /external link rel=modulepreload/
  ],
  [
    'meta refresh',
    '<meta http-equiv="refresh" content="0; url=https://example.com/">',
    /meta refresh/
  ],
  ['broken link', '<a href="/nats-jetstream-studio/nope/">x</a>', /broken link/],
  ['missing anchor', '<a href="/nats-jetstream-studio/docs/faq/#zzz">x</a>', /missing anchor/],
  ['img without alt', '<img src="/nats-jetstream-studio/favicon.svg">', /img without alt/],
  ['second h1', '<h1>Again</h1>', /h1 elements/]
]
const jsonLdCases = [
  ['price not 0', (j) => (j.offers.price = '10'), /offers\.price/],
  ['no license', (j) => delete j.license, /no license/],
  ['no downloadUrl', (j) => delete j.downloadUrl, /no downloadUrl/],
  [
    'downloadUrl does not resolve',
    (j) => (j.downloadUrl = j.downloadUrl + 'missing/'),
    /downloadUrl does not resolve/
  ]
]

const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'site-neg-'))
fs.cpSync(root, copy, {
  recursive: true,
  filter: (s) => !/node_modules|\.lighthouseci|[\\/]src$/.test(s)
})
fs.symlinkSync(path.join(root, 'node_modules'), path.join(copy, 'node_modules'))
const index = path.join(copy, 'dist/index.html')
const original = fs.readFileSync(index, 'utf8')

function run() {
  return spawnSync('node', ['scripts/check-built.mjs'], { cwd: copy, encoding: 'utf8' })
}
let failed = 0
function expect(name, html, pattern) {
  fs.writeFileSync(index, html)
  const r = run()
  const ok = r.status === 1 && pattern.test(r.stderr)
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`)
}
for (const [name, snippet, pattern] of cases)
  expect(name, original.replace('</main>', snippet + '</main>'), pattern)
for (const [name, mutate, pattern] of jsonLdCases) {
  const html = original.replace(
    /(<script type="application\/ld\+json">)(.*?)(<\/script>)/,
    (m, a, body, c) => {
      const j = JSON.parse(body)
      if (j['@type'] !== 'SoftwareApplication') return m
      mutate(j)
      return a + JSON.stringify(j) + c
    }
  )
  expect(name, html, pattern)
}
fs.writeFileSync(index, original)
const clean = run()
console.log(`${clean.status === 0 ? 'ok  ' : 'FAIL'} unmodified build passes`)
if (clean.status !== 0) failed++
fs.rmSync(copy, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
