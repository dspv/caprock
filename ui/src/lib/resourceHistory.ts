/**
 * The resource meter over time (.ai/03-contracts.md § Resources, history):
 * what the status bar's *agent cpu … ram …* popover draws. The daemon keeps
 * every sample the meter takes — an hour of them at 5 s — and
 * `GET /v1/resources/history` hands them over as series. This store asks
 * for them when the popover opens (after the newest sample it already has,
 * so an hour is fetched once, not on every hover), and while it is open
 * appends each `resources` frame the status bar already receives. No
 * polling of its own: the meter samples only while a window is open, so
 * the history has gaps where none was, drawn as gaps.
 */
import { api } from './api'
import { fmtCPU, fmtMem, latestResources, onResources, type ResourceReport, type SessionResources } from './resources'

export interface Series {
  cpu: (number | null)[]
  mem: (number | null)[]
}

export interface ResourceHistory {
  interval_s: number
  capacity: number
  at: number[]
  caprock: Series
  all: Series
  sessions: Record<string, Series>
}

export type Metric = 'cpu' | 'mem'

/** 15 minutes or an hour: the popover's two views. */
export const WINDOWS = [{ key: '15m', ms: 15 * 60_000, label: '15 min' }, { key: '1h', ms: 60 * 60_000, label: '1 hour' }] as const
export type WindowKey = typeof WINDOWS[number]['key']

const HOUR_MS = 60 * 60_000

function emptySeries(n: number): Series {
  return { cpu: new Array<number | null>(n).fill(null), mem: new Array<number | null>(n).fill(null) }
}

export function emptyHistory(): ResourceHistory {
  return { interval_s: 5, capacity: 720, at: [], caprock: emptySeries(0), all: emptySeries(0), sessions: {} }
}

/** Caprock's own total, as the daemon sums it: daemon, terminal holders, the app and its web view. */
export function caprockTotal(r: ResourceReport): { cpu: number; mem: number } {
  const c = r.caprock
  return {
    cpu: c.daemon.cpu_pct + c.hosts.cpu_pct + (c.app?.cpu_pct ?? 0) + (c.webview?.cpu_pct ?? 0),
    mem: c.daemon.mem_bytes + c.hosts.mem_bytes + (c.app?.mem_bytes ?? 0) + (c.webview?.mem_bytes ?? 0),
  }
}

const round1 = (v: number) => Math.round(v * 10) / 10

/**
 * Keep only the newest `cap` samples, and none older than an hour before
 * the newest: a popover opened after a night's sleep does not draw
 * yesterday's last minutes as this hour's.
 */
function trim(h: ResourceHistory): ResourceHistory {
  const n = h.at.length
  const newest = h.at[n - 1] ?? 0
  let from = Math.max(0, n - h.capacity)
  while (from < n && h.at[from]! < newest - HOUR_MS) from++
  if (from === 0) return h
  const cut = (s: Series): Series => ({ cpu: s.cpu.slice(from), mem: s.mem.slice(from) })
  const sessions: Record<string, Series> = {}
  for (const [id, s] of Object.entries(h.sessions)) {
    const c = cut(s)
    if (c.mem.some((v) => v !== null)) sessions[id] = c
  }
  return { ...h, at: h.at.slice(from), caprock: cut(h.caprock), all: cut(h.all), sessions }
}

/** `more` (samples after the last of `h`) appended to `h`; samples not newer than `h`'s newest are dropped. */
export function merge(h: ResourceHistory, more: ResourceHistory): ResourceHistory {
  const last = h.at[h.at.length - 1] ?? 0
  const keep = more.at.map((t, i) => (t > last ? i : -1)).filter((i) => i >= 0)
  if (keep.length === 0) return h.at.length ? h : { ...h, interval_s: more.interval_s, capacity: more.capacity }
  const n = h.at.length
  const pick = (s: Series | undefined): Series => ({ cpu: keep.map((i) => s?.cpu[i] ?? null), mem: keep.map((i) => s?.mem[i] ?? null) })
  const join = (a: Series | undefined, b: Series | undefined): Series => {
    const x = a ?? emptySeries(n)
    const y = pick(b)
    return { cpu: x.cpu.concat(y.cpu), mem: x.mem.concat(y.mem) }
  }
  const sessions: Record<string, Series> = {}
  for (const id of new Set([...Object.keys(h.sessions), ...Object.keys(more.sessions)])) sessions[id] = join(h.sessions[id], more.sessions[id])
  return trim({
    interval_s: more.interval_s || h.interval_s,
    capacity: more.capacity || h.capacity,
    at: h.at.concat(keep.map((i) => more.at[i]!)),
    caprock: join(h.caprock, more.caprock),
    all: join(h.all, more.all),
    sessions,
  })
}

