// Keystroke-to-echo through a linked computer (ADR-067, OQ-17/OQ-18).
//
// Two throwaway daemons — a target and a controller, each with its own HOME,
// data directory and port, the fake `claude` on PATH and nothing else from
// this machine's environment — and a relay of their own on loopback
// (`caprock remote relay`), never the hosted one unless --relay names it.
// The target turns access from anywhere on at that relay and shows a link for
// a computer; the controller pastes it (POST /v1/machines); the target allows
// it; the controller starts the fake claude on the target through its
// /v1/m/{id}/… proxy. Then one key at a time, each timed from the send to the
// frame that echoes it (the target's tty echo):
//
// - local: the target's own terminal socket, as its own dashboard types;
// - peer:  the same session through the controller's proxy, the relay, Noise
//          and the target's Host — what the app does for another computer.
//
// usage: node bench/peer.mjs --bin ./bin/caprock --claude ./bin/claude
//          [--work DIR] [--keys 200] [--gap 40] [--relay wss://…] [--out FILE]
//
// Writes one JSON object (stdout, and --out): median, p95 and max for each
// leg, the relay used, the machine and the date. Exit 1 when a leg fails.
import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import { join, resolve } from 'node:path'

const argv = process.argv.slice(2)
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d }
const BIN = opt('bin') && resolve(opt('bin'))
const CLAUDE = opt('claude') && resolve(opt('claude'))
const KEYS = Number(opt('keys', '200'))
const GAP = Number(opt('gap', '40'))
const OUT = opt('out')
const RELAY = opt('relay', '')
if (!BIN || !CLAUDE) {
  console.error('usage: node bench/peer.mjs --bin ./bin/caprock --claude ./bin/claude [--work DIR] [--keys 200] [--gap 40] [--relay wss://…] [--out FILE]')
  process.exit(2)
}
const exe = process.platform === 'win32' ? '.exe' : ''
const WORK = realpathSync(opt('work') ? (mkdirSync(opt('work'), { recursive: true }), opt('work')) : mkdtempSync(join(os.tmpdir(), 'caprock-peer-')))
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer()
  s.once('error', rej)
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) })
})

// --- The stand ----------------------------------------------------------------
const bin = join(WORK, 'bin')
mkdirSync(bin, { recursive: true })
copyFileSync(CLAUDE, join(bin, `claude${exe}`))
chmodSync(join(bin, `claude${exe}`), 0o755)
const side = (name) => {
  const home = join(WORK, `${name}-home`), data = join(WORK, `${name}-data`)
  mkdirSync(home, { recursive: true }); mkdirSync(data, { recursive: true })
  const sep = process.platform === 'win32' ? ';' : ':'
  // A clean environment: none of this machine's keys, tokens or Claude
  // settings reach a daemon of the bench.
  const env = {
    HOME: home, USERPROFILE: home, CAPROCK_DATA_DIR: data, CAPROCK_SECRET_STORE: 'file',
    PATH: process.platform === 'win32' ? `${bin}${sep}${process.env.PATH}` : `${bin}${sep}/usr/bin${sep}/bin`,
    TMPDIR: process.env.TMPDIR || os.tmpdir(), LANG: 'en_US.UTF-8',
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP } : {}),
  }
  return { name, home, data, env }
}
const procs = []
const start = (cmd, args, env, label) => {
  const p = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  p.stdout.on('data', (b) => { out += b })
  p.stderr.on('data', (b) => { out += b })
  p.log = () => out
  p.label = label
  procs.push(p)
  return p
}
async function http(base, method, path, body) {
  // The daemon refuses a state-changing request without a JSON content type.
  const write = method !== 'GET'
  const res = await fetch(base + path, { method, headers: write ? { 'Content-Type': 'application/json' } : {}, body: write ? JSON.stringify(body ?? {}) : undefined })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, json }
}
async function until(what, fn, ms = 60_000) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn().catch(() => undefined)
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(200)
  }
}

function cleanup() {
  for (const p of procs) { try { p.kill() } catch { /* gone */ } }
  // The terminal holders outlive their daemon by design (ADR-033): stop the
  // ones this bench's daemons started, by the pids they recorded.
  for (const s of ['target', 'controller']) {
    const dir = join(WORK, `${s}-data`, 'ptyhost')
    let files = []
    try { files = readdirSync(dir).filter((f) => f.endsWith('.json')) } catch { continue }
    for (const f of files) {
      try {
        const r = JSON.parse(readFileSync(join(dir, f), 'utf8'))
        for (const pid of [r.child_pid, r.host_pid]) if (pid > 1) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
      } catch { /* not a record */ }
    }
  }
}
process.on('exit', cleanup)
process.on('SIGINT', () => process.exit(130))

// --- One leg: N keys, each timed to its echo ------------------------------------
async function leg(url, label) {
  const ws = new WebSocket(url)
  ws.binaryType = 'arraybuffer'
  let buf = ''
  let waiter = null
  const dec = new TextDecoder()
  ws.onmessage = (e) => {
    buf += typeof e.data === 'string' ? e.data : dec.decode(e.data)
    if (buf.length > 1 << 16) buf = buf.slice(-4096)
    if (waiter && buf.includes(waiter.want)) { const w = waiter; waiter = null; w.done(performance.now()) }
  }
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error(`${label}: the socket did not open`)) })
  const wait = (want, ms = 10_000) => new Promise((res, rej) => {
    if (buf.includes(want)) { res(performance.now()); return }
    const t = setTimeout(() => { waiter = null; rej(new Error(`${label}: no ${JSON.stringify(want)} in ${ms} ms`)) }, ms)
    waiter = { want, done: (at) => { clearTimeout(t); res(at) } }
  })
  await sleep(800) // the replay of what is on screen arrives first
  const enc = new TextEncoder()
  const times = []
  const letters = 'abcdefghijklmnopqrstuvwxyz'
  for (let i = 0; i < KEYS; i++) {
    // A marker per key that cannot be in the replay: a letter after a fresh line.
    const ch = letters[i % letters.length]
    buf = ''
    const t0 = performance.now()
    ws.send(enc.encode(ch))
    const t1 = await wait(ch)
    times.push(t1 - t0)
    if (i % 20 === 19) {
      // End the line, so the fake claude answers and the tty starts afresh.
      buf = ''
      ws.send(enc.encode('\r'))
      await wait('you-said:')
    }
    await sleep(GAP)
  }
  ws.close()
  return times
}

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] }
const round = (x) => Math.round(x * 100) / 100
const summary = (xs) => ({ n: xs.length, median_ms: round(pct(xs, 50)), p95_ms: round(pct(xs, 95)), max_ms: round(Math.max(...xs)), min_ms: round(Math.min(...xs)) })

