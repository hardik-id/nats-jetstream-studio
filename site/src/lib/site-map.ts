// Single source of truth for the pages of the site. It drives the header, footer, breadcrumbs,
// docs sidebar and Previous/Next links. Paths are relative to the base and end with a slash.

export interface SitePage {
  path: string
  title: string
  /** Shorter label for breadcrumbs, nav and sidebars when the title is long. */
  label?: string
  description: string
}

export const home: SitePage = {
  path: '/',
  title: 'Home',
  description: 'A free GUI and desktop client for NATS and JetStream.'
}

export const features: SitePage = {
  path: '/features/',
  title: 'Features',
  description: 'Everything NATS JetStream Studio can do.'
}

export const featurePages: SitePage[] = [
  {
    path: '/features/connections/',
    title: 'Connections',
    description: 'Several servers, environments, CLI contexts and every auth type.'
  },
  {
    path: '/features/message-browser/',
    title: 'Message browser',
    description: 'Read stream messages without a consumer, filter and export.'
  },
  {
    path: '/features/streams/',
    title: 'Streams',
    description: 'List, create, edit, purge and export streams.'
  },
  {
    path: '/features/consumers/',
    title: 'Consumers',
    description: 'Lag, ack pending, redeliveries and health flags.'
  },
  {
    path: '/features/live-tail-and-publish/',
    title: 'Live tail and publish',
    description: 'Tail any subject, publish and request/reply.'
  },
  {
    path: '/features/kv-and-object-store/',
    title: 'KV and Object Store',
    description: 'Browse, watch, upload and download.'
  },
  {
    path: '/features/monitoring-and-alerts/',
    title: 'Monitoring and alerts',
    description: 'Charts, alert rules and cluster topology.'
  },
  {
    path: '/features/productivity/',
    title: 'Productivity',
    description: 'Command palette, favourites, saved filters and the audit log.'
  }
]

export const download: SitePage = {
  path: '/download/',
  title: 'Download',
  description: 'Installers for Windows, macOS and Linux.'
}

export const docs: SitePage = {
  path: '/docs/',
  title: 'Documentation',
  label: 'Docs',
  description: 'How to install, connect and use NATS JetStream Studio.'
}

export const docsPages: SitePage[] = [
  {
    path: '/docs/getting-started/',
    title: 'Getting started',
    description: 'Install, add the first connection, open a stream, read a message.'
  },
  { path: '/docs/install/', title: 'Install', description: 'Install the desktop app.' },
  {
    path: '/docs/connections/',
    title: 'Connecting',
    description: 'Auth types, TLS, JetStream domain, CLI contexts and read-only mode.'
  },
  {
    path: '/docs/web-mode/',
    title: 'Web mode',
    description: 'Run the studio in a browser with Docker.'
  },
  {
    path: '/docs/keyboard-shortcuts/',
    title: 'Keyboard shortcuts',
    description: 'Every shortcut in the app.'
  },
  {
    path: '/docs/security/',
    title: 'Security and privacy',
    description: 'Where secrets are stored and what leaves the machine.'
  },
  {
    path: '/docs/faq/',
    title: 'FAQ and troubleshooting',
    description: 'Connection errors, SmartScreen and Gatekeeper.'
  }
]

export const changelog: SitePage = {
  path: '/changelog/',
  title: 'Changelog',
  description: 'What changed in each release.'
}

/** Every page except 404, in site-map order. */
export const allPages: SitePage[] = [
  home,
  features,
  ...featurePages,
  download,
  docs,
  ...docsPages,
  changelog
]

/** Sequences that get Previous/Next links, in site-map order. */
export const sequences: SitePage[][] = [
  [features, ...featurePages],
  [docs, ...docsPages]
]

/** Header navigation. */
export const primaryNav: SitePage[] = [features, download, docs, changelog]

export function labelOf(page: SitePage): string {
  return page.label ?? page.title
}

export function findPage(path: string): SitePage | undefined {
  return allPages.find((p) => p.path === path)
}

/** Breadcrumb trail for a path: Home, then every parent that is a page, ending with the page. */
export function breadcrumbsFor(path: string): SitePage[] {
  if (path === '/') return [home]
  const trail: SitePage[] = [home]
  let acc = ''
  for (const part of path.split('/').filter(Boolean)) {
    acc += `/${part}`
    const page = findPage(`${acc}/`)
    if (page) trail.push(page)
  }
  return trail
}

export function prevNext(path: string): { prev?: SitePage; next?: SitePage } {
  for (const seq of sequences) {
    const i = seq.findIndex((p) => p.path === path)
    if (i >= 0) return { prev: seq[i - 1], next: seq[i + 1] }
  }
  return {}
}