/** One live report as a one-sample history, summed as the daemon sums it. */
export function fromReport(r: ResourceReport): ResourceHistory {
  const one = (cpu: number | null, mem: number): Series => ({ cpu: [cpu === null ? null : round1(cpu)], mem: [mem] })
  const c = caprockTotal(r)
  const sessions: Record<string, Series> = {}
  let cpu = 0
  let mem = 0
  for (const s of r.sessions ?? []) {
    sessions[s.session_id] = one(s.warm ? s.cpu_pct : null, s.mem_bytes)
    if (s.warm) cpu += s.cpu_pct
    mem += s.mem_bytes
  }
  return {
    interval_s: r.thresholds?.interval_s || 5,
    capacity: 720,
    at: [r.at],
    caprock: one(c.cpu, c.mem),
    all: one(cpu, mem),
    sessions,
  }
}

// --- the store ---------------------------------------------------------

let hist = emptyHistory()
const subs = new Set<() => void>()
let openCount = 0
let unlisten: (() => void) | undefined

function set(h: ResourceHistory) {
  if (h === hist) return
  hist = h
  for (const s of subs) s()
}

/** The history kept so far. */
export function currentHistory(): ResourceHistory {
  return hist
}

export function subscribeHistory(fn: () => void): () => void {
  subs.add(fn)
  return () => { subs.delete(fn) }
}

/**
 * The popover opened: fetch what the daemon kept since our newest sample,
 * and append each report while it stays open. Returns the close.
 */
export function openHistory(): () => void {
  openCount++
  if (openCount === 1) {
    // Reports that land before the daemon's answer wait for it: merged
    // first, they would make the older samples it brings look stale.
    let waiting: ResourceReport[] | undefined = []
    const flush = () => {
      let h = hist
      for (const r of waiting ?? []) h = merge(h, fromReport(r))
      waiting = undefined
      set(h)
    }
    const since = hist.at[hist.at.length - 1] ?? 0
    void api.resourceHistory(since)
      .then((more) => { set(merge(hist, more)) })
      .catch(() => {
        // An older daemon: the live reports alone, starting with the latest.
        const r = latestResources()
        if (r) set(merge(hist, fromReport(r)))
      })
      .finally(flush)
    unlisten = onResources((rep) => {
      if (waiting) waiting.push(rep)
      else set(merge(hist, fromReport(rep)))
    })
  }
  return () => {
    openCount--
    if (openCount === 0) {
      unlisten?.()
      unlisten = undefined
    }
  }
}

/** For tests. */
export function resetHistoryForTest(h: ResourceHistory = emptyHistory()) {
  unlisten?.()
  unlisten = undefined
  openCount = 0
  hist = h
  for (const s of subs) s()
}

// --- reading it ----------------------------------------------------------

export interface Point { at: number; v: number | null }

/** One series' points within the last `ms` before `now`. */
export function pointsOf(h: ResourceHistory, s: Series | undefined, metric: Metric, ms: number, now: number): Point[] {
  if (!s) return []
  const out: Point[] = []
  for (let i = 0; i < h.at.length; i++) {
    const at = h.at[i]!
    if (at < now - ms) continue
    out.push({ at, v: s[metric][i] ?? null })
  }
  return out
}

export interface Stat { now: number | null; peak: number | null; avg: number | null }

/** The latest figure, the highest and the mean over the points that have one. */
export function stats(pts: Point[]): Stat {
  let peak: number | null = null
  let sum = 0
  let n = 0
  let now: number | null = null
  for (const p of pts) {
    if (p.v === null) continue
    peak = peak === null ? p.v : Math.max(peak, p.v)
    sum += p.v
    n++
    now = p.v
  }
  return { now, peak, avg: n ? sum / n : null }
}

export function fmtMetric(metric: Metric, v: number | null): string {
  if (v === null) return '—'
  return metric === 'cpu' ? fmtCPU(v) : fmtMem(v)
}

/** Who uses the machine now, busiest first: CPU, then memory; at most `n`. */
export function topConsumers(sessions: SessionResources[], n = 5): SessionResources[] {
  return [...sessions]
    .sort((a, b) => (b.warm ? b.cpu_pct : 0) - (a.warm ? a.cpu_pct : 0) || b.mem_bytes - a.mem_bytes)
    .slice(0, n)
}
