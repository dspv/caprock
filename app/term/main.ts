// Spike: a minimal xterm.js terminal (same addon set as ui/: fit + WebGL) on
// the daemon's WS /v1/agents/{id}/term, plus the typing-benchmark hook.
//
// Injected by the Tauri shell as an initialization script into a same-origin
// document from the daemon (http://127.0.0.1:<port>/manifest.json), so the
// socket's Origin is the daemon's own and the daemon needs no change. In the
// dashboard window only the hook runs (mode "dash").
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import xtermCss from '@xterm/xterm/css/xterm.css?inline'

interface CaprockConfig {
  readonly mode: 'term' | 'dash'
  readonly sid: string
  readonly bench: boolean
  readonly firstExpect: string | null
}

interface BenchState {
  expect: string | null
  buf: string
  first: boolean
  keydown: number | null
  arm: (expect: string | null, first: boolean) => void
  grid: () => void
  tour: (routes: readonly string[]) => Promise<void>
}

type Invoke = (cmd: string, args: Record<string, unknown>) => Promise<unknown>

const cfg = (window as unknown as { __CAPROCK: CaprockConfig }).__CAPROCK
// Date.now(), not timeOrigin + now(): it reads the same wall clock as the Rust
// side's SystemTime. WebKit coarsens both to 1 ms; +0.5 centres the truncation.
// timeOrigin + now() was measured a few ms behind the wall clock in WKWebView.
const epoch = (): number => Date.now() + 0.5
let term: Terminal | null = null

const report = (msg: Record<string, unknown>): void => {
  const inv = (window as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } }).__TAURI_INTERNALS__?.invoke
  if (!inv) { document.title = `noipc:${String(msg.kind)}`; return }
  inv('bench_report', { msg: JSON.stringify({ ...msg, at: epoch() }) }).catch((err: unknown) => { document.title = `ipcerr:${String(err)}` })
}

const currentTerm = (): Terminal | null =>
  term ?? (window as unknown as { __caprockTerm?: Terminal }).__caprockTerm ?? null

const latin1 = (u8: Uint8Array): string => {
  let s = ''
  for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode(...u8.subarray(i, i + 8192))
  return s
}

const installHook = (): BenchState => {
  const B: BenchState = {
    expect: cfg.firstExpect, buf: '', first: true, keydown: null,
    arm: (expect, first) => { B.expect = expect; B.buf = ''; B.first = first; B.keydown = null; report({ kind: 'armed' }) },
    grid: () => {
      const t = currentTerm()
      report({ kind: 'grid', cols: t?.cols, rows: t?.rows, dpr: window.devicePixelRatio, inner: [innerWidth, innerHeight], clock_skew_ms: performance.timeOrigin + performance.now() - Date.now() })
    },
    tour: (routes) => tourDashboard(routes),
  }
  ;(window as unknown as { __bench: BenchState }).__bench = B
  const W = window.WebSocket
  const onTermMessage = (e: MessageEvent): void => {
    if (!B.expect) return
    B.buf += typeof e.data === 'string' ? e.data : latin1(new Uint8Array(e.data as ArrayBuffer))
    if (B.buf.length > 65536) B.buf = B.buf.slice(-65536)
    if (!B.buf.includes(B.expect)) return
    const sock = epoch(); const first = B.first; const keydown = B.keydown
    B.expect = null; B.buf = ''; B.first = false
    // The terminal's own onmessage (term.write) runs after this listener.
    setTimeout(() => currentTerm()?.write('', () => requestAnimationFrame(() => setTimeout(() => {
      report({ kind: first ? 'first' : 'key', sock, paint: epoch(), keydown })
    }, 0))), 0)
  }
  function Hooked(this: unknown, u: string | URL, p?: string | string[]): WebSocket {
    const sock = p === undefined ? new W(u) : new W(u, p)
    if (String(u).includes('/term')) {
      sock.addEventListener('open', () => report({ kind: 'ws_open' }))
      sock.addEventListener('message', onTermMessage)
    }
    return sock
  }
  Hooked.prototype = W.prototype
  Object.assign(Hooked, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })
  window.WebSocket = Hooked as unknown as typeof WebSocket
  window.addEventListener('keydown', () => { if (B.keydown === null) B.keydown = epoch() }, true)
  return B
}