function machine() {
  return { platform: process.platform, arch: process.arch, cpus: os.cpus().length, cpu_model: os.cpus()[0]?.model, mem_gb: Math.round(os.totalmem() / 2 ** 30), os: `${os.type()} ${os.release()}`, load: os.loadavg().map(round) }
}

// --- Run ----------------------------------------------------------------------
try {
  const t = side('target'), c = side('controller')
  const proj = join(t.home, 'proj')
  mkdirSync(proj, { recursive: true })
  let relay = RELAY
  if (!relay) {
    const rp = await freePort()
    start(BIN, ['remote', 'relay', '--addr', `127.0.0.1:${rp}`], t.env, 'relay')
    relay = `ws://127.0.0.1:${rp}`
    await until('the relay', async () => (await new Promise((res) => { const s = net.connect(rp, '127.0.0.1', () => { s.end(); res(true) }); s.on('error', () => res(false)) })))
  }
  const [tp, cp] = [await freePort(), await freePort()]
  const T = `http://127.0.0.1:${tp}`, C = `http://127.0.0.1:${cp}`
  for (const [s, p] of [[t, tp], [c, cp]]) start(BIN, ['up', '--foreground', '--no-hooks', '--no-open', '--port', String(p), '--data-dir', s.data], s.env, s.name)
  await until('the target', async () => (await fetch(`${T}/healthz`)).ok)
  await until('the controller', async () => (await fetch(`${C}/healthz`)).ok)
  log('daemons up', T, C, 'relay', relay)

  let r = await http(T, 'POST', '/v1/pair/remote', { on: true, relay })
  if (r.status !== 200) throw new Error(`remote on: ${r.status} ${JSON.stringify(r.json)}`)
  await until('the target at the relay', async () => (await http(T, 'GET', '/v1/pair/state')).json?.remote?.status === 'online')
  r = await http(T, 'POST', '/v1/pair/code', { kind: 'machine' })
  const link = r.json?.remote?.link
  if (!link) throw new Error(`no link for a computer: ${JSON.stringify(r.json)}`)
  r = await http(C, 'POST', '/v1/machines', { link })
  if (r.status !== 200) throw new Error(`add: ${r.status} ${JSON.stringify(r.json)}`)
  const mid = r.json.id
  const waiting = (await http(T, 'GET', '/v1/pair/state')).json.devices.find((d) => d.kind === 'machine' && d.pending)
  r = await http(T, 'POST', `/v1/pair/devices/${waiting.id}/allow`)
  if (r.status !== 200) throw new Error(`allow: ${r.status} ${JSON.stringify(r.json)}`)
  await until('the computer online', async () => (await http(C, 'GET', '/v1/machines?check=1')).json.machines[0]?.status === 'online')
  r = await http(C, 'POST', `/v1/m/${mid}/v1/agents`, { cwd: proj })
  if (r.status !== 200) throw new Error(`spawn through the proxy: ${r.status} ${JSON.stringify(r.json)}`)
  const sid = r.json.session_id
  log('session', sid, 'on the target, started through the controller')

  const localURL = `ws://127.0.0.1:${tp}/v1/agents/${sid}/term`
  const peerURL = `ws://127.0.0.1:${cp}/v1/m/${mid}/v1/agents/${sid}/term`
  // Alternate, so a slow minute of the machine lands on both legs alike.
  const local = [], peer = []
  for (let round_ = 0; round_ < 2; round_++) {
    log(`round ${round_ + 1}: local`)
    local.push(...await leg(localURL, 'local'))
    log(`round ${round_ + 1}: through the computer`)
    peer.push(...await leg(peerURL, 'peer'))
  }
  const counters = (await http(C, 'GET', '/v1/machines')).json.machines[0]
  const result = {
    bench: 'peer', date: new Date().toISOString(),
    relay: RELAY ? relay : 'local (caprock remote relay on 127.0.0.1)',
    keys_per_leg: KEYS * 2, gap_ms: GAP,
    local: summary(local), peer: summary(peer),
    added_ms: { median: round(pct(peer, 50) - pct(local, 50)), p95: round(pct(peer, 95) - pct(local, 95)) },
    machine: machine(), controller_view: { status: counters?.status, version: counters?.version, streams: counters?.streams },
  }
  await http(T, 'POST', `/v1/agents/${sid}/signal`, { action: 'kill' })
  const text = JSON.stringify(result, null, 2)
  console.log(text)
  if (OUT) writeFileSync(OUT, text + '\n')
  if (!opt('work')) rmSync(WORK, { recursive: true, force: true })
  process.exit(0)
} catch (e) {
  console.error(String(e?.stack || e))
  for (const p of procs) console.error(`--- ${p.label}\n${p.log().slice(-3000)}`)
  process.exit(1)
}
