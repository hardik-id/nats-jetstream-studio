// Accessibility checks in a real browser, every page, light and dark, desktop and phone width:
// axe-core (WCAG 2 A/AA incl. colour contrast 4.5:1) plus a keyboard walk (Tab through the page: every
// stop must show a visible focus indicator, nothing may be a trap, the skip link must be first).
// Needs a built dist/ and a Chromium (Playwright's, or CHROME_PATH).
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import AxeBuilder from '@axe-core/playwright'
import { base } from '../site.config.mjs'
import { dist, startServer } from './serve.mjs'

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const f = path.join(dir, e.name)
    return e.isDirectory() ? walk(f) : [f]
  })
}
const pages = walk(dist)
  .filter((f) => f.endsWith('.html'))
  .map((f) => base + path.relative(dist, f).replace(/index\.html$/, ''))
  .sort()

const { server, origin } = await startServer()
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined })
const problems = []
let runs = 0

for (const theme of ['light', 'dark'])
  for (const [label, size] of [
    ['desktop', { width: 1280, height: 800 }],
    ['phone', { width: 390, height: 844 }]
  ]) {
    const context = await browser.newContext({
      viewport: size,
      colorScheme: theme,
      reducedMotion: 'reduce'
    })
    await context.addInitScript((t) => localStorage.setItem('theme', t), theme)
    for (const p of pages) {
      const page = await context.newPage()
      await page.goto(origin + p, { waitUntil: 'networkidle' })
      const where = `${p} [${theme}, ${label}]`
      runs++
      const theme_ = await page.evaluate(() => document.documentElement.dataset.theme)
      if (theme_ !== theme) problems.push(`${where}: theme is ${theme_}`)

      const axe = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
        .analyze()
      for (const v of axe.violations)
        problems.push(
          `${where}: axe ${v.id} (${v.impact}): ${v.nodes
            .slice(0, 3)
            .map((n) => n.target.join(' '))
            .join(' | ')}`
        )

      // Keyboard walk: the first stop is the skip link; every stop must be visible and show focus.
      const stops = []
      const seen = new Set()
      for (let i = 0; i < 400; i++) {
        await page.keyboard.press('Tab')
        const info = await page.evaluate(() => {
          const el = document.activeElement
          if (!el || el === document.body) return null
          const r = el.getBoundingClientRect()
          const cs = getComputedStyle(el)
          const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0
          const shadow = cs.boxShadow !== 'none'
          const key =
            el.tagName +
            '|' +
            (el.getAttribute('href') || el.id || el.textContent.trim().slice(0, 30))
          return {
            key,
            visible: r.width > 0 && r.height > 0,
            focusStyle: outline || shadow,
            label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40)
          }
        })
        if (!info) break
        if (seen.has(info.key)) break
        seen.add(info.key)
        stops.push(info)
        if (!info.visible) problems.push(`${where}: focus lands on a hidden element: ${info.key}`)
        if (!info.focusStyle) problems.push(`${where}: no visible focus style on ${info.key}`)
      }
      if (stops.length === 0) problems.push(`${where}: Tab reaches nothing`)
      else if (!/skip/i.test(stops[0].label))
        problems.push(`${where}: first Tab stop is "${stops[0].label}", not the skip link`)
      await page.close()
    }
    await context.close()
  }

await browser.close()
server.close()
console.log(
  `Ran axe and the keyboard walk on ${pages.length} pages x light/dark x desktop/phone (${runs} runs).`
)
if (problems.length) {
  const uniq = [...new Set(problems)]
  console.error(`\n${uniq.length} problem(s):\n` + uniq.map((p) => '  - ' + p).join('\n'))
  process.exit(1)
}
console.log('OK: no axe violations, no contrast failures, keyboard walk clean.')
