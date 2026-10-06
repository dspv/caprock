// The app update, end to end (F20, ADR-041): the owner's bar is "update like
// Orca does — without losing sessions, everything stays in its place".
//
// usage: bench/update-build.sh <work>   (once; two release builds)
//        node bench/update.mjs --work <work> [--port 4397]
//
// Against a throwaway daemon (its own HOME, data dir, port and service label,
// the fake `claude` from bench/), never the live one, and builds under their
// own bundle id (dev.caprock.updtest):
//
//   1. the daemon runs from <data>/bin/caprock, as the app's own daemon does,
//      with three fake agent sessions;
//   2. the 0.0.1-e2e app opens a tab for each, splits the last one with a
//      shell, types a half line into an agent, scrolls it up, collapses a
//      sidebar group, and the window has a size and place of its own;
//   3. the page clicks Update to v0.0.2-e2e — Restart, served from a loopback
//      server with a latest.json written by scripts/app-update-manifest.py;
//   4. after the relaunch and the move onto the new daemon, the same is read
//      again and compared: every session process alive, the tabs, their
//      order, the tab in front, the split and its sizes, the sidebar, the
//      window, the scroll position, the half-typed line.
//
// Writes <work>/result.json and before.png / after.png (the window, from the
// app itself); exits 1 when anything differs. Input goes in through the
// page (page-hook.js), the window opens in the background and off screen,
// no OS dialog is involved, nothing is left running.
import http from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { pageHook, sleep } from './lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const argv = process.argv.slice(2)
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d }
const W = opt('work')
const PORT = Number(opt('port', 4397))
const SRV = 28741 // baked into the builds (update-build.sh)
const V1 = '0.0.1-e2e'; const V2 = '0.0.2-e2e'
const BUNDLE_ID = 'dev.caprock.updtest'
if (!W || !existsSync(join(W, 'v1/Caprock.app'))) { console.error('usage: node bench/update.mjs --work <dir built by bench/update-build.sh>'); process.exit(2) }
if ([22776, 4173].includes(PORT)) { console.error(`refusing port ${PORT}: a live daemon's`); process.exit(2) }

const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a)
// The stand sits outside any repository: its sessions' folders are not taken for a project.
const S = join(os.tmpdir(), 'caprock-update-stand'); const HOME = join(S, 'home'); const DATA = join(S, 'data'); const SNAP = join(S, 'snap')
const SERVE = join(W, 'serve'); const APPS = join(W, 'Applications'); const APP = join(APPS, 'Caprock.app')
const EXE = join(APP, 'Contents/MacOS/caprock-app')
const plist = (key) => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, join(APP, 'Contents/Info.plist')], { encoding: 'utf8' }).trim()
const pgrep = (pat) => { try { return execFileSync('pgrep', ['-f', pat], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number) } catch { return [] } }
const appPid = () => pgrep(`^${EXE}`)[0] || null
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

// --- A clean stand.
rmSync(S, { recursive: true, force: true }); rmSync(SERVE, { recursive: true, force: true }); rmSync(APPS, { recursive: true, force: true })
for (const d of [HOME, DATA, SNAP, join(S, 'bin'), join(DATA, 'bin'), SERVE, APPS]) mkdirSync(d, { recursive: true })
cpSync(join(W, 'v1/Caprock.app'), APP, { recursive: true })
if (plist('CFBundleIdentifier') !== BUNDLE_ID) { console.error(`refusing: ${APP} is not ${BUNDLE_ID}`); process.exit(2) }
cpSync(join(HERE, 'fake-claude'), join(S, 'bin/claude')); execFileSync('chmod', ['+x', join(S, 'bin/claude')])
cpSync(join(APP, 'Contents/MacOS/caprock'), join(DATA, 'bin/caprock'))
writeFileSync(join(DATA, 'config.json'), JSON.stringify({ port: PORT, update_checks: false, open_browser: false, notify_approval: false, notify_finished: false }))
writeFileSync(join(DATA, 'app.json'), JSON.stringify({ background: false }))
writeFileSync(join(DATA, 'app-update.json'), JSON.stringify({ asked: true }))
writeFileSync(join(DATA, 'app-hotkey.json'), JSON.stringify({ accelerator: null }))
const WIN = { w: 1180, h: 740 }
const winDir = join(HOME, 'Library/Application Support', BUNDLE_ID)
mkdirSync(winDir, { recursive: true })
writeFileSync(join(winDir, '.window-state.json'), JSON.stringify({ main: { width: WIN.w, height: WIN.h, x: -(WIN.w - 2), y: 1078, prev_x: 0, prev_y: 0, maximized: false, visible: true, decorated: true, fullscreen: false } }))
// The update, as a release would carry it.
const tar = `Caprock_${V2}_universal.app.tar.gz`
cpSync(join(W, 'v2', tar), join(SERVE, tar))
mkdirSync(join(W, 'sig'), { recursive: true })
cpSync(join(W, 'v2', `${tar}.sig`), join(W, 'sig', `${tar}.sig`))
execFileSync('python3', [join(ROOT, 'scripts/app-update-manifest.py'), `v${V2}`, join(W, 'sig'), '--out', join(SERVE, 'latest.json')])
writeFileSync(join(SERVE, 'latest.json'), readFileSync(join(SERVE, 'latest.json'), 'utf8').replaceAll(`https://github.com/dspv/caprock/releases/download/v${V2}/`, `http://127.0.0.1:${SRV}/`))

