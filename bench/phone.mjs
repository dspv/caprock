// The phone harness (WP-16, bench/README.md): the dashboard as a phone sees
// it — headless Chrome at 390 px — through a TCP proxy this script controls,
// so the network can drop, stall, switch and slow down as a phone's does
// (the events of ui/src/lib/flaky.test.ts, WP-13, on a real browser and
// daemon instead of fakes).
//
// usage: node phone.mjs --stand <dir> --out <file.json> [--events 18] [--only wifi_off,stall,...]
//
// Rows: chat open (route change to the newest message drawn) on Wi-Fi and
// cellular latency; network back to live terminal (median, budget 3 s); a
// half-open connection detected (budget 25 s). Typing goes in through the page
// (page-hook.js), over CDP to a headless Chrome: no window, no OS input.
import net from 'node:net'
import { spawn, execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { machineInfo, machineLoad, pct, median, pageHook, sleep } from './lib.mjs'

const argv = process.argv.slice(2)
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d }
const STAND = opt('stand')
const OUT = opt('out')
const CHROME = opt('chrome', process.env.CHROME || ({ darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', win32: 'C:/Program Files/Google/Chrome/Application/chrome.exe' })[process.platform] || 'google-chrome')
if (!STAND || !OUT) { console.error('usage: node phone.mjs --stand <dir> --out <file.json>'); process.exit(2) }
const PORT = Number(readFileSync(join(STAND, 'port'), 'utf8'))
const SIDS = readFileSync(join(STAND, 'sids'), 'utf8').trim().split('\n')
const CHAT = readFileSync(join(STAND, 'chat-sid'), 'utf8').trim()
const SID = SIDS[2]
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a)
const lps = (rate) => writeFileSync(join(STAND, 'work', 's03', '.fake_lps'), String(rate))

// --- The network: a TCP proxy in front of the daemon.
const PROFILES = { wifi: { rtt: 10 }, cellular: { rtt: 120 } }
const net0 = { mode: 'up', rtt: PROFILES.wifi.rtt, conns: new Set(), accepted: [] }
const proxy = net.createServer((client) => {
  net0.accepted.push(Date.now())
  if (net0.mode === 'down') { client.resetAndDestroy(); return }
  const up = net.connect(PORT, '127.0.0.1')
  const c = { client, up, held: [] }
  net0.conns.add(c)
  const pipe = (from, to) => {
    let lastAt = 0
    from.on('data', (buf) => {
      const send = () => { if (!to.destroyed) to.write(buf) }
      if (net0.mode === 'blackhole') { c.held.push(send); return }
      // Half the round trip each way, in order.
      const at = Math.max(Date.now() + net0.rtt / 2, lastAt)
      lastAt = at
      setTimeout(send, at - Date.now())
    })
  }
  pipe(client, up)
  pipe(up, client)
  const end = () => { net0.conns.delete(c); client.destroy(); up.destroy() }
  client.on('error', end); up.on('error', end); client.on('close', end); up.on('close', end)
})
await new Promise((r) => proxy.listen(0, '127.0.0.1', r))
const PROXY = proxy.address().port
const setNet = (mode) => {
  net0.mode = mode
  if (mode === 'down') for (const c of net0.conns) { c.client.resetAndDestroy(); c.up.destroy() }
  if (mode === 'up') for (const c of net0.conns) c.held.splice(0).forEach((f) => f())
}
const resetAll = () => { for (const c of net0.conns) { c.client.resetAndDestroy(); c.up.destroy() } }

// --- Chrome over CDP (as the spike's web.mjs did).
const cdpPort = 9300 + Math.floor(Math.random() * 400)
const profile = mkdtempSync(join(process.env.TMPDIR || '/tmp', 'caprock-bench-phone-'))
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=390,844',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
  'about:blank'], { stdio: 'ignore' })
let targets = []
for (let i = 0; i < 100; i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); if (targets.find((t) => t.type === 'page')) break } catch { /* not up */ }
  await sleep(200)
}
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
await new Promise((r) => { ws.onopen = r })
let id = 0
const pending = new Map()
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id) } }
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
const page = async (src) => {
  const r = await send('Runtime.evaluate', { expression: `(async () => { const B = window.__caprockBench; ${src} })()`, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400))
  return r.result?.result?.value
}
const offline = (on) => send('Network.emulateNetworkConditions', { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })

