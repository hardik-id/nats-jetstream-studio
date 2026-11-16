// Lighthouse CI: mobile settings (the default preset), every score must be at least 0.95.
// The built site is served by scripts/serve.mjs under the real base path.
// Read the base path from the one place that defines it.
const base = require('node:fs')
  .readFileSync(`${__dirname}/site.config.mjs`, 'utf8')
  .match(/base = '([^']+)'/)[1]
  .replace(/\/$/, '')
const port = 4321

module.exports = {
  ci: {
    collect: {
      startServerCommand: `node scripts/serve.mjs ${port}`,
      startServerReadyPattern: 'Serving',
      url: [
        `http://127.0.0.1:${port}${base}/`,
        `http://127.0.0.1:${port}${base}/features/`,
        `http://127.0.0.1:${port}${base}/features/streams/`,
        `http://127.0.0.1:${port}${base}/download/`,
        `http://127.0.0.1:${port}${base}/docs/getting-started/`
      ],
      numberOfRuns: 3,
      settings: { chromeFlags: '--no-sandbox --headless=new' }
    },
    assert: {
      assertions: {
        'categories:performance': ['error', { minScore: 0.95, aggregationMethod: 'median-run' }],
        'categories:accessibility': ['error', { minScore: 0.95, aggregationMethod: 'median-run' }],
        'categories:best-practices': ['error', { minScore: 0.95, aggregationMethod: 'median-run' }],
        'categories:seo': ['error', { minScore: 0.95, aggregationMethod: 'median-run' }]
      }
    },
    upload: { target: 'filesystem', outputDir: '.lighthouseci' }
  }
}
