/**
 * The footprint (.ai/03-contracts.md § Footprint): what Caprock itself costs
 * this machine — memory and CPU of every Caprock process, the data directory
 * on disk, the daemon's own disk reads and writes — and the duplicate or
 * orphaned Caprock processes that make it cost more, so a person can tell at
 * a glance whether a slow machine is Caprock or not. The status strip shows
 * the two totals and opens the rest (FootprintPanel.tsx), which is `caprock
 * doctor` in the window: *Copy report* builds the same text the command
 * prints, pinned to it by one fixture (testdata/footprint/).
 */
import { api } from './api'
import { useApi } from './useApi'
import { fmtCPU, fmtMem, type ProcGroup, type ProcUsage } from './resources'

export interface CaprockProc {
  pid: number
  exe?: string
  /** The data directory a daemon was started with; absent for the default. */
  data_dir?: string
  mem_bytes: number
  started_at?: number
}

export interface IOWindow {
  read_bytes: number
  write_bytes: number
  seconds: number
}

export interface FootprintVerdict {
  level: 'ok' | 'warn'
  code: string
  text: string
}

export interface Footprint {
  at: number
  daemon_running: boolean
  data_dir: string
  exe?: string
  memory: {
    daemon?: ProcUsage
    app?: ProcUsage
    webview?: ProcGroup
    hosts: { count: number; mem_bytes: number; cpu_pct: number; orphans: number; reapable: number }
    other_daemons_mem_bytes: number
    total_mem_bytes: number
    total_cpu_pct: number
  }
  disk: {
    total_bytes: number
    /** caprock.db with its -wal and -shm; `wal_bytes` is the -wal alone. */
    database_bytes: number
    wal_bytes: number
    pastes_bytes: number
    logs_bytes: number
    binaries_bytes: number
    other_bytes: number
  }
  /** The daemon's own reads and writes; absent in an offline report. */
  disk_io?: {
    interval_s: number
    samples: number
    last_minute?: IOWindow
    last_hour?: IOWindow
    since_start?: IOWindow
    error?: string
  }
  duplicates: {
    daemons: CaprockProc[] | null
    apps: CaprockProc[] | null
    other_install_holders: { count: number; orphans: number; exes: { exe: string; count: number }[] | null }
  }
  verdicts: FootprintVerdict[] | null
  /** What the daemon did about its footprint on its own, oldest first. */
  actions: { at: number; what: string }[] | null
  error?: string
}

/** Asked every 10 s while the page is visible; a hidden window asks nothing (lib/visible.ts). */
export const FOOTPRINT_POLL_MS = 10_000

/** The latest footprint, or undefined before the first answer and from a daemon without the endpoint. */
export function useFootprint() {
  return useApi(() => api.footprint(), [], { live: false, intervalMs: FOOTPRINT_POLL_MS, keepUnchanged: true })
}

/** "2.2 GB", "340 MB", "12 KB": a size on disk, in the binary units fmtMem uses, down to kilobytes. */
export function fmtBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes >= 2 ** 20) return fmtMem(bytes)
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

export function warnings(f: Footprint | undefined): FootprintVerdict[] {
  return (f?.verdicts ?? []).filter((v) => v.level === 'warn')
}

/** "All good", or how many things to look at: the panel's one-line verdict. */
export function verdictSummary(f: Footprint): string {
  const n = warnings(f).length
  return n === 0 ? 'All good' : `${n} ${n === 1 ? 'thing' : 'things'} to look at`
}

/** The window: the app's own process and the web view helpers that draw it. */
export function windowUsage(f: Footprint): { mem_bytes: number; cpu_pct: number; procs: number } | undefined {
  const { app, webview } = f.memory
  if (!app && !webview) return undefined
  return {
    mem_bytes: (app?.mem_bytes ?? 0) + (webview?.mem_bytes ?? 0),
    cpu_pct: (app?.cpu_pct ?? 0) + (webview?.cpu_pct ?? 0),
    procs: (app ? 1 : 0) + (webview?.count ?? 0),
  }
}

// --- the report, as `caprock doctor` prints it (cmd/caprock/doctor.go) ----

/**
 * Go's text/tabwriter as doctor.go sets it up (minwidth 0, padding 2,
 * spaces): every cell but a row's last is padded to its column's widest plus
 * two; the last is written as it is. Trailing spaces stay, as Go writes them.
 */
function tabwrite(rows: string[][]): string[] {
  const widths: number[] = []
  for (const r of rows) r.slice(0, -1).forEach((c, i) => { widths[i] = Math.max(widths[i] ?? 0, c.length) })
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]! + 2))).join(''))
}

/** daemon.Bytes: "2.1 GB", "340 MB", "12 KB", "512 B". */
export function goBytes(n: number): string {
  const k = 1024
  if (n >= k * k * k) return `${(n / (k * k * k)).toFixed(1)} GB`
  if (n >= k * k) return `${(n / (k * k)).toFixed(0)} MB`
  if (n >= k) return `${(n / k).toFixed(0)} KB`
  return `${Math.round(n)} B`
}

