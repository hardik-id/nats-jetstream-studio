// Finds a nats-server binary: on PATH, in .tools/, or downloads the official release into .tools/.
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const NATS_VERSION = process.env.NATS_SERVER_VERSION ?? 'v2.15.3'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const toolsDir = join(root, '.tools')
const exe = process.platform === 'win32' ? 'nats-server.exe' : 'nats-server'

export async function ensureNatsServer() {
  if (process.env.NATS_SERVER_BIN && existsSync(process.env.NATS_SERVER_BIN))
    return process.env.NATS_SERVER_BIN
  const local = join(toolsDir, exe)
  if (existsSync(local)) return local
  const onPath = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['nats-server'], {
    encoding: 'utf8'
  })
  if (onPath.status === 0 && onPath.stdout.trim()) return onPath.stdout.trim().split('\n')[0]

  const os = { linux: 'linux', darwin: 'darwin', win32: 'windows' }[process.platform]
  const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch]
  if (!os || !arch)
    throw new Error(
      `No nats-server download for ${process.platform}/${process.arch}. Install it and set NATS_SERVER_BIN.`
    )
  const ext = os === 'windows' ? 'zip' : 'tar.gz'
  const name = `nats-server-${NATS_VERSION}-${os}-${arch}`
  const url = `https://github.com/nats-io/nats-server/releases/download/${NATS_VERSION}/${name}.${ext}`

  console.log(`Downloading ${url}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`)
  const work = join(toolsDir, 'download')
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  const archive = join(work, `nats-server.${ext}`)
  writeFileSync(archive, Buffer.from(await res.arrayBuffer()))
  // bsdtar (Windows 10+, macOS) and GNU tar both understand this; bsdtar also reads zip files.
  execFileSync('tar', ['-xf', archive, '-C', work])
  const extracted = readdirSync(work, { recursive: true }).find((f) => String(f).endsWith(exe))
  if (!extracted) throw new Error('nats-server binary not found in the downloaded archive')
  renameSync(join(work, String(extracted)), local)
  chmodSync(local, 0o755)
  rmSync(work, { recursive: true, force: true })
  return local
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(await ensureNatsServer())
}