// --- The server: the update files, and the page's collector (page-hook.js).
const queue = []; const waiting = []; const results = new Map(); const events = []
let seq = 0
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return }
  if (req.method === 'GET' && url.pathname === '/next') {
    const give = (cmd) => { res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify(cmd)) }
    if (queue.length) { give(queue.shift()); return }
    const w = { give, timer: setTimeout(() => { waiting.splice(waiting.indexOf(w), 1); res.writeHead(204, cors); res.end() }, 20000) }
    waiting.push(w)
    req.on('close', () => { const i = waiting.indexOf(w); if (i >= 0) { clearTimeout(w.timer); waiting.splice(i, 1) } })
    return
  }
  if (req.method === 'GET') {
    const f = join(SERVE, url.pathname.slice(1))
    if (!url.pathname.includes('..') && existsSync(f)) { res.writeHead(200); res.end(readFileSync(f)); events.push({ kind: 'served', path: url.pathname, at: Date.now() }); return }
    res.writeHead(404); res.end(); return
  }
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    res.writeHead(204, cors); res.end()
    let data = null
    try { data = JSON.parse(body) } catch { return }
    if (url.pathname === '/result') { const r = results.get(url.searchParams.get('id')); if (r) r(data) }
    if (url.pathname === '/event') events.push({ ...data, got: Date.now() })
  })
})
await new Promise((r, j) => { server.once('error', j); server.listen(SRV, '127.0.0.1', r) })
const COLLECTOR = `http://127.0.0.1:${SRV}`
function page(src, ms = 120000) {
  const id = String(++seq)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { results.delete(id); reject(new Error(`page script ${id} timed out`)) }, ms)
    results.set(id, (r) => { clearTimeout(timer); results.delete(id); r.ok ? resolve(r.value) : reject(new Error(r.error)) })
    const cmd = { id, src }
    const w = waiting.shift()
    if (w) { clearTimeout(w.timer); w.give(cmd) } else queue.push(cmd)
  })
}
async function event(kind, since, ms = 90000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const e = events.find((x) => x.kind === kind && x.got >= since)
    if (e) return e
    await sleep(250)
  }
  return null
}
async function snap(name) {
  rmSync(join(SNAP, `${name}.png`), { force: true })
  writeFileSync(join(SNAP, 'request'), name)
  for (let i = 0; i < 60 && !existsSync(join(SNAP, `${name}.png`)); i++) await sleep(250)
  if (existsSync(join(SNAP, `${name}.png`))) cpSync(join(SNAP, `${name}.png`), join(W, `${name}.png`))
}

// --- The daemon, run from <data>/bin like the app's own.
const env = { HOME, CFFIXED_USER_HOME: HOME, CAPROCK_DATA_DIR: DATA, CAPROCK_SERVICE_LABEL: BUNDLE_ID, PATH: `${join(S, 'bin')}:/usr/bin:/bin` }
const daemon = spawn(join(DATA, 'bin/caprock'), ['up', '--foreground', '--no-hooks', '--no-open', '--port', String(PORT), '--data-dir', DATA], { cwd: S, env, detached: true, stdio: 'ignore' })
daemon.unref()
const healthy = async () => { try { return (await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok } catch { return false } }
for (let i = 0; i < 80 && !(await healthy()); i++) await sleep(250)
const sids = []
for (let i = 1; i <= 3; i++) {
  const cwd = join(S, 'work', `s0${i}`); mkdirSync(cwd, { recursive: true }); writeFileSync(join(cwd, '.fake_lps'), '-1')
  const r = await (await fetch(`http://127.0.0.1:${PORT}/v1/agents`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd }) })).json()
  sids.push(r.session_id)
}
log('sessions', sids.join(' '))

