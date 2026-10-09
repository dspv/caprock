// Typing beside busy agents (bench/README.md): keystroke to painted echo in
// the app workspace while other tabs print and agents send hook events.
//
// usage: node busy.mjs --stand <dir> --port <p> [--label name] [--keys 200]
//          [--hooks 0|1] [--chrome <path>] [--profile out.cpuprofile] [--out file.json]
//
// The stand is busy-stand.sh's: nine tabs over three projects, one printing
// 20 lines a second. The page is the workspace (`/?app=1`) in a headless
// Chrome over CDP, 1440x900, GPU on; the restored workspace opens all nine
// tabs with alpha's first (a silent fake claude) in front. With --hooks 1,
// four made-up agents in the three projects send a PreToolUse or PostToolUse
// to /v1/hook every 200 ms, as a shim would, for the whole run.
//
// Keystrokes go in through the page (page-hook.js): echo is from the key
// event to the frame after xterm parsed the fake's "> <typed>". Alongside:
// the page's main-thread time (CDP Performance.getMetrics, as a share of the
// run), Long Tasks, the 16 ms timer's gaps, and React commits — the commit
// count always, which components re-rendered only in a build whose names
// survive (`npx vite build --minify false`).
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HERE, pct, sleep } from './lib.mjs'

const argv = process.argv.slice(2)
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d }
const STAND = opt('stand'); const PORT = Number(opt('port')); const LABEL = opt('label', 'run')
const KEYS = Number(opt('keys', 200)); const HOOKS = opt('hooks', '1') === '1'; const PROFILE = opt('profile'); const OUT = opt('out')
if (!STAND || !PORT) { console.error('usage: node busy.mjs --stand <dir> --port <p> [--hooks 0|1] [--keys 200]'); process.exit(2) }

/** Playwright's headless shell, never the user's own Chrome. */
function defaultChrome() {
  const cache = join(process.env.HOME || '', 'Library/Caches/ms-playwright')
  if (!existsSync(cache)) return ''
  const shells = readdirSync(cache).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse()
  for (const d of shells) {
    const p = join(cache, d, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell')
    if (existsSync(p)) return p
  }
  return ''
}
const CHROME = opt('chrome', process.env.CHROME || defaultChrome())
if (!CHROME) { console.error('no headless shell: pass --chrome (npx playwright install chromium-headless-shell)'); process.exit(2) }
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), LABEL, ...a)

const tabs = readFileSync(join(STAND, 'tabs'), 'utf8').trim().split('\n').map((l) => {
  const [pid, kind, sid, name, cwd] = l.split(' ')
  return { pid, kind, sid, name, cwd }
})
const workspace = {
  version: 1,
  tabs: tabs.map((t, i) => ({ id: `t${i}`, projectId: t.pid, root: { type: 'pane', id: `p${i}`, target: { kind: t.kind, sessionId: t.sid } }, focusedPaneId: `p${i}`, title: t.name })),
  activeByProject: { [tabs[0].pid]: 't0', [tabs[3].pid]: 't3', [tabs[6].pid]: 't6' },
  activeProject: tabs[0].pid,
}
const typed = tabs[0].sid
const token = JSON.parse(readFileSync(join(STAND, 'data', 'runtime.json'), 'utf8')).token

const cdpPort = 9500 + Math.floor(Math.random() * 400)
const profileDir = mkdtempSync(join(process.env.TMPDIR || '/tmp', 'caprock-busy-'))
const chrome = spawn(CHROME, [`--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profileDir}`, '--no-first-run',
  '--window-size=1440,900', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', 'about:blank'], { stdio: 'ignore' })
let targets = []
for (let i = 0; i < 100; i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); if (targets.find((t) => t.type === 'page')) break } catch { /* not up yet */ }
  await sleep(200)
}
const sock = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
await new Promise((r) => { sock.onopen = r })
let nid = 0
const waiting = new Map()
sock.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id) } }
const cdp = (method, params = {}) => new Promise((res) => { const id = ++nid; waiting.set(id, res); sock.send(JSON.stringify({ id, method, params })) })
const evaluate = async (expr) => {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500))
  return r.result?.result?.value
}

