// The desktop app harness (WP-16, bench/README.md): every budget row of
// .ai/21-app.md § Budgets that the app owns, against a stand (stand.sh).
//
// usage: node app.mjs --stand <dir> --app <Caprock.app copy> --out <file.json> [--restarts 5] [--phases open_tabs,cpu_hidden,...]
//
// The app must be a `--features snapshot` build (app/README.md): its init
// script runs page-hook.js before the page's own scripts, and the page
// long-polls this process for what to do (there is no CDP in WKWebView).
// Input goes in through the page (page-hook.js), never the OS keyboard; the
// app is launched with CAPROCK_APP_BACKGROUND and never takes focus. Its
// window is placed all but 2 px off screen through the window-state file.
//
// macOS is the only OS where launching is scripted here (open -g); the
// measurements in the page are the same everywhere (run-linux.sh,
// run-windows.ps1 start the app their own way and pass --pid).
import http from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { machineInfo, machineLoad, procs, pct, median, pageHook, sleep } from './lib.mjs'

const argv = process.argv.slice(2)
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d }
const STAND = opt('stand')
const APP = opt('app')
const OUT = opt('out')
const RESTARTS = Number(opt('restarts', 5))
const KEYS = Number(opt('keys', 200))
// --phases a,b: run only these (the launch always runs), to re-measure some rows.
const ONLY = opt('phases') ? opt('phases').split(',') : null
if (!STAND || !APP || !OUT) { console.error('usage: node app.mjs --stand <dir> --app <.app> --out <file.json>'); process.exit(2) }

const PORT = Number(readFileSync(join(STAND, 'port'), 'utf8'))
const SIDS = readFileSync(join(STAND, 'sids'), 'utf8').trim().split('\n')
const HOME = join(STAND, 'home')
const DATA = join(STAND, 'data')
const SNAP = join(STAND, 'snap')
const MAC = process.platform === 'darwin'
// macOS: --app is the .app copy; elsewhere the executable itself.
const EXE = MAC ? join(APP, 'Contents/MacOS/caprock-app') : APP
const plist = (key) => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, join(APP, 'Contents/Info.plist')], { encoding: 'utf8' }).trim()
const BUNDLE_ID = MAC ? plist('CFBundleIdentifier') : 'dev.caprock.app'
if (MAC && BUNDLE_ID === 'dev.caprock.app') { console.error('refusing: give the copy its own bundle id (run-macos.sh does)'); process.exit(2) }
mkdirSync(SNAP, { recursive: true })
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a)
const lps = (i, rate) => writeFileSync(join(STAND, 'work', `s${String(i + 1).padStart(2, '0')}`, '.fake_lps'), String(rate))
const allLps = (rate) => SIDS.forEach((_, i) => lps(i, rate))

// --- The collector: the page asks for scripts and posts results and events.
const queue = []
const waiting = []
const results = new Map()
const events = []
const eventWaiters = []
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
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    res.writeHead(204, cors); res.end()
    let data = null
    try { data = JSON.parse(body) } catch { return }
    if (url.pathname === '/result') { const r = results.get(url.searchParams.get('id')); if (r) r(data) }
    if (url.pathname === '/event') { if (process.env.BENCH_DEBUG) log('event', JSON.stringify(data)); events.push(data); eventWaiters.splice(0).forEach((f) => f()) }
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const COLLECTOR = `http://127.0.0.1:${server.address().port}`

/** Runs `src` (an async function body with `B` in scope) in the page; its return value. */
function page(src, ms = 600000) {
  const id = String(++seq)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { results.delete(id); reject(new Error(`page script ${id} timed out`)) }, ms)
    results.set(id, (r) => { clearTimeout(timer); results.delete(id); r.ok ? resolve(r.value) : reject(new Error(r.error)) })
    const cmd = { id, src }
    const w = waiting.shift()
    if (w) { clearTimeout(w.timer); w.give(cmd) } else queue.push(cmd)
  })
}
async function event(kind, since, ms = 60000) {
  const end = Date.now() + ms
  for (;;) {
    const e = events.find((x) => x.kind === kind && x.at && x.at >= since)
    if (e) return e
    if (Date.now() > end) return null
    await new Promise((r) => { eventWaiters.push(r); setTimeout(r, 500) })
  }
}

