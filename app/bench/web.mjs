// Typing benchmark for the web terminal, symmetric with the native app's Bench.swift.
// usage: node web.mjs <port> <session-id> <label> <keys> [watchSeconds]
//
// A headed Chrome with its own profile opens the session's Terminal tab. The
// page gets a hook (before any script runs) that wraps WebSocket and waits for
// the fake claude's echo "> <typed>\x1b" on the /term socket. For each key:
//   key    = the keydown event's timeStamp (capture listener on window)
//   socket = the echo's frame arrived in the page
//   paint  = xterm has parsed everything queued (term.write('', cb)), then the
//            next animation frame ran, then a task after it — the frame was produced.
// Keys are CDP Input.dispatchKeyEvent, the same path prof.mjs (PR #171) used.
// The dashboard build is master/PR #171 plus one line that exposes the xterm
// instance as window.__caprockTerm (BENCH ONLY); nothing else differs.
import { spawn, execSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [port, sid, label, keysArg, watchArg] = process.argv.slice(2)
const KEYS = Number(keysArg || 60)
const WATCH = Number(watchArg || 20)
const cdpPort = 9300 + Math.floor(Math.random() * 400)
const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'chr-macspike-'))
// Headless (new headless: the full browser, no window). A headed Chrome takes
// the foreground on launch even with \`open -g\`, and this bench must never
// take focus from the person at the machine. CDP input stays inside it. The
// 2026-10-04 run in macos/ was headed.
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new',
  `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${dir}`, '--window-size=1400,900', '--window-position=40,40',
  '--no-first-run', '--no-default-browser-check',
  // The window must count as visible even if another window covers it, or rAF stops.
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
  'about:blank',
], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let targets
for (let i = 0; i < 100; i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); if (targets.find((t) => t.type === 'page')) break } catch { /* not up */ }
  await sleep(200)
}
const page = targets.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let id = 0
const pending = new Map()
const bindings = []
ws.onmessage = (m) => {
  const d = JSON.parse(m.data)
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result ?? d.error); pending.delete(d.id) }
  else if (d.method === 'Runtime.bindingCalled') bindings.push({ name: d.params.name, payload: JSON.parse(d.params.payload), at: performance.now() })
}
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
const evalJS = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value

const nonce = Array.from({ length: 4 }, () => 'abcdefghijklmnopqrstuvwyz'[Math.floor(Math.random() * 25)]).join('')
const hook = `(() => {
  const B = window.__bench = { expect: ${JSON.stringify(nonce)}, buf: '', key: 0, armKey: false, first: true };
  const latin1 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192)); return s };
  const W = window.WebSocket;
  function Hooked(u, p) {
    const sock = p === undefined ? new W(u) : new W(u, p);
    if (String(u).includes('/term')) {
      B.wsCreated = performance.now();
      sock.addEventListener('open', () => { B.wsOpen = performance.now() });
      sock.addEventListener('message', () => { if (!B.firstMsg) B.firstMsg = performance.now() });
    }
    if (String(u).includes('/term')) sock.addEventListener('message', (e) => {
      if (!B.expect) return;
      B.buf += typeof e.data === 'string' ? e.data : latin1(new Uint8Array(e.data));
      if (B.buf.length > 65536) B.buf = B.buf.slice(-65536);
      if (!B.buf.includes(B.expect)) return;
      const at = performance.now(); const key = B.key; const first = B.first;
      B.expect = null; B.buf = ''; B.first = false;
      // Terminal.tsx's own onmessage (term.write) runs after this listener.
      setTimeout(() => window.__caprockTerm.write('', () => requestAnimationFrame(() => setTimeout(() => {
        const paint = performance.now();
        (first ? window.__benchFirst : window.__benchKey)(JSON.stringify({ key, sock: at, paint }));
      }, 0))), 0);
    });
    return sock;
  }
  Hooked.prototype = W.prototype;
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Hooked[k] = W[k];
  window.WebSocket = Hooked;
  window.addEventListener('keydown', (e) => { if (B.armKey) { B.key = e.timeStamp; B.armKey = false } }, true);
})()`
await send('Runtime.enable')
await send('Page.enable')
await send('Runtime.addBinding', { name: '__benchFirst' })
await send('Runtime.addBinding', { name: '__benchKey' })
await send('Page.addScriptToEvaluateOnNewDocument', { source: hook })

const typeChar = async (c) => {
  if (c === '\r') {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    return
  }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', text: c, key: c, unmodifiedText: c })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: c })
}