const result = { versions: [V1, V2], checks: {}, before: null, after: null }
let failed = false
const check = (name, ok, detail) => { result.checks[name] = { ok: !!ok, ...(detail === undefined ? {} : { detail }) }; if (!ok) failed = true; log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : JSON.stringify(detail ?? '')) }
const readState = `
  const terms = {}
  for (const [sid, t] of B.terms) {
    if (!t.element || !t.element.offsetParent) continue
    const b = t.buffer.active
    const tail = []
    for (let i = b.length - 1; i >= 0 && tail.length < 3; i--) { const l = b.getLine(i)?.translateToString(true).trim(); if (l) tail.unshift(l) }
    terms[sid] = { viewportY: b.viewportY, baseY: b.baseY, atBottom: b.viewportY >= b.baseY, cols: t.cols, rows: t.rows, tail }
  }
  const tabs = [...document.querySelectorAll('[role=tab]')].map((e) => ({ text: e.textContent.trim(), selected: e.getAttribute('aria-selected') === 'true' }))
  return {
    workspace: JSON.parse(localStorage.getItem('caprock.app.workspace.v1') || 'null'),
    expanded: localStorage.getItem('caprock.app.expanded'),
    ui: localStorage.getItem('caprock.app.ui'),
    tabs, terms,
    window: { w: innerWidth, h: innerHeight, x: screenX, y: screenY },
    strip: (document.querySelector('footer .mono:last-child') || {}).textContent || null,
    app: (await window.__TAURI_INTERNALS__.invoke('app_update_status')).version,
    loaded: Math.round(performance.timeOrigin),
  }`