// --- Launching and quitting the app copy.
function placeWindow() {
  // macOS: all but the top-right 2 px off the main display (the window-state
  // plugin restores a position only when a corner is on a monitor). Linux and
  // Windows runs are on a machine nobody is using: the window stays where it opens.
  if (!MAC) return
  const dir = join(HOME, 'Library/Application Support', BUNDLE_ID)
  mkdirSync(dir, { recursive: true })
  const w = 1280; const h = 800
  const state = { main: { width: w, height: h, x: -(w - 2), y: Number(process.env.BENCH_SCREEN_H || 1080) - 2, prev_x: 0, prev_y: 0, maximized: false, visible: true, decorated: true, fullscreen: false } }
  writeFileSync(join(dir, '.window-state.json'), JSON.stringify(state))
}
let child = null
const appPid = () => {
  if (!MAC) return child && child.exitCode === null ? child.pid : null
  try { return Number(execFileSync('pgrep', ['-f', `^${EXE}`], { encoding: 'utf8' }).trim().split('\n')[0]) || null } catch { return null }
}

async function launch(autoEcho) {
  if (appPid()) throw new Error('an instance of the bench app is already running')
  writeFileSync(join(SNAP, 'init.js'), pageHook({ daemonPort: PORT, collector: COLLECTOR, autoEcho: autoEcho || null }))
  rmSync(join(SNAP, 'loads.txt'), { force: true })
  placeWindow()
  const env = {
    HOME, CFFIXED_USER_HOME: HOME, CAPROCK_DATA_DIR: DATA, CAPROCK_SERVICE_LABEL: 'dev.caprock.bench',
    CAPROCK_APP_BACKGROUND: '1', CAPROCK_APP_SNAPSHOT_DIR: SNAP, CAPROCK_APP_NOTIFY_LOG: join(STAND, 'notify.log'),
  }
  const t0 = Date.now()
  if (MAC) {
    // Through LaunchServices in the background: the app never takes focus,
    // and it is the "responsible process" of its WebKit helpers (procs.py).
    const args = ['-g', '-n', '-F']
    for (const [k, v] of Object.entries(env)) args.push('--env', `${k}=${v}`)
    spawn('open', [...args, APP], { stdio: 'ignore' })
  } else {
    child = spawn(EXE, [], { env: { ...process.env, ...env }, stdio: 'ignore' })
  }
  let pid = null
  for (let i = 0; i < 100 && !pid; i++) { await sleep(50); pid = appPid() }
  const interactive = await event('interactive', t0, 60000)
  return { t0, pid, interactive_ms: interactive?.at ? Math.round(interactive.at - t0) : null }
}
async function quit(pid) {
  if (!pid) return
  try { process.kill(pid, 'SIGTERM') } catch { return }
  for (let i = 0; i < 100; i++) { await sleep(100); try { process.kill(pid, 0) } catch { return } }
  try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
}

const R = { harness: 'app', machine: machineInfo(), app: { path: APP, bundle_id: BUNDLE_ID, version: MAC ? plist('CFBundleShortVersionString') : null }, port: PORT, phases: {} }
const phase = async (name, fn) => {
  if (ONLY && name !== 'cold_start_first' && !ONLY.includes(name)) return
  const before = machineLoad()
  log('phase', name, 'load', before.load.join(' '))
  const started = Date.now()
  try { R.phases[name] = { ...(await fn()), load_before: before } } catch (e) { R.phases[name] = { error: String(e.stack || e), load_before: before } ; log('failed', name, e.message) }
  R.phases[name].seconds = Math.round((Date.now() - started) / 1000)
  writeFileSync(OUT, JSON.stringify(R, null, 2))
}
const settle = (ms) => sleep(ms)
/** procs() with the page's harness loop quiet for the window (page-hook.js B.quiet). */
const quietProcs = async (seconds) => {
  await page(`B.quiet(${(seconds + 3) * 1000}); return 1`)
  await sleep(1500) // the long-poll in flight answers 204 within the collector's 20 s, or now
  return procs(A.pid, seconds)
}
// A click on the session's row in the sidebar: opens its tab, or brings an open one to the front.
const openTab = (sid) => `document.querySelector('[data-session-row=${JSON.stringify(sid)}]').click()`

// --- Launch A: a fresh workspace.
allLps(0)
let A = null
await phase('cold_start_first', async () => {
  A = await launch(null)
  if (!A.pid) throw new Error('app did not start')
  return { interactive_ms: A.interactive_ms, note: 'first launch of this copy (includes the system scan of a new binary)' }
})
// Disk written in the first two minutes after launch (MVP reference row).
const firstTwoMinutes = (async () => { await sleep(Math.max(0, A.t0 + 120000 - Date.now())); return procs(A.pid, 1) })()
await settle(3000)