// Warm the cache the way a real browser would have it: load the dashboard once.
await send('Page.navigate', { url: `http://127.0.0.1:${port}/` })
await sleep(4000)
// The session URL differs only in its fragment, so this is a same-document
// route change — what clicking a session in the dashboard does.
await evalJS(`(() => { const B = window.__bench; B.expect = ${JSON.stringify(nonce)}; B.first = true; B.buf = '' })()`)
// Phase 1: navigate, type the nonce every 100 ms (clicking the terminal when it has no focus) until it is echoed.
const t0 = performance.now()
await send('Network.enable')
const netlog = []
const origOn = ws.onmessage
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.method === 'Network.responseReceived' || d.method === 'Network.webSocketCreated') netlog.push([Math.round(performance.now() - t0), d.method === 'Network.webSocketCreated' ? 'ws ' + d.params.url : d.params.response.url.replace(/^http:\/\/[^/]+/, '')]); origOn(m) }
await send('Page.navigate', { url: `http://127.0.0.1:${port}/#/session/${sid}?tab=terminal` })
let clicks = 0
while (!bindings.find((b) => b.name === '__benchFirst') && performance.now() - t0 < 30000) {
  const where = await evalJS(`(() => { if (document.activeElement?.classList.contains('xterm-helper-textarea')) return null; const r = document.querySelector('.xterm')?.getBoundingClientRect(); return r ? [r.x + r.width / 2, r.y + r.height / 2] : null })()`)
  if (where) {
    clicks++
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: where[0], y: where[1], button: 'left', clickCount: 1 })
  }
  for (const c of nonce) await typeChar(c)
  await sleep(100)
}
const first = bindings.find((b) => b.name === '__benchFirst')
const result = {
  client: `web-${label}`,
  nav_to_first_echo_paint_ms: first ? first.at - t0 : null,
  nav_to_first_echo_paint_pageclock_ms: first ? first.payload.paint : null,
  clicks_needed: clicks,
  netlog: process.env.DEBUG ? netlog.slice(0, 40) : undefined,
  page_ws_created_ms: await evalJS('window.__bench.wsCreated'),
  page_ws_open_ms: await evalJS('window.__bench.wsOpen'),
  page_first_output_ms: await evalJS('window.__bench.firstMsg'),
}
await sleep(2000)

// Phase 2: steady echo.
const sockMs = []; const paintMs = []; let timeouts = 0
let typed = ''
for (let i = 0; i < KEYS; i++) {
  if (i % 20 === 0) {
    await evalJS('window.__bench.expect = null')
    await typeChar('\r'); typed = ''
    await sleep(300)
  }
  const c = 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]
  typed += c
  const before = bindings.length
  await evalJS(`(() => { const B = window.__bench; B.buf = ''; B.expect = ${JSON.stringify('> ' + typed + '\x1b')}; B.armKey = true })()`)
  await typeChar(c)
  const until = performance.now() + 3000
  while (bindings.length === before && performance.now() < until) await sleep(2)
  const b = bindings.slice(before).find((x) => x.name === '__benchKey')
  if (b) { sockMs.push(b.payload.sock - b.payload.key); paintMs.push(b.payload.paint - b.payload.key) } else {
    timeouts++
    if (process.env.DEBUG) console.error('timeout', JSON.stringify(await evalJS(`(() => { const B = window.__bench; return { expect: B.expect, tail: JSON.stringify(B.buf.slice(-300)), active: document.activeElement?.className, hasFocus: document.hasFocus(), vis: document.visibilityState } })()`)))
  }
  await sleep(120 + Math.random() * 80)
}
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.round((s.length - 1) * p))] : null }
Object.assign(result, {
  cols: await evalJS('window.__caprockTerm?.cols'), rows: await evalJS('window.__caprockTerm?.rows'),
  n: paintMs.length, timeouts, visibility: await evalJS('document.visibilityState'), focused: await evalJS('document.hasFocus()'),
  socket_p50_ms: pct(sockMs, 0.5), socket_p95_ms: pct(sockMs, 0.95),
  paint_p50_ms: pct(paintMs, 0.5), paint_p95_ms: pct(paintMs, 0.95), paint_max_ms: Math.max(...paintMs),
  paint_ms: paintMs.map((x) => Math.round(x * 10) / 10),
})

// Phase 3: watch the stream for WATCH seconds without typing; CPU time and RSS of every process of this Chrome.
const sample = () => {
  const out = execSync('ps -axo pid=,time=,rss=,command=').toString().split('\n').filter((l) => l.includes(dir))
  let cpu = 0; let rss = 0; const by = {}
  for (const l of out) {
    const [, time, r] = l.trim().split(/\s+/)
    const parts = time.split(':').map(Number)
    const c = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1]
    cpu += c; rss += Number(r)
    const t = (l.match(/--type=([a-z-]+)/) || [, 'browser'])[1] + ((l.match(/--utility-sub-type=([\w.]+)/) || [, ''])[1] ? ':' + l.match(/--utility-sub-type=([\w.]+)/)[1].split('.').pop() : '')
    by[t] = by[t] || { cpu: 0, rss: 0 }; by[t].cpu += c; by[t].rss += Number(r)
  }
  return { cpu, rss, procs: out.length, by }
}
const a = sample(); const wa = performance.now()
let peak = a.rss
for (let i = 0; i < WATCH; i++) { await sleep(1000); peak = Math.max(peak, sample().rss) }
const b = sample(); const wb = performance.now()
Object.assign(result, {
  watch_s: Math.round((wb - wa) / 1000),
  watch_cpu_pct: Math.round(((b.cpu - a.cpu) / ((wb - wa) / 1000)) * 1000) / 10,
  rss_mb_end: Math.round(b.rss / 1024), rss_mb_peak: Math.round(peak / 1024), chrome_processes: b.procs,
  by_type: Object.fromEntries(Object.entries(b.by).map(([k, v]) => [k, { cpu_pct: Math.round(((v.cpu - (a.by[k]?.cpu ?? 0)) / ((wb - wa) / 1000)) * 1000) / 10, rss_mb: Math.round(v.rss / 1024) }])),
})
console.log(JSON.stringify(result, null, 2))
ws.close()
chrome.kill()
try { execSync(`pkill -f -- '--user-data-dir=${dir}'`) } catch { /* gone */ }
await sleep(500)
try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
process.exit(0)
