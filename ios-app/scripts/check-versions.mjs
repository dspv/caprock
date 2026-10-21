// The Capacitor plugins live in two package.json files: ui/ imports their
// JavaScript (behind the iOS app check), ios-app/ builds their native code.
// A plugin whose two halves differ in version fails at run time on the phone,
// not at build time, so CI compares them here. Exact pins only.
import { readFileSync } from 'node:fs'

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'))
const ui = read('../../ui/package.json').dependencies
const ios = read('../package.json').dependencies

let bad = 0
for (const [name, v] of Object.entries(ui)) {
  if (!name.startsWith('@capacitor') && !name.startsWith('@capgo/') && !name.startsWith('@aparajita/')) continue
  if (!/^\d+\.\d+\.\d+$/.test(v)) {
    console.error(`ui/package.json: ${name} must be pinned exactly, not ${v}`)
    bad++
  }
  if (ios[name] !== v) {
    console.error(`${name}: ui/ has ${v}, ios-app/ has ${ios[name] ?? 'nothing'}`)
    bad++
  }
}
for (const [name, v] of Object.entries(ios)) {
  if (!/^\d+\.\d+\.\d+$/.test(v)) {
    console.error(`ios-app/package.json: ${name} must be pinned exactly, not ${v}`)
    bad++
  }
}
if (bad) process.exit(1)
console.log('Capacitor plugin versions agree between ui/ and ios-app/.')