await phase('open_tabs', async () => {
  const opens = []
  const clicks = []
  const memory = {}
  await page(`await B.when(() => document.querySelectorAll('[data-session-row]').length >= ${SIDS.length + 1}, 30000)`)
  await page('B.lagStart()')
  for (let i = 0; i < SIDS.length; i++) {
    // click_ms: how long the click's own task ran (React's render and the new terminal).
    const r = await page(`const t0 = B.epoch(); ${openTab(SIDS[i])}; const c = B.epoch() - t0; const at = await B.firstEcho(${JSON.stringify(SIDS[i])}, 15000); return { t: at && at - t0, c }`)
    const t = r.t
    clicks.push(Math.round(r.c))
    opens.push(t === null ? null : Math.round(t))
    log('open', i + 1, t && Math.round(t))
    if ([1, 5, 10].includes(i + 1)) {
      const lag = await page('return B.lagStop()')
      await settle(5000)
      memory[i + 1] = await procs(A.pid, 10)
      memory[i + 1].lag = lag
      await page('B.lagStart()')
    } else await settle(1000)
  }
  const lag = await page('return B.lagStop()')
  await settle(40000) // past HIDDEN_DISCONNECT_MS: hidden tabs let go of their sockets and WebGL
  memory['10_settled'] = await procs(A.pid, 10)
  return { open_to_first_echo_ms: opens, click_task_ms: clicks, p50: median(opens), p95: pct(opens, 0.95), memory, lag }
})

await phase('switch_tabs', async () => {
  const v = await page(`
    const sids = ${JSON.stringify(SIDS)}; const out = []
    B.lagStart()
    let cur = sids[sids.length - 1]
    for (let i = 0; i < 20; i++) {
      let next; do { next = sids[Math.floor(Math.random() * sids.length)] } while (next === cur)
      const t0 = performance.now()
      document.querySelector('[data-session-row="' + next + '"]').click()
      const shown = await B.when(() => { const t = B.terms.get(next); return t && t.element && t.element.offsetParent && t.element.clientWidth > 0 }, 5000)
      if (shown) { await B.paintAfter(next); out.push(performance.now() - t0) } else out.push(null)
      cur = next
      await B.sleep(1000)
    }
    return { switch_ms: out.map((x) => x && Math.round(x * 10) / 10), lag: B.lagStop() }`)
  return { ...v, p50: median(v.switch_ms), p95: pct(v.switch_ms, 0.95) }
})

const S1 = SIDS[0]
// --probe <file.js>: an async function body run in the page (with B, SIDS), for investigating a row.
if (opt('probe')) await phase('probe', async () => ({ value: await page(`const SIDS = ${JSON.stringify(SIDS)};\n` + readFileSync(opt('probe'), 'utf8')) }))
await phase('echo', async () => {
  await page(`${openTab(S1)}; await B.when(() => B.terms.get(${JSON.stringify(S1)})?.element?.offsetParent, 5000)`)
  await settle(3000)
  const cells = {}
  for (const rate of [0, 200, 1000]) {
    lps(0, rate)
    await settle(2000)
    const r = await page(`B.lagStart(); const r = await B.typing(${JSON.stringify(S1)}, ${KEYS}); r.lag = B.lagStop(); return r`)
    cells[rate] = { ...r, p50: pct(r.paint_ms, 0.5), p95: pct(r.paint_ms, 0.95), max: pct(r.paint_ms, 1), socket_p50: pct(r.socket_ms, 0.5) }
    log('echo', rate, cells[rate].p50, cells[rate].p95, 'timeouts', r.timeouts, 'path', r.key_path)
  }
  lps(0, 0)
  return { cells, grid: await page(`const t = B.terms.get(${JSON.stringify(S1)}); return t && [t.cols, t.rows]`) }
})

await phase('cpu_visible', async () => {
  // Frames drawn in a second: a check that the window really paints (0 means
  // it was occluded or the display slept, and the row is not valid).
  const fps = () => page('let n = 0; let on = true; const f = () => { n++; if (on) requestAnimationFrame(f) }; requestAnimationFrame(f); await B.sleep(1000); on = false; return n')
  await page(`${openTab(S1)}; await B.when(() => B.terms.get(${JSON.stringify(S1)})?.element?.offsetParent, 5000)`)
  allLps(-1)
  await settle(8000)
  const idle = await quietProcs(60)
  lps(0, 0)
  await settle(3000)
  const spinner = await quietProcs(30)
  lps(0, 1000)
  await settle(3000)
  const flood = await quietProcs(30)
  flood.frames_per_second = await fps()
  lps(0, -1)
  return { no_output: idle, spinner_only: spinner, one_tab_1000_lps: flood }
})