await send('Runtime.enable')
await send('Page.enable')
await send('Network.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true })
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
await send('Page.addScriptToEvaluateOnNewDocument', { source: pageHook({ daemonPort: PROXY }) })
await send('Page.navigate', { url: `http://127.0.0.1:${PROXY}/#/` })
await sleep(4000)

const R = { harness: 'phone', machine: machineInfo(), viewport: '390x844@3', profiles: PROFILES, phases: {} }
const phase = async (name, fn) => {
  const before = machineLoad()
  log('phase', name, 'load', before.load.join(' '))
  try { R.phases[name] = { ...(await fn()), load_before: before } } catch (e) { R.phases[name] = { error: String(e.stack || e), load_before: before }; log('failed', name, e.message) }
  writeFileSync(OUT, JSON.stringify(R, null, 2))
}

await phase('chat_open', async () => {
  const out = {}
  for (const [name, p] of Object.entries(PROFILES)) {
    net0.rtt = p.rtt
    const runs = []
    for (let i = 0; i < 8; i++) {
      await page(`location.hash = '#/'; await B.sleep(1500)`)
      const ms = await page(`
        const t0 = B.epoch()
        location.hash = ${JSON.stringify(`#/session/${CHAT}?tab=chat`)}
        const at = await B.when(() => document.body.textContent.includes('bench-last-message'), 15000)
        return at && at - t0`)
      runs.push(ms === null ? null : Math.round(ms))
    }
    out[name] = { runs, p50: median(runs), p95: pct(runs, 0.95) }
    log('chat', name, out[name].p50)
  }
  net0.rtt = PROFILES.wifi.rtt
  return out
})

// The phone's terminal, live before the events start.
lps(0)
await page(`location.hash = ${JSON.stringify(`#/session/${SID}?tab=terminal`)}; await B.sleep(500)`)
const live0 = await page(`return B.firstEcho(${JSON.stringify(SID)}, 20000)`)
log('terminal live', !!live0)

/** From the network back to a keystroke echoed and drawn in the terminal. */
const backToLive = async (back) => {
  const at = await page(`return B.firstEcho(${JSON.stringify(SID)}, 60000)`)
  return at && Math.round(at - back)
}
const EVENTS = [
  ...Array(5).fill(['wifi_off', 5000]),
  ['airplane', 60000],
  ...Array(5).fill(['wifi_to_cellular', 0]),
  ...Array(5).fill(['stall', 10000]),
  ...Array(2).fill(['half_open', 40000]),
].filter(([k]) => !opt('only') || opt('only').split(',').includes(k)).slice(0, Number(opt('events', 18)))

await phase('reconnect', async () => {
  const runs = []
  for (const [kind, ms] of EVENTS) {
    const load = machineLoad().load
    let back; let detected = null; let redial = null
    if (kind === 'wifi_off' || kind === 'airplane') {
      setNet('down'); await offline(true)
      await sleep(ms)
      setNet('up'); await offline(false)
      back = Date.now()
      net0.rtt = PROFILES.wifi.rtt
    } else if (kind === 'wifi_to_cellular') {
      // A new network: every connection on the old one is gone at once.
      await offline(true); resetAll(); net0.rtt = PROFILES.cellular.rtt
      await sleep(200)
      await offline(false)
      back = Date.now()
    } else {
      // Packets held, no event: the page must notice by itself (stall, half-open).
      const from = Date.now()
      setNet('blackhole')
      if (kind === 'half_open') {
        // Detected when the page gives the silent socket up (closes it to
        // dial again); the redial itself follows after the backoff.
        const end = Date.now() + ms
        while (Date.now() < end && detected === null) {
          await sleep(250)
          const at = await page(`const s = B.sockets.find((x) => x.sid === ${JSON.stringify(SID)} && x.dropped > ${from}); return s ? s.dropped : null`)
          if (at !== null) detected = Math.round(at - from)
        }
        for (let i = 0; i < 40 && redial === null && detected !== null; i++) {
          redial = await page(`const s = B.sockets.find((x) => x.sid === ${JSON.stringify(SID)} && x.created > ${from}); return s ? s.created : null`)
          if (redial === null) await sleep(250)
        }
        if (redial !== null) redial = Math.round(redial - from)
        const rest = from + ms - Date.now()
        if (rest > 0) await sleep(rest)
      } else await sleep(ms)
      setNet('up')
      back = Date.now()
      net0.rtt = PROFILES.wifi.rtt
    }
    const ms2 = await backToLive(back)
    runs.push({ kind, down_ms: ms, back_to_live_ms: ms2, half_open_detected_ms: kind === 'half_open' ? detected : undefined, half_open_redial_ms: kind === 'half_open' ? redial : undefined, load })
    log('event', kind, ms2, detected ?? '')
    await sleep(2000)
  }
  const v = runs.map((r) => r.back_to_live_ms)
  const ho = runs.filter((r) => r.kind === 'half_open').map((r) => r.half_open_detected_ms)
  return { runs, back_to_live_p50: median(v), back_to_live_p95: pct(v, 0.95), back_to_live_max: pct(v, 1), failed: v.filter((x) => x === null).length, half_open_detected_ms: ho }
})

lps(-1)
R.load_after = machineLoad()
writeFileSync(OUT, JSON.stringify(R, null, 2))
ws.close()
chrome.kill()
try { execSync(`pkill -f -- '--user-data-dir=${profile}'`) } catch { /* gone */ }
await sleep(500)
rmSync(profile, { recursive: true, force: true })
proxy.close()
log('wrote', OUT)
process.exit(0)
