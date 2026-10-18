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
import { useRef } from 'react'
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

/** One process that looks abandoned (03-contracts.md § Footprint, `orphans`). */
export interface Orphan {
  pid: number
  /** With `pid`, names the process: a stop sends both, and a pid since reused is not touched. */
  started_at: number
  kind: 'caprock_daemon' | 'caprock_holder' | 'caprock_old_holder' | 'caprock_other' | 'claude' | 'codex' | 'mcp_server' | 'claude_child' | string
  label: string
  /** The command line, cut to 160 characters, credentials hidden. */
  cmd?: string
  exe?: string
  data_dir?: string
  data_dir_gone?: boolean
  /** Absent until there are two samples. */
  cpu_pct?: number
  mem_bytes: number
  why: string
  /** A holder the daemon stops on its own. */
  auto?: boolean
}

export interface OrphanReport {
  /** True when `list` was taken for this answer; otherwise the counts are the last scan's and the list is empty. */
  scanned: boolean
  at: number
  count: number
  by_kind: Record<string, number> | null
  /** Every listed process's memory together; absent from a daemon before 2026-10-18. */
  mem_bytes?: number
  list: Orphan[] | null
  note?: string
}

export interface OrphanTarget { pid: number; started_at: number }

export interface OrphanStopResult {
  stopped: Orphan[] | null
  /** Got SIGTERM and was still there 5 s later; nothing more was sent (Force stop is the second click). */
  running?: Orphan[] | null
  failed: { pid: number; error: string }[] | null
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
  /** Processes that look abandoned; absent from a daemon that predates the scan. */
  orphans?: OrphanReport
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

/**
 * The footprint with the orphan list: the open doctor asks for it every 10 s
 * like the strip, and only while it is open. The daemon answers with a scan
 * up to 30 s old; `checkNow` (Check now) asks it to take one at once.
 */
export function useFootprintWithOrphans() {
  const fresh = useRef(false)
  const q = useApi(() => {
    const now = fresh.current
    fresh.current = false
    return api.footprint(true, now)
  }, [], { live: false, intervalMs: FOOTPRINT_POLL_MS, keepUnchanged: true })
  return { ...q, checkNow: () => { fresh.current = true; q.refresh() } }
}

/**
 * The orphans in one figure, undefined when there are none: "Orphans: 3 ·
 * 410 MB" in the doctor, "3 orphans" on the strip (`short`), where the width
 * is already spent (NARROW_STRIP_PX) and the memory is in the tooltip.
 */
export function orphanFigure(o: OrphanReport | undefined, short = false): string | undefined {
  if (!o || o.count <= 0) return undefined
  if (short) return `${o.count} ${o.count === 1 ? 'orphan' : 'orphans'}`
  return `Orphans: ${o.count}${o.mem_bytes ? ` · ${fmtBytes(o.mem_bytes)}` : ''}`
}

/** daemon.Age: "40s", "12m", "3h", "7d" (days from 48 hours). */
export function age(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s >= 48 * 3600) return `${Math.floor(s / 86400)}d`
  if (s >= 3600) return `${Math.floor(s / 3600)}h`
  if (s >= 60) return `${Math.floor(s / 60)}m`
  return `${s}s`
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

