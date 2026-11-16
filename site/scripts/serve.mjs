// Serves dist/ under the site's base path, like GitHub Pages does: `node scripts/serve.mjs [port]`.
// The other checks import startServer().
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { base } from '../site.config.mjs'

export const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist')
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.mp4': 'video/mp4',
  '.xml': 'application/xml',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.woff2': 'font/woff2'
}

function notFound(res) {
  const f = path.join(dist, '404.html')
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(fs.existsSync(f) ? fs.readFileSync(f) : 'Not found')
}

export function startServer(port = 0) {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    if (!p.startsWith(base)) return notFound(res)
    p = p.slice(base.length - 1)
    let file = path.join(dist, p)
    if (!file.startsWith(dist)) return notFound(res)
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html')
    if (!fs.existsSync(file)) return notFound(res)
    const size = fs.statSync(file).size
    const type = types[path.extname(file)] ?? 'application/octet-stream'
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '')
    if (range) {
      const start = range[1] ? Number(range[1]) : 0
      const end = range[2] ? Number(range[2]) : size - 1
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes'
      })
      return fs.createReadStream(file, { start, end }).pipe(res)
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' })
    fs.createReadStream(file).pipe(res)
  })
  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () =>
      resolve({ server, origin: `http://127.0.0.1:${server.address().port}` })
    )
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { origin } = await startServer(Number(process.argv[2] ?? 4321))
  console.log(`Serving ${dist} at ${origin}${base}`)
}
