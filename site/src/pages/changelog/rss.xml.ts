import rss from '@astrojs/rss'
import type { APIContext } from 'astro'
import { getReleases } from '../../lib/releases'

export async function GET(context: APIContext) {
  const { releases } = await getReleases()
  return rss({
    title: 'NATS JetStream Studio releases',
    description: 'New versions of NATS JetStream Studio.',
    site: context.site!,
    items: releases.map((r) => ({
      title: `Version ${r.version}`,
      pubDate: new Date(r.date),
      link: r.url,
      description: r.notesText || `Version ${r.version} is out.`,
      content: r.notesHtml
    }))
  })
}
