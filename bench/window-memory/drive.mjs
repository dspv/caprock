// drive.mjs --stand <dir> --app <.app copy> --ctl <port> [--w 1440 --h 900]
// Launches the snapshot app copy (bench/README.md § Method) against the stand
// and serves a control port for scenario.mjs:
//   POST /run      body = async function body with B in scope -> JSON result
//   GET  /pid      the app's pid
//   POST /quit     SIGTERM the app (ours) and exit
import http from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pageHook, sleep } from '../lib.mjs'

const argv = process.argv.slice(2)
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d }
const STAND = opt('stand'); const APP = opt('app'); const CTL = Number(opt('ctl', 47311))
const W = Number(opt('w', 1440)); const H = Number(opt('h', 900))
const PORT = Number(readFileSync(join(STAND, 'port'), 'utf8'))
const HOME = join(STAND, 'home'); const DATA = join(STAND, 'data'); const SNAP = join(STAND, 'snap')
const EXE = join(APP, 'Contents/MacOS/caprock-app')
const BUNDLE_ID = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', join(APP, 'Contents/Info.plist')], { encoding: 'utf8' }).trim()
if (BUNDLE_ID === 'dev.caprock.app') { console.error('refusing the real bundle id'); process.exit(2) }
mkdirSync(SNAP, { recursive: true })

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
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    res.writeHead(204, cors); res.end()
    let data = null
    try { data = JSON.parse(body) } catch { return }
    if (url.pathname === '/result') { const r = results.get(url.searchParams.get('id')); if (r) r(data) }
    if (url.pathname === '/event') events.push(data)
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const COLLECTOR = `http://127.0.0.1:${server.address().port}`

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

const appPid = () => { try { return Number(execFileSync('pgrep', ['-f', `^${EXE}`], { encoding: 'utf8' }).trim().split('\n')[0]) || null } catch { return null } }
if (appPid()) { console.error('an instance of this app copy is already running'); process.exit(2) }
writeFileSync(join(SNAP, 'init.js'), pageHook({ daemonPort: PORT, collector: COLLECTOR, autoEcho: null }))
const dir = join(HOME, 'Library/Application Support', BUNDLE_ID)
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, '.window-state.json'), JSON.stringify({ main: { width: W, height: H, x: -(W - 2), y: 1080 - 2, prev_x: 0, prev_y: 0, maximized: false, visible: true, decorated: true, fullscreen: false } }))
const env = { HOME, CFFIXED_USER_HOME: HOME, CAPROCK_DATA_DIR: DATA, CAPROCK_SERVICE_LABEL: 'dev.caprock.memtest', CAPROCK_SECRET_STORE: 'file',
  CAPROCK_APP_BACKGROUND: '1', CAPROCK_APP_SNAPSHOT_DIR: SNAP, CAPROCK_APP_NOTIFY_LOG: join(STAND, 'notify.log') }
const args = ['-g', '-n', '-F']
for (const [k, v] of Object.entries(env)) args.push('--env', `${k}=${v}`)
spawn('open', [...args, APP], { stdio: 'ignore' })
let pid = null
for (let i = 0; i < 200 && !pid; i++) { await sleep(50); pid = appPid() }
console.error('app pid', pid)
writeFileSync(join(STAND, 'app.pid'), String(pid))

const ctl = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', async () => {
    const url = new URL(req.url, 'http://x')
    const send = (code, v) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v, null, 1)) }
    try {
      if (url.pathname === '/run') send(200, await page(body, Number(url.searchParams.get('ms') || 600000)))
      else if (url.pathname === '/pid') send(200, pid)
      else if (url.pathname === '/events') send(200, events)
      else if (url.pathname === '/quit') {
        send(200, 'bye')
        try { process.kill(pid, 'SIGTERM') } catch { /* gone */ }
        for (let i = 0; i < 100; i++) { await sleep(100); try { process.kill(pid, 0) } catch { break } }
        try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
        process.exit(0)
      } else send(404, 'no')
    } catch (e) { send(500, String(e.stack || e)) }
  })
})
ctl.listen(CTL, '127.0.0.1', () => console.error('ctl on', CTL))
