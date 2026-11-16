import rss from '@astrojs/rss'
import type { APIContext } from 'astro'
import { getReleases } from '../../lib/releases'
import { absoluteUrl } from '../../lib/url'

export async function GET(context: APIContext) {
  const { releases } = await getReleases()
  return rss({
    title: 'NATS JetStream Studio releases',
    description: 'New versions of NATS JetStream Studio.',
    site: context.site!,
    customData: `<link>${absoluteUrl('/changelog/')}</link>`,
    items: releases.map((r) => ({
      title: `Version ${r.version}`,
      pubDate: new Date(r.date),
      link: absoluteUrl(`/changelog/#v${r.version}`),
      description: r.notesText || `Version ${r.version} is out.`,
      content: r.notesHtml
    }))
  })
}