/** doctor.go's span: "1h05m", "12m", "40s". */
function span(sec: number): string {
  if (sec >= 3600) return `${Math.floor(sec / 3600)}h${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}m`
  if (sec >= 60) return `${Math.floor((sec + 30) / 60)}m`
  return `${sec}s`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Go's "Jan 2 15:04", in local time. */
function stamp(ms: number): string {
  const d = new Date(ms)
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const pct = (p: number) => `${p.toFixed(1)}%`

/**
 * The footprint as `caprock doctor` prints it, line for line, so a report
 * copied from the panel is the one a terminal would have printed. A change to
 * printDoctor changes testdata/footprint/doctor.txt, and this test with it.
 */
export function footprintText(f: Footprint): string {
  const B = goBytes
  const out: string[] = []
  const m = f.memory
  out.push(`data directory  ${f.data_dir}`)
  if (f.daemon_running) out.push(m.daemon ? `daemon          running, pid ${m.daemon.pid}` : 'daemon          running')
  else out.push('daemon          not running (figures read from the process table and the disk)')

  out.push('', 'Memory and CPU')
  const mem: string[][] = []
  if (m.daemon) mem.push(['  daemon', B(m.daemon.mem_bytes), pct(m.daemon.cpu_pct), ''])
  if (m.app) mem.push(['  desktop app', B(m.app.mem_bytes), pct(m.app.cpu_pct), ''])
  if (m.webview) mem.push(['  app window', B(m.webview.mem_bytes), pct(m.webview.cpu_pct), `${m.webview.count} web view processes`])
  const h = m.hosts
  mem.push(['  terminal holders', B(h.mem_bytes), pct(h.cpu_pct), `${h.count}, ${h.orphans} orphaned, ${h.reapable} reapable`])
  const daemons = f.duplicates.daemons ?? []
  if (daemons.length) mem.push(['  other daemons', B(m.other_daemons_mem_bytes), '', String(daemons.length)])
  mem.push(['  total', B(m.total_mem_bytes), pct(m.total_cpu_pct), ''])
  out.push(...tabwrite(mem))
  if (!f.daemon_running) out.push('  (CPU needs two samples; with no daemon it is not measured)')

  const d = f.disk
  out.push('', `Disk (${B(d.total_bytes)} in the data directory)`)
  out.push(...tabwrite([
    ['  database', B(d.database_bytes), `write-ahead log ${B(d.wal_bytes)}`],
    ['  pastes', B(d.pastes_bytes), ''],
    ['  logs', B(d.logs_bytes), ''],
    ['  binaries', B(d.binaries_bytes), ''],
    ['  other', B(d.other_bytes), ''],
  ]))

  const io = f.disk_io
  if (io) {
    out.push('', "The daemon's disk I/O")
    const rows: string[][] = []
    const win = (label: string, x?: IOWindow) => {
      if (x) rows.push([`  ${label}`, `read ${B(x.read_bytes)}`, `written ${B(x.write_bytes)}`, `over ${span(x.seconds)}`])
    }
    win('last minute', io.last_minute)
    win('last hour', io.last_hour)
    win('since start', io.since_start)
    out.push(...tabwrite(rows))
    if (!io.last_minute) out.push('  (read once a minute; the first interval is not over yet)')
    if (io.error) out.push(`  not measured: ${io.error}`)
  }

  out.push('', 'Duplicates')
  if (!daemons.length) out.push('  other daemons: none')
  for (const p of daemons) out.push(`  other daemon: pid ${p.pid} ${p.exe ?? ''} ${B(p.mem_bytes)}${p.data_dir ? `, data ${p.data_dir}` : ''}`)
  out.push(`  desktop apps: ${(f.duplicates.apps ?? []).length}`)
  const o = f.duplicates.other_install_holders
  out.push(`  terminal holders from another install: ${o.count}${o.count > 0 ? ` (${o.orphans} orphaned)` : ''}`)
  for (const e of o.exes ?? []) out.push(`    ${e.count}  ${e.exe}`)

  if (io) { // the daemon's own report, not one read from outside
    out.push('', 'Done on its own (since the daemon started)')
    const acts = f.actions ?? []
    if (!acts.length) out.push('  nothing needed doing')
    for (const a of acts) out.push(`  ${stamp(a.at)}  ${a.what}`)
  }

  out.push('', 'Verdict')
  for (const v of f.verdicts ?? []) out.push(`  ${v.level.toUpperCase().padEnd(4)}  ${v.text}`)
  if (f.error) out.push('', `note: ${f.error}`)
  return out.join('\n') + '\n'
}

/** For the strip's tooltip: what the two figures are. */
export function footprintTitle(f: Footprint): string {
  return [
    `Caprock on this computer: ${fmtMem(f.memory.total_mem_bytes)} memory (${fmtCPU(f.memory.total_cpu_pct)} CPU) · ${fmtBytes(f.disk.total_bytes)} on disk`,
    ...warnings(f).map((v) => v.text),
    'Click for what it is spent on — caprock doctor.',
  ].join('\n')
}
