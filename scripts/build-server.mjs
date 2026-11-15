// Bundles the web-mode server (src/server) into one file: dist/server/index.cjs.
import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
await build({
  entryPoints: [join(root, 'src/server/index.ts')],
  outfile: join(root, 'dist/server/index.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  alias: { '@shared': join(root, 'src/shared'), '@core': join(root, 'src/core') },
  logLevel: 'info'
})
