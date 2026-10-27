// The App Store listing in ios-app/store/ is pasted into App Store Connect by
// hand; a field over Apple's limit is refused there, after the work is done.
// This checks every limited field here first (CI runs it in ios.yml).
// Limits: name and subtitle 30, promotional text 170, keywords 100,
// description 4000 characters.
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(`../store/${p}`, import.meta.url), 'utf8')
const listing = read('listing.md')

/** The backticked value on the line whose bold lead-in starts with `label`. */
function field(label) {
  const line = listing.split('\n').find((l) => l.startsWith(`- **${label}`))
  const m = line?.match(/`([^`]+)`/)
  if (!m) throw new Error(`listing.md: no value for ${label}`)
  return m[1]
}
// Keywords sit on the line after their label.
function keywords() {
  const lines = listing.split('\n')
  const i = lines.findIndex((l) => l.startsWith('- **Keywords'))
  const m = lines.slice(i, i + 3).join(' ').match(/`([^`]+)`/)
  if (!m) throw new Error('listing.md: no keywords')
  return m[1]
}

const fields = [
  ['name', field('Name'), 30],
  ['subtitle', field('Subtitle'), 30],
  ['keywords', keywords(), 100],
  ['promotional text', read('promotional-text.txt').trim(), 170],
  ['description', read('description.txt').trim(), 4000],
]

let bad = 0
for (const [name, value, max] of fields) {
  const n = [...value].length
  const ok = n <= max
  if (!ok) bad++
  console.log(`${ok ? 'ok  ' : 'LONG'} ${name}: ${n}/${max}`)
}
if (bad) process.exit(1)