// Every error the page raises, for the WKWebView compatibility check.
const pageErrors: string[] = []
const captureErrors = (): void => {
  window.addEventListener('error', (e) => pageErrors.push(`error: ${e.message} @ ${e.filename}:${e.lineno}`))
  window.addEventListener('unhandledrejection', (e) => pageErrors.push(`rejection: ${String(e.reason)}`))
  const orig = console.error.bind(console)
  console.error = (...a: unknown[]) => { pageErrors.push(`console.error: ${a.map(String).join(' ').slice(0, 300)}`); orig(...a) }
  const warn = console.warn.bind(console)
  console.warn = (...a: unknown[]) => { pageErrors.push(`console.warn: ${a.map(String).join(' ').slice(0, 300)}`); warn(...a) }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Visits each route of the unchanged dashboard and reports what rendered. */
const tourDashboard = async (routes: readonly string[]): Promise<void> => {
  for (const hash of routes) {
    const before = pageErrors.length
    location.hash = hash
    await sleep(hash.includes('terminal') ? 6000 : 2500)
    const main = document.querySelector('main') ?? document.body
    report({
      kind: 'tour', hash,
      boundary_failures: [...document.querySelectorAll('div')].filter((d) => / failed to render$/.test(d.firstElementChild?.textContent ?? '')).length,
      text_chars: main.textContent?.length ?? 0, elements: document.querySelectorAll('*').length,
      xterm: document.querySelectorAll('.xterm').length, xterm_canvases: document.querySelectorAll('.xterm-screen canvas').length,
      font_jetbrains: document.fonts.check('12px "JetBrains Mono Variable"'), font_hanken: document.fonts.check('14px "Hanken Grotesk Variable"'),
      errors: pageErrors.slice(before),
    })
  }
  report({ kind: 'tour_done', css_supports: { has: CSS.supports('selector(:has(a))'), container: CSS.supports('container-type: inline-size'), color_mix: CSS.supports('color: color-mix(in oklab, red, blue)'), oklch: CSS.supports('color: oklch(0.5 0.1 200)') }, apis: { share: typeof navigator.share, clipboard_write: typeof navigator.clipboard?.write, clipboard_write_text: typeof navigator.clipboard?.writeText, notification: typeof (window as unknown as { Notification?: unknown }).Notification, webgl2: !!document.createElement('canvas').getContext('webgl2') } })
}

const timerResolution = (): number => {
  let min = Infinity; let last = performance.now()
  for (let i = 0; i < 200000 && min > 0.001; i++) {
    const t = performance.now()
    if (t !== last) { min = Math.min(min, t - last); last = t }
  }
  return min
}

const mountTerminal = (): void => {
  document.head.innerHTML = `<meta charset="utf-8"><title>Caprock terminal</title><style>${xtermCss}
html,body{margin:0;height:100%;background:#0b0d10;overflow:hidden}#t{position:absolute;inset:6px}</style>`
  document.body.innerHTML = '<div id="t"></div>'
  const t = new Terminal({ fontFamily: 'Menlo, monospace', fontSize: 12, cursorBlink: true, scrollback: 10000, theme: { background: '#0b0d10' } })
  term = t
  const fit = new FitAddon()
  t.loadAddon(fit)
  t.open(document.getElementById('t') as HTMLElement)
  fit.fit()
  t.focus()
  const glStart = performance.now()
  let renderer = 'dom'
  try {
    const gl = new WebglAddon()
    gl.onContextLoss(() => gl.dispose())
    t.loadAddon(gl)
    renderer = 'webgl'
  } catch (err) {
    renderer = `dom (webgl failed: ${String(err)})`
  }
  const glMs = performance.now() - glStart
  const ws = new WebSocket(`ws://${location.host}/v1/agents/${encodeURIComponent(cfg.sid)}/term`)
  ws.binaryType = 'arraybuffer'
  const enc = new TextEncoder()
  const sendSize = (): void => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ resize: { cols: t.cols, rows: t.rows } })) }
  ws.onopen = sendSize
  ws.onmessage = (e: MessageEvent) => t.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data as ArrayBuffer))
  t.onData((d) => { if (ws.readyState === WebSocket.OPEN) ws.send(enc.encode(d)) })
  t.onResize(sendSize)
  new ResizeObserver(() => { try { fit.fit() } catch { /* not laid out */ } }).observe(document.body)
  report({ kind: 'ready', renderer, webgl_ms: glMs, cols: t.cols, rows: t.rows, timer_res_ms: timerResolution(), ua: navigator.userAgent })
}

if (cfg.bench) { installHook(); captureErrors() }
if (cfg.mode === 'term') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountTerminal)
  else mountTerminal()
} else if (cfg.bench) {
  window.addEventListener('load', () => report({ kind: 'ready', ua: navigator.userAgent, timer_res_ms: timerResolution() }))
}
