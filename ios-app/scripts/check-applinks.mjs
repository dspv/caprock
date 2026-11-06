// The pairing link opens the app (ios-app/README.md § The pairing link opens
// the app) only while three files agree: the app's entitlement names
// m.caprock.dev, the association file m.caprock.dev serves names this app's
// team and bundle id, and that file reached the remote build. CI runs this
// after `vite build --mode remote`.
import { existsSync, readFileSync } from 'node:fs'

const at = (p) => new URL(p, import.meta.url)
const read = (p) => readFileSync(at(p), 'utf8')

let bad = 0
const fail = (m) => { console.error(m); bad++ }

const pbx = read('../ios/App/App.xcodeproj/project.pbxproj')
const teams = new Set([...pbx.matchAll(/DEVELOPMENT_TEAM = (\w+);/g)].map((m) => m[1]))
const ids = new Set([...pbx.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([\w.]+);/g)].map((m) => m[1]))
if (teams.size !== 1 || ids.size !== 1) fail(`project.pbxproj: expected one team and one bundle id, got ${[...teams]} / ${[...ids]}`)
const appID = `${[...teams][0]}.${[...ids][0]}`

const ents = [...pbx.matchAll(/CODE_SIGN_ENTITLEMENTS = ([\w/.]+);/g)].map((m) => m[1])
if (ents.length !== 2 || ents.some((e) => e !== 'App/App.entitlements')) fail(`project.pbxproj: both configurations need CODE_SIGN_ENTITLEMENTS = App/App.entitlements, got ${ents}`)
if (!read('../ios/App/App/App.entitlements').includes('<string>applinks:m.caprock.dev</string>')) fail('App.entitlements: applinks:m.caprock.dev is missing')

function checkAASA(path, where) {
  if (!existsSync(at(path))) return fail(`${where}: missing`)
  let j
  try {
    j = JSON.parse(read(path))
  } catch (e) {
    return fail(`${where}: not JSON (${e.message})`)
  }
  const d = j?.applinks?.details ?? []
  if (!d.some((x) => (x.appIDs ?? []).includes(appID))) fail(`${where}: no details entry for ${appID}`)
  const pair = d.flatMap((x) => x.components ?? []).filter((c) => c['/'] === '/' && c['#'] === '/pair*' && !c.exclude)
  if (pair.length !== 1) fail(`${where}: expected one component matching "/" with "#": "/pair*"`)
}

checkAASA('../../ui/public-remote/.well-known/apple-app-site-association', 'ui/public-remote')
if (process.argv.includes('--built')) {
  checkAASA('../../ui/dist-remote/.well-known/apple-app-site-association', 'ui/dist-remote')
  if (!existsSync(at('../../ui/dist-remote/_headers'))) fail('ui/dist-remote/_headers: missing')
}

if (bad) process.exit(1)
console.log(`The pairing link opens ${appID}: entitlement, association file${process.argv.includes('--built') ? ' and the remote build' : ''} agree.`)
