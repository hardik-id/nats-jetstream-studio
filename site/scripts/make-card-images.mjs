// Small copies of the feature screenshots for the cards on the Features page. The full-size
// pictures (up to 130 KB each) would compete with the first card for bandwidth on a slow phone.
// Runs before dev and build; the output (public/media/cards/) is not committed.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

export const CARD_WIDTH = 640
const media = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/media')
const out = path.join(media, 'cards')
fs.mkdirSync(out, { recursive: true })

for (const f of fs.readdirSync(media).filter((f) => /^features-.*\.webp$/.test(f))) {
  const dest = path.join(out, f)
  if (fs.existsSync(dest) && fs.statSync(dest).mtimeMs >= fs.statSync(path.join(media, f)).mtimeMs)
    continue
  await sharp(path.join(media, f)).resize({ width: CARD_WIDTH }).webp({ quality: 72 }).toFile(dest)
}