  const orph = f.orphans
  if (orph) {
    out.push('', orph.count > 0 ? `Orphans: ${orph.count} · ${goBytes(orph.mem_bytes ?? 0)} (processes that look abandoned)` : 'Orphans (processes that look abandoned)')
    const list = orph.list ?? []
    if (!orph.scanned && orph.count > 0) out.push(`  ${orph.count} found at the last check; \`caprock doctor\` lists them`)
    else if (orph.count === 0) out.push('  none')
    for (const p of list) out.push(...orphanLines(f.at, p, '  '))
    if (list.length) out.push('  (stop one: caprock doctor --stop <pid>)')
    if (orph.note) out.push(`  note: ${orph.note}`)
  }

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

/** doctor.go's printOrphan: what, why, the command line, where. */
function orphanLines(at: number, p: Orphan, indent: string): string[] {
  const cpu = p.cpu_pct !== undefined && p.cpu_pct !== null ? ` · ${pct(p.cpu_pct)} CPU` : ''
  const out = [`${indent}pid ${p.pid}  ${p.label} · ${age(at - p.started_at)} old · ${goBytes(p.mem_bytes)}${cpu}${p.auto ? ' · stopped on its own' : ''}`, `${indent}  ${p.why}`]
  if (p.cmd) out.push(`${indent}  $ ${p.cmd}`)
  let where = p.exe ?? ''
  if (p.data_dir) where += `${where ? ' · ' : ''}data ${p.data_dir}${p.data_dir_gone ? ' (gone)' : ''}`
  if (where) out.push(`${indent}  ${where}`)
  return out
}

/** For the strip's tooltip: what the two figures are. */
export function footprintTitle(f: Footprint): string {
  return [
    `Caprock on this computer: ${fmtMem(f.memory.total_mem_bytes)} memory (${fmtCPU(f.memory.total_cpu_pct)} CPU) · ${fmtBytes(f.disk.total_bytes)} on disk`,
    ...(f.orphans && f.orphans.count > 0 ? [`${orphanFigure(f.orphans)} — processes that look abandoned`] : []),
    ...warnings(f).map((v) => v.text),
    'Click for what it is spent on — caprock doctor.',
  ].join('\n')
}

// --- the doctor in plain words (owner, 2026-10-15) --------------------------
//
// The owner opened the doctor on a day with three test daemons, four
// leftover servers and a busy disk, and read a wall of pids and paths
// (translated): "nothing is understandable". The panel now says one verdict
// line, then one row per kind of problem in words a non-engineer reads in
// three seconds; pids, paths and the daemon's own sentences are one click
// down, under Details.

/** A temporary folder or an agent's worktree: where agent work starts throwaway daemons. */
const THROWAWAY = [
  /[/\\]\.claude[/\\]worktrees[/\\]/,
  /[/\\]\.claude[/\\]jobs[/\\]/,
  /[/\\]scratchpad[/\\]/,
  /^\/(private\/)?tmp\//,
  /^\/(private\/)?var\/folders\//,
  /[/\\]Temp[/\\]/i,
]

export function isThrowawayPath(p: string | undefined): boolean {
  return Boolean(p) && THROWAWAY.some((r) => r.test(p!))
}

/** A Caprock started from a temporary folder or a worktree: agent work, not the person's app. */
export function isTestCopy(o: { exe?: string; data_dir?: string; data_dir_gone?: boolean }): boolean {
  return Boolean(o.data_dir_gone) || isThrowawayPath(o.data_dir) || isThrowawayPath(o.exe)
}

/**
 * Where a process came from, in words: "worktree phone-end", "agent
 * scratchpad caprock-triage", "a temporary folder". Undefined for a path
 * that is none of those.
 */
export function startedFrom(...paths: (string | undefined)[]): string | undefined {
  for (const p of paths) {
    if (!p) continue
    const wt = /[/\\]\.claude[/\\]worktrees[/\\]([^/\\]+)/.exec(p)
    if (wt) return `worktree ${wt[1]}`
    const job = /[/\\]\.claude[/\\]jobs[/\\]([^/\\]+)/.exec(p)
    if (job) return `agent job ${job[1]!.slice(0, 8)}`
    const sp = /[/\\]scratchpad[/\\]([^/\\]+)/.exec(p)
    if (sp) return `agent scratchpad ${sp[1]}`
  }
  return paths.some(isThrowawayPath) ? 'a temporary folder' : undefined
}

/**
 * Whether Clean up ticks it by default. Everything the doctor lists may be
 * stopped (ADR-059); these are the ones that are safe to stop without
 * reading further. Left unticked: a terminal holder something still runs in
 * (stopping it closes that terminal) — an old install's above all, whose
 * session this Caprock still lists — a Caprock daemon for a data folder
 * that is not a temporary one (it may be a second install someone uses),
 * and a Caprock command inside an app bundle.
 */
export function safeToStop(o: Orphan): boolean {
  switch (o.kind) {
    case 'caprock_daemon': return isTestCopy(o)
    case 'caprock_holder': return Boolean(o.auto)
    case 'caprock_old_holder': return false
    case 'caprock_other': return !/\.app[/\\]/.test(o.exe ?? '')
    default: return true
  }
}

export type DoctorRowKey = 'copies' | 'apps' | 'terminals' | 'old-terminals' | 'commands' | 'claude' | 'codex' | 'helpers' | 'reads' | 'database' | 'wal' | 'daemon' | string

/** One row of the doctor: what, why in a line, how big, and what can be stopped. */
export interface DoctorRow {
  key: DoctorRowKey
  title: string
  count?: number
  /** One line, in words. */
  reason: string
  /** "66 MB", "1.6 GB / hour". */
  value?: string
  /** Amber only for a real problem: a warning verdict. */
  warn: boolean
  /** What its Stop and Clean up may stop: listed by the doctor's scan, on the machine. */
  stoppable: Orphan[]
  /** The processes behind it, for Details: from the scan, or the duplicates when the scan has not landed. */
  procs: { pid: number; mem_bytes: number; cpu_pct?: number; started_at?: number; exe?: string; cmd?: string; data_dir?: string; data_dir_gone?: boolean; why?: string; label?: string }[]
  /** The daemon's own sentence, for Details. */
  said?: string
}

/** The rows, problems first, in the order a person would act on them. */
export function doctorRows(f: Footprint): DoctorRow[] {
  const verdict = (code: string) => (f.verdicts ?? []).find((v) => v.code === code)
  const isWarn = (code: string) => verdict(code)?.level === 'warn'
  const list = f.orphans?.scanned ? (f.orphans.list ?? []) : []
  const of = (...kinds: string[]) => list.filter((o) => kinds.includes(o.kind))
  const mem = (xs: { mem_bytes: number }[]) => xs.reduce((s, x) => s + x.mem_bytes, 0)
  const rows: DoctorRow[] = []

  if (verdict('daemon_not_running')) {
    rows.push({ key: 'daemon', title: 'Caprock is not running', reason: 'Start it from the desktop app or with caprock up.', warn: true, stoppable: [], procs: [], said: verdict('daemon_not_running')!.text })
  }

  // Other daemons: from the scan when it is in (with what Stop needs), else the duplicates.
  const daemons = of('caprock_daemon')
  const dups = f.duplicates.daemons ?? []
  const copies = daemons.length ? daemons : dups
  if (copies.length) {
    const test = copies.every(isTestCopy)
    rows.push({
      key: 'copies',
      title: test ? 'Test copies of Caprock' : 'Other copies of Caprock',
      count: copies.length,
      reason: test ? 'Started by agent work, not your app.' : `Running for ${copies.length === 1 ? 'a different data folder' : 'different data folders'}, beside your app.`,
      value: fmtBytes(daemons.length ? mem(daemons) : f.memory.other_daemons_mem_bytes || mem(dups)),
      warn: isWarn('duplicate_daemon'),
      stoppable: daemons,
      procs: copies,
      said: verdict('duplicate_daemon')?.text,
    })
  }

  const apps = f.duplicates.apps ?? []
  if (apps.length > 1) {
    rows.push({ key: 'apps', title: 'The desktop app is open twice', count: apps.length, reason: 'Quit all but one.', value: fmtBytes(mem(apps)), warn: isWarn('duplicate_app'), stoppable: [], procs: apps, said: verdict('duplicate_app')?.text })
  }

  const holders = of('caprock_holder')
  const h = f.memory.hosts
  if (holders.length || h.orphans > 0) {
    const n = holders.length || h.orphans
    rows.push({
      key: 'terminals',
      title: 'Unused Caprock terminals',
      count: n,
      reason: h.reapable > 0 || holders.some((o) => o.auto) ? 'Nothing is attached to them. Caprock clears these on its own.' : 'Nothing is attached to them, but something still runs inside.',
      value: holders.length ? fmtBytes(mem(holders)) : undefined,
      warn: isWarn('orphans'),
      stoppable: holders,
      procs: holders,
      said: verdict('orphans')?.text,
    })
  }

  // Said, never warned: a session this Caprock still lists, run by an install it moved away from.
  const oldHolders = of('caprock_old_holder')
  if (oldHolders.length) {
    rows.push({
      key: 'old-terminals',
      title: 'Older install sessions',
      count: oldHolders.length,
      reason: 'Still running from a previous Caprock install.',
      value: fmtBytes(mem(oldHolders)),
      warn: false,
      stoppable: oldHolders,
      procs: oldHolders,
    })
  }

  const strayWarn = isWarn('stray_processes')
  const commands = of('caprock_other')
  if (commands.length) {
    rows.push({ key: 'commands', title: 'Background commands', count: commands.length, reason: 'Their window or script has closed.', value: fmtBytes(mem(commands)), warn: strayWarn, stoppable: commands, procs: commands })
  }
  const claudes = of('claude')
  if (claudes.length) {
    rows.push({ key: 'claude', title: 'Leftover Claude sessions', count: claudes.length, reason: 'Their session has ended; the process did not.', value: fmtBytes(mem(claudes)), warn: strayWarn, stoppable: claudes, procs: claudes })
  }
  const codexes = of('codex')
  if (codexes.length) {
    rows.push({ key: 'codex', title: 'Leftover Codex sessions', count: codexes.length, reason: 'Their session has ended; the process did not.', value: fmtBytes(mem(codexes)), warn: strayWarn, stoppable: codexes, procs: codexes })
  }
  const helpers = of('mcp_server', 'claude_child')
  if (helpers.length) {
    rows.push({ key: 'helpers', title: 'Leftover helpers', count: helpers.length, reason: 'Servers left running by finished agent sessions.', value: fmtBytes(mem(helpers)), warn: strayWarn && helpers.some((o) => o.kind === 'mcp_server'), stoppable: helpers, procs: helpers, said: verdict('stray_processes')?.text })
  }
  // Before the scan lands: the strip's counts, so the row is not missing for ten seconds.
  if (!f.orphans?.scanned && f.orphans && f.orphans.count > 0) {
    const k = f.orphans.by_kind ?? {}
    const n = (k.claude ?? 0) + (k.codex ?? 0) + (k.mcp_server ?? 0) + (k.claude_child ?? 0) + (k.caprock_other ?? 0) + (k.caprock_old_holder ?? 0)
    if (n) rows.push({ key: 'helpers', title: 'Leftover processes', count: n, reason: 'Left running by finished sessions. Looking at them now…', warn: strayWarn, stoppable: [], procs: [], said: verdict('stray_processes')?.text })
  }

  const io = f.disk_io?.last_hour
  if (io) {
    const high = isWarn('disk_reads_high')
    const span = io.seconds >= 3540 ? 'hour' : `${Math.max(1, Math.round(io.seconds / 60))} min`
    // The daemon's own threshold, as its sentence says it: "(over 500 MB)".
    const over = /\(over ([0-9.]+ [KMG]?B)\)/.exec(verdict('disk_reads_high')?.text ?? '')?.[1]
    rows.push({
      key: 'reads',
      title: 'Disk reads',
      reason: high ? `Above the usual${over ? ` ${over}/hour` : ''} limit.` : 'Normal for Caprock.',
      value: `${fmtBytes(io.read_bytes)} / ${span}`,
      warn: high, stoppable: [], procs: [], said: verdict('disk_reads_high')?.text,
    })
  }
  if (verdict('database_large')) {
    rows.push({ key: 'database', title: 'History is large', reason: 'A retention period in Settings deletes old events.', value: fmtBytes(f.disk.database_bytes), warn: isWarn('database_large'), stoppable: [], procs: [], said: verdict('database_large')!.text })
  }
  if (verdict('wal_large')) {
    rows.push({ key: 'wal', title: 'A database file has grown', reason: 'Caprock folds it back on its own within minutes.', value: fmtBytes(f.disk.wal_bytes), warn: isWarn('wal_large'), stoppable: [], procs: [], said: verdict('wal_large')!.text })
  }
  // A warning this build does not know: the daemon's sentence as it is.
  const known = new Set(['ok', 'daemon_not_running', 'duplicate_daemon', 'duplicate_app', 'orphans', 'stray_processes', 'disk_reads_high', 'database_large', 'wal_large', 'other_install_holders'])
  for (const v of warnings(f)) {
    if (!known.has(v.code)) rows.push({ key: v.code, title: v.text, reason: '', warn: true, stoppable: [], procs: [] })
  }
  // Problems first; the rest keep their order.
  return [...rows.filter((r) => r.warn), ...rows.filter((r) => !r.warn)]
}

/** Everything Clean up offers: each row's stoppable processes, in row order. */
export function cleanupList(rows: DoctorRow[]): Orphan[] {
  const seen = new Set<number>()
  return rows.flatMap((r) => r.stoppable).filter((o) => !seen.has(o.pid) && seen.add(o.pid))
}

/** The one line at the top. */
export function doctorHeadline(f: Footprint): { ok: boolean; text: string } {
  if ((f.verdicts ?? []).some((v) => v.code === 'daemon_not_running')) return { ok: false, text: 'Caprock is not running' }
  if (!warnings(f).length) return { ok: true, text: 'All good' }
  return { ok: false, text: 'Needs attention' }
}

/** "3 test copies of Caprock", for the confirmation and the note after a stop. */
export function plainName(o: Orphan): string {
  switch (o.kind) {
    case 'caprock_daemon': return isTestCopy(o) ? 'Test copy of Caprock' : 'Other copy of Caprock'
    case 'caprock_holder': return 'Unused Caprock terminal'
    case 'caprock_old_holder': return 'Terminal from an older Caprock install'
    case 'codex': return 'Finished Codex session'
    case 'caprock_other': {
      const app = /([^/\\]+)\.app[/\\]/.exec(o.exe ?? '')?.[1]
      return app ? `${app} helper` : `Leftover ${o.label}`
    }
    case 'claude': return 'Finished Claude session'
    default: return `Leftover ${o.label}`
  }
}
