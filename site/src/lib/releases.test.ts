// Run with: node --test src/lib/releases.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderNotes, plainText } from './releases.ts'

// An injected attribute would show up as an on* handler outside the quoted values of a tag.
const hasInjectedAttr = (html: string) =>
  (html.match(/<[^>]*>/g) ?? []).some((tag) => /\son\w+\s*=/i.test(tag.replace(/"[^"]*"/g, '""')))

test('quote breakouts are neutralised', () => {
  for (const md of [
    '[a](https://x"onmouseover="alert(1))',
    `[a](https://x 'a" onmouseover="alert(1)')`,
    'https://x.com/"onmouseover="alert(1)',
    '[a](https://x \'b\' "c")'
  ]) {
    assert.equal(hasInjectedAttr(renderNotes(md)), false, md)
  }
})

test('javascript links, raw html and images are neutralised', () => {
  assert.ok(!/href="javascript/i.test(renderNotes('[a](javascript:alert(1))')))
  assert.ok(!renderNotes('<script>alert(1)</script>').includes('<script'))
  assert.ok(!renderNotes('![x](https://x/y.png)').includes('<img'))
})

test('entities in links are escaped once, and plain text has no Markdown', () => {
  assert.match(renderNotes('[a](https://x.com/?a=1&b=2)'), /href="https:\/\/x\.com\/\?a=1&amp;b=2"/)
  assert.equal(plainText('## Title\n\n**bold** and [a link](https://x.com) &amp; more'), 'Title bold and a link & more')
})

test('headings move below h2', () => {
  assert.match(renderNotes('# One\n\n## Two'), /<h3>One<\/h3>[\s\S]*<h4>Two<\/h4>/)
})