const hook = `window.__BENCH_CFG__ = ${JSON.stringify({ daemonPort: PORT })};\n` + readFileSync(join(HERE, 'page-hook.js'), 'utf8')
// The workspace to restore, a Long Tasks counter, and a stand-in for React's
// devtools hook that counts commits (and, where names survive, which
// components re-rendered).
const seed = `try { if (!localStorage.getItem('caprock.app.workspace.v1')) localStorage.setItem('caprock.app.workspace.v1', ${JSON.stringify(JSON.stringify(workspace))}) } catch {}
window.__lt = { on: false, n: 0, total: 0, max: 0 };
window.__rc = { on: false, commits: 0, panes: 0, shells: 0 };
window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber: true, renderers: new Map(), inject() { return 1 }, checkDCE() {}, onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
  onCommitFiberRoot(id, root) { const rc = window.__rc; if (!rc.on) return; rc.commits++;
    const walk = (f) => { for (; f; f = f.sibling) { const n = f.type && (f.type.displayName || f.type.name);
      if (f.alternate && (f.memoizedProps !== f.alternate.memoizedProps || f.memoizedState !== f.alternate.memoizedState)) { if (n === 'TerminalPane') rc.panes++; if (n === 'AppShell') rc.shells++ }
      walk(f.child) } };
    walk(root.current.child) } };
try { new PerformanceObserver((l) => { for (const e of l.getEntries()) { const lt = window.__lt; if (!lt.on) continue; lt.n++; lt.total += e.duration; lt.max = Math.max(lt.max, e.duration) } }).observe({ type: 'longtask' }) } catch {}`
await cdp('Page.enable')
await cdp('Performance.enable')
await cdp('Runtime.enable')
await cdp('Page.addScriptToEvaluateOnNewDocument', { source: seed })
await cdp('Page.addScriptToEvaluateOnNewDocument', { source: hook })
await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/?app=1#/app` })
const ok = await evaluate(`(async () => { for (let i = 0; i < 300; i++) { if (window.__caprockBench?.terms?.get(${JSON.stringify(typed)})) return true; await new Promise(r => setTimeout(r, 100)) } return false })()`)
if (!ok) { log('the typed terminal never registered'); chrome.kill('SIGKILL'); process.exit(1) }
const gl = await evaluate(`(() => { const c = document.createElement('canvas').getContext('webgl2'); if (!c) return 'no webgl2'; const e = c.getExtension('WEBGL_debug_renderer_info'); return e ? c.getParameter(e.UNMASKED_RENDERER_WEBGL) : c.getParameter(c.RENDERER) })()`)
const terminals = await evaluate('window.__caprockBench.terms.size')
log('webgl', gl, 'terminals', terminals)

// Four agents at work across the three projects: one hook event every 200 ms.
let hookN = 0
let hookTimer = null
const agents = [0, 2, 3, 6].map((i, k) => ({ sid: `busy-agent-${k}`, cwd: tabs[i].cwd }))
const postHook = (body) => fetch(`http://127.0.0.1:${PORT}/v1/hook`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
}).catch(() => {})
if (HOOKS) {
  for (const a of agents) await postHook({ session_id: a.sid, transcript_path: join(a.cwd, 'none.jsonl'), cwd: a.cwd, hook_event_name: 'SessionStart', source: 'startup' })
  hookTimer = setInterval(() => {
    const a = agents[hookN % agents.length]
    const event = (hookN >> 2) % 2 === 0 ? 'PreToolUse' : 'PostToolUse'
    hookN++
    void postHook({ session_id: a.sid, transcript_path: join(a.cwd, 'none.jsonl'), cwd: a.cwd, hook_event_name: event, tool_name: 'Bash',
      tool_input: { command: `go test ./... #${hookN}` }, tool_use_id: `t${hookN}`, ...(event === 'PostToolUse' ? { tool_response: 'ok' } : {}) })
  }, 200)
}
// WebGL swaps in after a quiet moment; let the page settle under the load.
await sleep(8000)

const metrics = async () => Object.fromEntries((await cdp('Performance.getMetrics')).result.metrics.map((m) => [m.name, m.value]))
if (PROFILE) { await cdp('Profiler.enable'); await cdp('Profiler.setSamplingInterval', { interval: 200 }); await cdp('Profiler.start') }
const m0 = await metrics()
await evaluate('Object.assign(window.__lt, { on: true, n: 0, total: 0, max: 0 }); Object.assign(window.__rc, { on: true, commits: 0, panes: 0, shells: 0 }); window.__caprockBench.lagStart(); true')
const res = await evaluate(`window.__caprockBench.typing(${JSON.stringify(typed)}, ${KEYS})`)
const m1 = await metrics()
const lag = await evaluate('window.__caprockBench.lagStop()')
const longtasks = await evaluate('({ n: window.__lt.n, total_ms: Math.round(window.__lt.total), max_ms: Math.round(window.__lt.max) })')
const react = await evaluate('({ commits: window.__rc.commits, pane_renders: window.__rc.panes, shell_renders: window.__rc.shells })')
if (PROFILE) writeFileSync(PROFILE, JSON.stringify((await cdp('Profiler.stop')).result.profile))
if (hookTimer) clearInterval(hookTimer)
const secs = m1.Timestamp - m0.Timestamp
const share = (k) => Math.round(((m1[k] - m0[k]) / secs) * 1000) / 10
const out = {
  label: LABEL, hooks: HOOKS, hook_events: hookN, terminals, webgl: gl, key_path: res.key_path, n: res.n, timeouts: res.timeouts,
  echo_p50_ms: pct(res.paint_ms, 0.5), echo_p95_ms: pct(res.paint_ms, 0.95), echo_max_ms: pct(res.paint_ms, 1),
  socket_p50_ms: pct(res.socket_ms, 0.5), socket_p95_ms: pct(res.socket_ms, 0.95),
  main_thread_pct: { task: share('TaskDuration'), script: share('ScriptDuration'), style: share('RecalcStyleDuration'), layout: share('LayoutDuration') },
  style_recalcs_per_s: Math.round((m1.RecalcStyleCount - m0.RecalcStyleCount) / secs),
  longtasks, lag, react, seconds: Math.round(secs),
}
console.log(JSON.stringify(out))
if (OUT) writeFileSync(OUT, JSON.stringify({ ...out, paint_ms: res.paint_ms, socket_ms: res.socket_ms }, null, 1))
chrome.kill('SIGKILL')
process.exit(0)
