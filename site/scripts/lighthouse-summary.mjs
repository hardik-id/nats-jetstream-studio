// Prints the scores of every Lighthouse run in .lighthouseci (performance / accessibility /
// best practices / SEO) so the CI log shows the margin, not only pass or fail.
import fs from 'node:fs'

const dir = new URL('../.lighthouseci/', import.meta.url)
const by = {}
for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
  if (!/^lhr.*\.json$/.test(f)) continue
  const r = JSON.parse(fs.readFileSync(new URL(f, dir), 'utf8'))
  const scores = ['performance', 'accessibility', 'best-practices', 'seo'].map((k) =>
    Math.round(r.categories[k].score * 100)
  )
  ;(by[new URL(r.finalUrl).pathname] ??= []).push(scores.join('/'))
}
console.log('Lighthouse scores (performance/accessibility/best-practices/seo), one per run:')
for (const [u, s] of Object.entries(by)) console.log(`  ${u}  ${s.join('  ')}`)