await phase('flood_isolation', async () => {
  const B2 = SIDS[1]
  await page(`${openTab(B2)}; await B.when(() => B.terms.get(${JSON.stringify(B2)})?.element?.offsetParent, 5000)`)
  lps(0, 0)
  lps(1, 1000)
  await settle(1500)
  await page(`${openTab(S1)}; await B.when(() => B.terms.get(${JSON.stringify(S1)})?.element?.offsetParent, 5000)`)
  await settle(1000)
  // 120 keys take about 25 s, inside the 30 s a hidden tab keeps its socket.
  const r = await page(`B.lagStart(); const r = await B.typing(${JSON.stringify(S1)}, 120); r.lag = B.lagStop(); return r`)
  const hidden = await page(`return B.sockets.filter((s) => s.sid === ${JSON.stringify(B2)}).map((s) => ({ open: !!s.open, closed: s.closed }))`)
  lps(1, -1)
  lps(0, -1)
  return { ...r, p50: pct(r.paint_ms, 0.5), p95: pct(r.paint_ms, 0.95), max: pct(r.paint_ms, 1), flooding_tab_sockets: hidden }
})

await phase('daemon_restart', async () => {
  lps(0, 0)
  const pidFile = join(STAND, 'daemon.pid')
  const old = Number(readFileSync(pidFile, 'utf8'))
  process.kill(old, 'SIGTERM')
  for (let i = 0; i < 100; i++) { await sleep(100); try { process.kill(old, 0) } catch { break } }
  const bin = readFileSync(join(STAND, 'daemon.bin'), 'utf8').trim()
  const d = spawn(bin, ['up', '--foreground', '--no-hooks', '--no-open', '--port', String(PORT), '--data-dir', DATA], {
    cwd: STAND, detached: true, stdio: ['ignore', 'ignore', 'ignore'],
    env: { HOME, CAPROCK_DATA_DIR: DATA, CAPROCK_SERVICE_LABEL: 'dev.caprock.bench', PATH: `${join(STAND, 'bin')}:/usr/bin:/bin` },
  })
  d.unref()
  writeFileSync(pidFile, String(d.pid))
  let up = null
  for (let i = 0; i < 200 && !up; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) up = Date.now() } catch { await sleep(25) }
  }
  if (!up) throw new Error('daemon did not come back')
  const at = await page(`return B.firstEcho(${JSON.stringify(S1)}, 20000)`, 60000)
  lps(0, -1)
  return { daemon_up_to_live_terminal_ms: at && Math.round(at - up) }
})

await phase('long_session_disk', async () => {
  const first = await firstTwoMinutes
  const total = await procs(A.pid, 1)
  return { first_two_minutes: { disk_written_total_mb: first.disk_written_total_mb, by_process: first.by_process?.map((p) => [p.comm, p.disk_written_total_mb]) }, since_launch: { seconds: Math.round((Date.now() - A.t0) / 1000), disk_written_total_mb: total.disk_written_total_mb } }
})

await phase('cpu_hidden', async () => {
  // The snapshot build hides its window on request on macOS only.
  if (!MAC) return { not_scripted: 'hiding the window is scripted on macOS only' }
  allLps(0)
  writeFileSync(join(SNAP, 'hide'), '')
  await settle(8000)
  const spinner = await quietProcs(30)
  allLps(-1)
  await settle(5000)
  const silent = await quietProcs(30)
  return { no_output: silent, spinners_running: spinner }
})

// Leave tab 1 in front for the restored-tab launches.
await page(`${openTab(S1)}; await B.sleep(500); return 1`).catch(() => {})
await settle(4000)
await quit(A.pid)
await settle(3000)

await phase('cold_start', async () => {
  const runs = []
  allLps(0)
  for (let i = 0; i < RESTARTS; i++) {
    const L = await launch(S1)
    const echo = await event('restored-echo', L.t0, 60000)
    runs.push({ interactive_ms: L.interactive_ms, restored_first_echo_ms: echo?.at ? Math.round(echo.at - L.t0) : null, load: machineLoad().load })
    log('cold start', runs.at(-1))
    await settle(4000)
    await quit(L.pid)
    await settle(3000)
  }
  allLps(-1)
  const ia = runs.map((r) => r.interactive_ms); const ec = runs.map((r) => r.restored_first_echo_ms)
  return { runs, interactive_p50: median(ia), interactive_max: pct(ia, 1), restored_echo_p50: median(ec), restored_echo_max: pct(ec, 1) }
})

R.load_after = machineLoad()
writeFileSync(OUT, JSON.stringify(R, null, 2))
server.close()
log('wrote', OUT)
process.exit(0)
