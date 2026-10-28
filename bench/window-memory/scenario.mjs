// scenario.mjs --stand <dir> --ctl <port> --out <jsonl> [--idle-min 25] [--long <session id>]
// The scripted window-memory scenario (bench/README.md § The window's memory), driving drive.mjs's
// control port; measure.py samples after each step.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d }
const STAND = opt('stand'); const CTL = Number(opt('ctl', 47311)); const OUT = opt('out')
const IDLE_MIN = Number(opt('idle-min', 25))
// A long ended session in the stand's database, opened as a read-only chat tab.
const LONG = opt('long', '')
if (!STAND || !OUT || !LONG) { console.error('usage: node scenario.mjs --stand <dir> --out <jsonl> --long <session id>'); process.exit(2) }
const SIDS = readFileSync(join(STAND, 'sids'), 'utf8').trim().split('\n')
const VM = OUT.replace(/\.jsonl$/, '-vmmap')
mkdirSync(VM, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a)
const run = async (src, ms = 120000) => {
  const r = await fetch(`http://127.0.0.1:${CTL}/run?ms=${ms}`, { method: 'POST', body: src })
  const t = await r.text()
  if (!r.ok) throw new Error(t)
  return JSON.parse(t)
}
const pid = Number(readFileSync(join(STAND, 'app.pid'), 'utf8'))
const measure = (label, vm = false) => {
  const out = execFileSync('python3', [join(import.meta.dirname, 'measure.py'), String(pid), label, OUT, ...(vm ? ['--vmmap', VM] : [])], { encoding: 'utf8' })
  process.stdout.write(out)
}
const lps = (i, rate) => writeFileSync(join(STAND, 'work', `s${String(i + 1).padStart(2, '0')}`, '.fake_lps'), String(rate))
SIDS.forEach((_, i) => lps(i, i < 2 ? 5 : 0))

// The long session as an observe tab, seeded before the run starts (a
// reload): it sits in the strip, unopened, until step "long chat".
const seeded = await run(`
  const k = 'caprock.app.workspace.v1'
  const ws = JSON.parse(localStorage.getItem(k) || '{"version":1,"tabs":[],"activeByProject":{},"activeProject":""}')
  if (!ws.tabs.some((t) => t.root?.target?.sessionId === ${JSON.stringify(LONG)})) {
    ws.tabs.push({ id: 'tab-long', projectId: 'other-folders', root: { type: 'pane', id: 'pane-long', target: { kind: 'observe', sessionId: ${JSON.stringify(LONG)} } }, focusedPaneId: 'pane-long', title: 'long session' })
    localStorage.setItem(k, JSON.stringify(ws))
    setTimeout(() => location.reload(), 100)
    return 'reloading'
  }
  return 'present'`)
log('seed', seeded)
if (seeded === 'reloading') { await sleep(8000); await run(`return 1`, 60000) }
// Page helpers (window.M), defined after the reload.
await run(`
  window.M = window.M || {}
  M.open = async (sid) => {
    let el = document.querySelector('[data-tab-row][data-session-id="' + sid + '"]') || document.querySelector('[data-live-row="' + sid + '"]')
    if (!el) {
      const more = [...document.querySelectorAll('button')].find((x) => /^Background/.test(x.innerText.trim()))
      if (more) { more.click(); await B.sleep(500) }
      el = document.querySelector('[data-tab-row][data-session-id="' + sid + '"]') || document.querySelector('[data-live-row="' + sid + '"]')
    }
    if (!el) return 'missing ' + sid
    el.click()
    return 'ok'
  }
  M.stats = () => ({ dom: document.querySelectorAll('*').length, canvases: document.querySelectorAll('canvas').length, imgs: document.querySelectorAll('img').length, terms: B.terms.size, hash: location.hash })
  return 1`)
const stats = async (label) => log(label, JSON.stringify(await run('return M.stats()')))

await sleep(20000)
measure('0 start (Home)', true); await stats('start')

const openN = async (from, to) => {
  for (let i = from; i < to; i++) {
    const r = await run(`return M.open(${JSON.stringify(SIDS[i])})`)
    if (r !== 'ok') log('open', i, r)
    await sleep(4000)
  }
}
await openN(0, 1); await sleep(10000)
measure('1 tab', true); await stats('1 tab')
await openN(1, 4); await sleep(10000)
measure('4 tabs', true); await stats('4 tabs')
await openN(4, 8); await sleep(10000)
measure('8 tabs', true); await stats('8 tabs')

// Switch around: two rounds over the eight tabs in a shuffled order.
for (let round = 0; round < 2; round++) {
  const order = SIDS.map((s, i) => [Math.sin(i * 7 + round) , s]).sort((a, b) => a[0] - b[0]).map((x) => x[1])
  for (const s of order) { await run(`return M.open(${JSON.stringify(s)})`); await sleep(1500) }
}
await sleep(5000)
measure('8 tabs, switched', true); await stats('switched')

// The long session's chat (an observe tab).
log('long chat', await run(`
  const el = document.querySelector('[data-tab-row][data-session-id="${LONG}"]') || [...document.querySelectorAll('[data-tab-row]')].find((r) => /long session/.test(r.innerText))
  if (!el) return 'missing'
  el.click(); return 'ok'`))
await sleep(20000)
measure('long chat', true); await stats('long chat')

// The Dashboard tab: Home, then the long session's page, then back to a terminal.
log('dashboard', await run(`
  const b = [...document.querySelectorAll('button,a')].find((x) => x.innerText.trim().startsWith('Dashboard'))
  if (!b) return 'missing'
  b.click(); await B.sleep(8000)
  location.hash = '#/session/${LONG}'
  await B.sleep(12000)
  return location.hash`, 60000))
measure('dashboard + session page', true); await stats('dashboard')
await run(`return M.open(${JSON.stringify(SIDS[0])})`)
await sleep(10000)
measure('back to tab 1', true); await stats('back')

// Left alone, tab 1 in front.
for (let m = 5; m <= IDLE_MIN; m += 5) {
  await sleep(5 * 60000)
  measure(`idle ${m} min`, m === IDLE_MIN); await stats(`idle ${m}`)
}
log('done')