try {
  // --- Launch 0.0.1-e2e.
  writeFileSync(join(SNAP, 'init.js'), pageHook({ daemonPort: PORT, collector: COLLECTOR }))
  const t0 = Date.now()
  const args = ['-g', '-n', '-F']
  for (const [k, v] of Object.entries({ ...env, CAPROCK_APP_BACKGROUND: '1', CAPROCK_APP_SNAPSHOT_DIR: SNAP, CAPROCK_APP_NOTIFY_LOG: join(S, 'notify.log') })) args.push('--env', `${k}=${v}`)
  spawn('open', [...args, APP], { stdio: 'ignore' })
  if (!(await event('interactive', t0))) throw new Error('0.0.1-e2e did not come up')
  const pid1 = appPid()
  log('app', V1, 'pid', pid1)

  // --- The layout: a tab per session, the last split with a shell, a half
  // line typed into the agent on the left, which is then scrolled up.
  const [a, b, c] = sids
  await page(`
    const open = async (sid) => { document.querySelector('[data-session-row="' + sid + '"]').click(); await B.when(() => B.terms.get(sid)?.element?.offsetParent, 15000); await B.firstEcho(sid, 15000) }
    await B.when(() => document.querySelectorAll('[data-session-row]').length >= 3, 30000)
    for (const sid of ${JSON.stringify(sids)}) await open(sid)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', code: 'KeyE', metaKey: true, bubbles: true }))
    await B.when(() => document.querySelectorAll('[data-pane]').length >= 2, 15000)
    await B.sleep(2500)
    // Enter first: the fake starts a fresh input line (opening typed nonces into it).
    B.type(${JSON.stringify(c)}, '\\r'); await B.sleep(300)
    for (const ch of 'half typed') { B.type(${JSON.stringify(c)}, ch); await B.sleep(60) }
    await B.expect(${JSON.stringify(c)}, '> half typed', 5000)
    await B.sleep(500)
    B.terms.get(${JSON.stringify(c)}).scrollLines(-300)
    // A sidebar group closed by hand, so "as it was" is not just the default.
    const group = document.querySelector('[data-project-row][aria-expanded="true"]')
    if (group) group.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await B.when(() => localStorage.getItem('caprock.app.expanded'), 5000)
    await B.sleep(1500)
    return 1`)
  result.before = await page(readState)
  await snap('before')
  const hosts = pgrep(`${DATA}/bin/caprock pty-host`)
  const agents = pgrep(`${join(S, 'bin/claude')}`)
  log('pty-hosts', hosts.join(' '), 'agents', agents.join(' '))

  // --- The update: a check, then the one click.
  const t1 = Date.now()
  await page(`await window.__TAURI_INTERNALS__.invoke('app_update_check'); await B.when(() => [...document.querySelectorAll('button')].some((b) => b.textContent.startsWith('Update to')), 15000); [...document.querySelectorAll('button')].find((b) => b.textContent.startsWith('Update to')).click(); return 1`)
  let pid2 = null
  for (let i = 0; i < 240 && !pid2; i++) { await sleep(250); const p = appPid(); if (p && p !== pid1) pid2 = p }
  check('the app restarted into the update', pid2 && plist('CFBundleShortVersionString') === V2, { pid1, pid2, version: plist('CFBundleShortVersionString') })
  if (!(await event('interactive', t1))) throw new Error(`${V2} did not come up`)
  // The relaunched app moves its own daemon onto the new bundled one.
  let swapped = false
  for (let i = 0; i < 240 && !swapped; i++) {
    await sleep(250)
    try { swapped = JSON.parse(readFileSync(join(DATA, 'runtime.json'), 'utf8')).version === V2 && await healthy() } catch { /* mid-swap */ }
  }
  check('the daemon moved onto the new version', swapped)
  await sleep(8000) // the terminals reconnect, replay and go back where they were
  result.after = await page(readState)
  await snap('after')

  // --- Compare.
  const B4 = result.before; const AF = result.after
  check('the page after is the relaunched app', AF.app === V2 && AF.loaded > t1 && B4.app === V1, { before: [B4.app, B4.loaded], after: [AF.app, AF.loaded], clicked: t1 })
  check('a sidebar group was closed by hand before the update', !!B4.expanded, B4.expanded)
  check('every session process is still running', hosts.length >= 4 && hosts.every(alive) && agents.length >= 3 && agents.every(alive), { hosts, agents })
  check('the same tabs in the same order, the same tab in front, the same split and sizes', JSON.stringify(B4.workspace) === JSON.stringify(AF.workspace), { before: B4.workspace, after: AF.workspace })
  check('the tab strip reads the same', JSON.stringify(B4.tabs) === JSON.stringify(AF.tabs), { before: B4.tabs, after: AF.tabs })
  check('the sidebar is expanded and collapsed as it was', B4.expanded === AF.expanded, { before: B4.expanded, after: AF.expanded })
  check('the window has the same size and place', JSON.stringify(B4.window) === JSON.stringify(AF.window), { before: B4.window, after: AF.window })
  const tb = B4.terms[c]; const ta = AF.terms[c]
  check('the scrolled terminal is at the same line', tb && ta && !tb.atBottom && ta.baseY - ta.viewportY === tb.baseY - tb.viewportY, { before: tb && [tb.viewportY, tb.baseY], after: ta && [ta.viewportY, ta.baseY] })
  check('the half-typed line is still there', ta && ta.tail.some((l) => l.includes('> half typed')), { tail: ta?.tail })
  const shell = Object.keys(AF.terms).find((s) => !sids.includes(s))
  check('the split shell is back, at the bottom', shell && AF.terms[shell].atBottom, { shell })
} catch (e) {
  failed = true
  result.error = String(e.stack || e)
  log('error', e.message)
} finally {
  writeFileSync(join(W, 'result.json'), JSON.stringify(result, null, 2))
  // --- Nothing left running.
  const p = appPid(); if (p) { try { process.kill(p, 'SIGTERM') } catch { /* gone */ } }
  try { execFileSync(join(DATA, 'bin/caprock'), ['down'], { env: { ...env }, stdio: 'ignore', timeout: 20000 }) } catch { /* already down */ }
  await sleep(1500)
  for (const pid of [...pgrep(`${DATA}/bin/caprock`), ...pgrep(join(S, 'bin/claude')), ...pgrep(`${S}/`)]) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
  server.close()
  log(failed ? 'FAILED' : 'PASSED', join(W, 'result.json'))
  process.exit(failed ? 1 : 0)
}
