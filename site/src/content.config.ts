import { defineCollection } from 'astro:content'
import { z } from 'astro/zod'
import { docsLoader } from './components/docs/loader'

const docs = defineCollection({
  loader: docsLoader(),
  schema: z.object({ slug: z.string(), file: z.string() })
})

export const collections = { docs }
