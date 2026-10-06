// The reference-app runs (WP-16): Orca on the same Mac, with its version.
// NOT RUN YET. Orca holds the owner's live sessions; run this only when the
// owner allows it, with Orca quit beforehand.
//
// usage: ORCA_BENCH_OK=1 node reference-orca.mjs --out <file.json> [--work DIR] [--runs 3]
//
// It never touches the owner's Orca profile: each launch gets its own
// --user-data-dir under --work (Electron's flag), opened in the background
// (open -g -n). What it measures, per launch:
//   - cold start: launch to the first page's load event (CDP, Electron's
//     --remote-debugging-port), the same stop point as app.mjs's "interactive"
//     only approximately (Orca's own UI decides when it is usable),
//   - idle memory and CPU of every Orca process over 60 s (procs.py, its
//     bundle's executables and the processes macOS charges to it),
//   - disk written in the first two minutes after launch.
// Not scripted, because they need a hook into Orca's terminal that only Orca's
// code could provide: echo latency at three loads, open and switch, 10 tabs,
// flood isolation, phone reconnect. These stay "not measured" for Orca until
// someone drives them by hand or Orca exposes a hook; no figure is published
// without a measurement (rule 6).
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { machineInfo, machineLoad, procs, sleep, median } from './lib.mjs'

const argv = process.argv.slice(2)
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d }
const ORCA = opt('app', '/Applications/Orca.app')
const OUT = opt('out')
const WORK = opt('work', join(process.env.TMPDIR || '/tmp', 'caprock-bench-orca'))
const RUNS = Number(opt('runs', 3))
if (process.env.ORCA_BENCH_OK !== '1' || !OUT) {
  console.error('Refusing: Orca holds the owner\'s sessions. Quit Orca, then run with ORCA_BENCH_OK=1 --out <file.json>.')
  process.exit(2)
}
const running = () => { try { return execFileSync('pgrep', ['-f', `${ORCA}/Contents/MacOS/`], { encoding: 'utf8' }).trim() } catch { return '' } }
if (running()) { console.error('Refusing: Orca is running. Quit it first; this script never quits it for you.'); process.exit(2) }
const plist = (k) => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${k}`, join(ORCA, 'Contents/Info.plist')], { encoding: 'utf8' }).trim()
const R = { harness: 'reference-orca', machine: machineInfo(), app: { path: ORCA, bundle_id: plist('CFBundleIdentifier'), version: plist('CFBundleShortVersionString') }, runs: [] }

for (let r = 0; r < RUNS; r++) {
  const profile = join(WORK, `profile-${Date.now()}`)
  mkdirSync(profile, { recursive: true })
  const cdp = 9500 + Math.floor(Math.random() * 400)
  const load = machineLoad()
  const t0 = Date.now()
  spawn('open', ['-g', '-n', '-a', ORCA, '--args', `--user-data-dir=${profile}`, `--remote-debugging-port=${cdp}`], { stdio: 'ignore' })
  let loaded = null
  for (let i = 0; i < 300 && !loaded; i++) {
    await sleep(100)
    try {
      const pages = (await (await fetch(`http://127.0.0.1:${cdp}/json`)).json()).filter((t) => t.type === 'page')
      if (pages.length) {
        const ws = new WebSocket(pages[0].webSocketDebuggerUrl)
        await new Promise((ok) => { ws.onopen = ok })
        const state = await new Promise((ok) => { ws.onmessage = (m) => ok(JSON.parse(m.data).result?.result?.value); ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'document.readyState', returnByValue: true } })) })
        ws.close()
        if (state === 'complete') loaded = Date.now()
      }
    } catch { /* not up */ }
  }
  const pid = Number(running().split('\n')[0]) || null
  const run = { load, cold_start_to_load_ms: loaded && loaded - t0, pid }
  if (pid) {
    await sleep(10000)
    run.idle = await procs(pid, 60, `${ORCA}/Contents`)
    await sleep(Math.max(0, t0 + 120000 - Date.now()))
    run.first_two_minutes_disk_mb = (await procs(pid, 1, `${ORCA}/Contents`)).disk_written_total_mb
    try { process.kill(pid, 'SIGTERM') } catch { /* gone */ }
    for (let i = 0; i < 100 && running(); i++) await sleep(100)
  }
  R.runs.push(run)
  console.error('orca run', r + 1, run.cold_start_to_load_ms, run.idle?.rss_mb_end, run.idle?.cpu_pct)
  await sleep(3000)
}
R.cold_start_p50 = median(R.runs.map((x) => x.cold_start_to_load_ms))
R.not_measured = ['echo p50/p95 at 0, 200, 1000 lines/s', 'open session', 'switch tab', 'memory with 10 tabs', 'flood isolation', 'phone reconnect']
writeFileSync(OUT, JSON.stringify(R, null, 2))
console.error('wrote', OUT)
