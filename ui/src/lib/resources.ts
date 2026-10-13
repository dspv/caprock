/**
 * The resource meter (.ai/03-contracts.md § Resources): what each live
 * session's process tree costs the machine — CPU summed over the tree, so
 * 250% is two and a half cores, and each process's own memory — and what Caprock
 * itself costs. The daemon samples every 5 s while a dashboard is connected
 * and sends each sample as a `resources` frame; this store keeps the latest
 * one, asked for once when the first component mounts so a screen does not
 * wait for the first frame.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { api } from './api'
import { live } from './live'

export interface ProcUsage {
  pid: number
  name: string
  cpu_pct: number
  mem_bytes: number
}

export interface SessionResources {
  session_id: string
  pid: number
  cpu_pct: number
  mem_bytes: number
  procs: number
  /** False on a tree's first sample, before there is a CPU rate. */
  warm: boolean
  top: ProcUsage[]
  /** Over a limit for the whole of `thresholds.after_s`. */
  hot: boolean
  /** When the tree last went over a limit, unix ms; absent while under both. */
  over_since?: number
}

export interface HostVerdict {
  pid: number
  state: 'registered' | 'foreign' | 'young' | 'dead' | 'unreachable-idle' | 'unreachable-busy'
  reap: boolean
  /** Registered with this daemon's data directory; the daemon sweeps only these on its own. */
  ours: boolean
  child?: string
}

/** Several processes counted as one: the app window's web view helpers. */
export interface ProcGroup {
  count: number
  cpu_pct: number
  mem_bytes: number
  procs: ProcUsage[]
}

export interface ResourceReport {
  at: number
  sessions: SessionResources[]
  caprock: {
    daemon: ProcUsage
    app?: ProcUsage
    /** The processes that draw the app's window; absent without the app. */
    webview?: ProcGroup
    hosts: { count: number; mem_bytes: number; cpu_pct: number; orphans: number; reapable: number; list: HostVerdict[] }
  }
  thresholds: { cpu_pct: number; mem_bytes: number; after_s: number; interval_s: number }
  error?: string
}

export interface ReapResult {
  reaped: HostVerdict[]
  failed?: { pid: number; error: string }[]
  kept: HostVerdict[]
}

let report: ResourceReport | undefined
let bySession = new Map<string, SessionResources>()
const subs = new Set<() => void>()
let asked = false

function set(r: ResourceReport) {
  report = r
  bySession = new Map((r.sessions ?? []).map((s) => [s.session_id, s]))
  for (const s of subs) s()
}

live.onFrame((f) => {
  if ((f as { type: string }).type === 'resources') set((f as unknown as { data: ResourceReport }).data)
})

function subscribe(fn: () => void) {
  subs.add(fn)
  return () => { subs.delete(fn) }
}

/** Ask the daemon now, outside the frame cadence (Settings' reap, a first mount). */
export function refreshResources(): Promise<void> {
  return api.resources().then(set).catch(() => { /* an older daemon: no meter */ })
}

function useFirstFetch() {
  useEffect(() => {
    if (asked) return
    asked = true
    void refreshResources()
  }, [])
}

/** The latest report, or undefined before the first one (or from a daemon without the meter). */
export function useResources(): ResourceReport | undefined {
  useFirstFetch()
  return useSyncExternalStore(subscribe, () => report)
}

/** One session's tree, or undefined while it has none measured. */
export function useSessionResources(sessionId: string | undefined): SessionResources | undefined {
  useFirstFetch()
  return useSyncExternalStore(subscribe, () => (sessionId ? bySession.get(sessionId) : undefined))
}

/**
 * Why a session is hot, or null while it is not: the sidebar's and tabs'
 * mark. A string, so a row redraws only when what the mark says changes —
 * reading the whole report redrew every row's mark on every 5 s sample, hot
 * or not. The minutes count from the sample's own time, so one sample always
 * gives one answer.
 */
export function useSessionHot(sessionId: string | undefined): string | null {
  useFirstFetch()
  return useSyncExternalStore(subscribe, () => {
    const r = sessionId ? bySession.get(sessionId) : undefined
    return r?.hot ? hotReason(r, report?.thresholds, report?.at || Date.now()) : null
  })
}

/** "182%": CPU summed over a tree, rounded; a dash before there is a rate. */
export function fmtCPU(pct: number | undefined, warm = true): string {
  if (!warm || pct === undefined || !Number.isFinite(pct)) return '—'
  return pct >= 10 ? `${Math.round(pct)}%` : `${pct.toFixed(1)}%`
}

/** "1.2 GB", "340 MB": memory in binary units, as Activity Monitor shows it. */
export function fmtMem(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—'
  const gib = bytes / 2 ** 30
  if (gib >= 1) return `${gib >= 10 ? Math.round(gib) : gib.toFixed(1)} GB`
  const mib = bytes / 2 ** 20
  return `${Math.max(1, Math.round(mib))} MB`
}

/** Why a session is hot, for its tooltip. */
export function hotReason(s: SessionResources, t?: ResourceReport['thresholds'], now = Date.now()): string {
  const over: string[] = []
  if (t && s.cpu_pct >= t.cpu_pct) over.push(`${fmtCPU(s.cpu_pct)} CPU`)
  if (t && s.mem_bytes >= t.mem_bytes) over.push(`${fmtMem(s.mem_bytes)} memory`)
  const mins = s.over_since ? Math.max(1, Math.round((now - s.over_since) / 60_000)) : 0
  const what = over.length ? over.join(' and ') : `${fmtCPU(s.cpu_pct)} CPU, ${fmtMem(s.mem_bytes)}`
  return `Hot: its processes have used ${what}${mins ? ` for ${mins} min` : ''}${s.top[0] ? ` — mostly ${s.top[0].name}` : ''}`
}

/** For tests: forget the latest report. */
export function resetResourcesForTest(r?: ResourceReport) {
  asked = true
  if (r) set(r)
  else {
    report = undefined
    bySession = new Map()
    for (const s of subs) s()
  }
}
