// The benchmark's page hook (bench/README.md). It runs before the page's own
// scripts: in the app as the snapshot build's init script
// ($CAPROCK_APP_SNAPSHOT_DIR/init.js), in Chrome through CDP
// Page.addScriptToEvaluateOnNewDocument. The harness prepends
//   window.__BENCH_CFG__ = { daemonPort, collector?, autoEcho? }
//
// - Terminals register themselves in window.__caprockBench.terms by session id
//   (ui/src/lib/benchhook.ts), which is how a paint is timed: xterm's own
//   write callback, the next animation frame, a task after it.
// - WebSocket is wrapped so that each /term socket is watched for the fake
//   claude's echo "> <typed>\x1b" (bench/fake-claude).
// - Input goes in through the page: a keydown and keypress on xterm's own
//   textarea, as the keyboard would deliver them, or term.input() when xterm
//   did not take the synthetic event. Never the OS keyboard.
// - With `collector`, the page long-polls the harness for scripts to run and
//   posts their results back (the app has no CDP).
// Ported from the Tauri spike's term/main.ts and bench/web.mjs hooks.
;(() => {
  const CFG = window.__BENCH_CFG__ || {}
  if (location.protocol !== 'http:' || location.hostname !== '127.0.0.1') return
  if (CFG.daemonPort && Number(location.port) !== CFG.daemonPort) return
  const B = (window.__caprockBench = { terms: new Map(), waits: new Map(), sockets: [], lag: null, cfg: CFG })
  const now = () => performance.now()
  const epoch = () => performance.timeOrigin + performance.now()
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  B.sleep = sleep
  B.epoch = epoch

  const latin1 = (u8) => {
    let s = ''
    for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192))
    return s
  }
  const W = window.WebSocket
  function Hooked(u, p) {
    const sock = p === undefined ? new W(u) : new W(u, p)
    const m = String(u).match(/\/v1\/agents\/([^/?]+)\/term/)
    if (m) {
      const sid = decodeURIComponent(m[1])
      const rec = { sid, created: epoch(), open: null, closed: null, dropped: null }
      B.sockets.push(rec)
      // The moment the page gives the socket up, before the close handshake.
      const close = sock.close.bind(sock)
      sock.close = (...a) => { if (rec.dropped === null) rec.dropped = epoch(); return close(...a) }
      sock.addEventListener('open', () => { rec.open = epoch() })
      sock.addEventListener('close', () => { rec.closed = epoch() })
      // Registered before the client's own onmessage, so it runs first; the
      // paint is waited for a task later (see paintAfter).
      sock.addEventListener('message', (e) => {
        const w = B.waits.get(sid)
        if (!w || typeof e.data === 'string') return
        w.buf += latin1(new Uint8Array(e.data))
        if (w.buf.length > 65536) w.buf = w.buf.slice(-65536)
        if (!w.buf.includes(w.expect)) return
        B.waits.delete(sid)
        w.done(now())
      })
    }
    return sock
  }
  Hooked.prototype = W.prototype
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Hooked[k] = W[k]
  window.WebSocket = Hooked

  /** Resolves with the arrival time of `expect` on sid's socket, or null after `ms`. */
  B.expect = (sid, expect, ms = 3000) => new Promise((resolve) => {
    const timer = setTimeout(() => { if (B.waits.get(sid) === w) B.waits.delete(sid); resolve(null) }, ms)
    const w = { expect, buf: '', done: (at) => { clearTimeout(timer); resolve(at) } }
    B.waits.set(sid, w)
  })
  /** After the client's handler wrote what arrived: xterm parsed it, a frame ran, a task after it. */
  B.paintAfter = (sid) => new Promise((resolve) => setTimeout(() => {
    const term = B.terms.get(sid)
    const frame = () => requestAnimationFrame(() => setTimeout(() => resolve(now()), 0))
    if (term) term.write('', frame)
    else frame()
  }, 0))

  const KEYCODES = { '\r': 13 }
  /** Types one character into sid's terminal through the page. Returns the path used. */
  B.type = (sid, c) => {
    const term = B.terms.get(sid)
    if (!term) return null
    let took = false
    const sub = term.onData(() => { took = true })
    const ta = term.textarea
    if (ta && B.keyPath !== 'input') {
      const code = KEYCODES[c] || c.toUpperCase().charCodeAt(0)
      const init = { key: c === '\r' ? 'Enter' : c, code: c === '\r' ? 'Enter' : 'Key' + c.toUpperCase(), keyCode: code, which: code, bubbles: true, cancelable: true }
      ta.dispatchEvent(new KeyboardEvent('keydown', init))
      if (!took && c !== '\r') ta.dispatchEvent(new KeyboardEvent('keypress', { ...init, keyCode: c.charCodeAt(0), which: c.charCodeAt(0), charCode: c.charCodeAt(0) }))
    }
    sub.dispose()
    if (took) { B.keyPath = 'keydown'; return 'keydown' }
    term.input(c, true)
    B.keyPath = 'input'
    return 'input'
  }

  /** One keystroke to the frame that shows its echo: {key, sock, paint} in page ms, or null. */
  B.echo = async (sid, c, typed, ms = 3000) => {
    const arrived = B.expect(sid, '> ' + typed + '\x1b', ms)
    const key = now()
    B.type(sid, c)
    const sock = await arrived
    if (sock === null) return null
    const paint = await B.paintAfter(sid)
    return { key, sock, paint }
  }

  /** `n` keystrokes at a human pace; a carriage return every 20 resets the fake's line. */
  B.typing = async (sid, n, gap = [120, 200]) => {
    const paint = []; const sock = []; let timeouts = 0; let typed = ''
    const abc = 'abcdefghijklmnopqrstuvwxyz'
    for (let i = 0; i < n; i++) {
      if (i % 20 === 0) { B.waits.delete(sid); B.type(sid, '\r'); typed = ''; await sleep(300) }
      const c = abc[Math.floor(Math.random() * 26)]
      typed += c
      const r = await B.echo(sid, c, typed)
      if (r) { paint.push(r.paint - r.key); sock.push(r.sock - r.key) } else timeouts++
      await sleep(gap[0] + Math.random() * (gap[1] - gap[0]))
    }
    return { n: paint.length, timeouts, key_path: B.keyPath, paint_ms: paint.map((x) => Math.round(x * 10) / 10), socket_ms: sock.map((x) => Math.round(x * 10) / 10) }
  }

  /**
   * Types a fresh nonce every 100 ms until its echo is painted in sid's
   * terminal (the terminal may not exist yet). Resolves with the epoch ms of
   * that paint, or null after `ms`.
   */
  B.firstEcho = async (sid, ms = 30000) => {
    const end = now() + ms
    const nonce = Array.from({ length: 5 }, () => 'abcdefghijklmnopqrstuvwyz'[Math.floor(Math.random() * 25)]).join('')
    let found = null
    const arrived = B.expect(sid, nonce, ms).then((at) => { found = at })
    while (found === null && now() < end) {
      if (B.terms.get(sid)) for (const c of nonce) B.type(sid, c)
      await Promise.race([arrived, sleep(100)])
    }
    if (found === null) return null
    await B.paintAfter(sid)
    return epoch()
  }

  /**
   * Main-thread stalls: a 16 ms interval timer; a gap between two ticks is at
   * least as long as the longest task in it. WebKit has no Long Tasks API, so
   * this is the same measure in both browsers. Off unless started, so idle
   * CPU rows are not charged for it.
   */
  B.lagStart = () => {
    B.lagStop()
    const lag = { max: 0, over50: 0, over100: 0, over250: 0, ticks: 0, last: now(), timer: 0 }
    lag.timer = setInterval(() => {
      const t = now(); const gap = t - lag.last; lag.last = t; lag.ticks++
      if (gap > lag.max) lag.max = gap
      if (gap > 50) lag.over50++
      if (gap > 100) lag.over100++
      if (gap > 250) lag.over250++
    }, 16)
    B.lag = lag
  }
  B.lagStop = () => {
    const l = B.lag
    if (!l) return null
    clearInterval(l.timer)
    B.lag = null
    return { max_gap_ms: Math.round(l.max), gaps_over_50ms: l.over50, gaps_over_100ms: l.over100, gaps_over_250ms: l.over250, ticks: l.ticks }
  }

  /** Resolves when `fn()` is truthy, checked every frame; epoch ms after the next frame, or null. */
  B.when = (fn, ms = 30000) => new Promise((resolve) => {
    const end = now() + ms
    const check = () => {
      let ok = false
      try { ok = !!fn() } catch { /* not yet */ }
      if (ok) { requestAnimationFrame(() => setTimeout(() => resolve(epoch()), 0)); return }
      if (now() > end) { resolve(null); return }
      requestAnimationFrame(check)
    }
    check()
  })

  const post = (path, body) => fetch(CFG.collector + path, { method: 'POST', body: JSON.stringify(body) }).catch(() => {})
  B.post = post
  if (!CFG.collector) return
  const pageId = Math.random().toString(36).slice(2)
  post('/event', { kind: 'boot', page: pageId, at: epoch(), href: location.href })
  // Interactive: the app's workspace is drawn (its projects sidebar).
  B.when(() => document.querySelector('aside[aria-label="Projects"]'), 60000)
    .then((at) => post('/event', { kind: 'interactive', page: pageId, at, href: location.href }))
  if (CFG.autoEcho) {
    B.firstEcho(CFG.autoEcho, 60000).then((at) => post('/event', { kind: 'restored-echo', page: pageId, at, sid: CFG.autoEcho }))
  }
  B.quietUntil = 0
  B.quiet = (ms) => { B.quietUntil = Date.now() + ms }
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
  ;(async () => {
    for (;;) {
      // B.quiet(ms): no request to the harness for a while, so a CPU window
      // measures the app and not this loop.
      if (B.quietUntil > Date.now()) { await sleep(B.quietUntil - Date.now()); continue }
      try {
        const r = await fetch(`${CFG.collector}/next?page=${pageId}`)
        if (r.status !== 200) { await sleep(r.status === 204 ? 0 : 500); continue }
        const { id, src } = await r.json()
        let out
        try { out = { ok: true, value: await new AsyncFunction('B', src)(B) } } catch (e) { out = { ok: false, error: String((e && e.stack) || e) } }
        await post(`/result?id=${id}`, out)
      } catch {
        await sleep(500)
      }
    }
  })()
})()
