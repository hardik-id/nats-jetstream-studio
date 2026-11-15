import type { Plugin } from 'vite'

const POLICY = (scripts: string): string =>
  `default-src 'self'; script-src ${scripts}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'`

/**
 * Adds the Content-Security-Policy tag to index.html.
 * Built pages only run scripts from the app itself. The development server needs one inline
 * script for hot reload, so inline scripts are allowed there and nowhere else.
 */
export function cspPlugin(): Plugin {
  let dev = false
  return {
    name: 'studio-csp',
    configResolved(config) {
      dev = config.command === 'serve'
    },
    transformIndexHtml(html) {
      const policy = POLICY(dev ? "'self' 'unsafe-inline'" : "'self'")
      return html.replace(
        '%STUDIO_CSP%',
        `<meta http-equiv="Content-Security-Policy" content="${policy}" />`
      )
    }
  }
}
