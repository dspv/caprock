/**
 * The status strip's database indicator (ADR-093, amended 2026-11-07;
 * .ai/04-ui.md § The status strip): what the daemon is doing to make the
 * database smaller, and the pack it offers.
 *
 * Owner, 2026-11-07, translated: compression ran all night and did nothing,
 * because it waited for 30 idle minutes his agents never leave. It now runs
 * in small steps while agents work, and the window's bottom strip shows how
 * far it is — *Compressing · 40% · 224.6MB saved* — then, when packing the
 * file would free a meaningful amount, offers *Pack database · ~85 s*; a click
 * opens the details, the estimate and **Pack now**, and during the pack the
 * strip carries a real progress bar.
 *
 * **Every figure is the daemon's.** `GET /v1/storage/pack` (03-contracts.md
 * § Storage) carries the job's cursor against its target, the payload bytes
 * saved, the pack's estimate from a sample of pages and the rate of the last
 * pack on this machine, and while a pack runs the bytes it has written per
 * phase. Nothing here is timed or invented: a phase with no reading on this
 * OS draws a moving stripe, not a made-up percentage.
 *
 * **Polling** is as often as the state moves: every 2 s during a pack, 5 s
 * while compressing or restoring, otherwise every 5 minutes and when the
 * window regains focus. A paired device never sees it: the database is the
 * machine owner's.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { api, errText, isPairedDevice } from './api'
import { fmtBytes } from './format'

export interface CompressionJob {
  on: boolean
  through_ms?: number
  restoring?: boolean
  cursor_id?: number
  target_id?: number
  restore_from_id?: number
  progress?: number
  pending?: boolean
  saved_bytes?: number
}

export interface PackOffer {
  used_bytes: number
  free_bytes_est: number
  sampled_pages: number
  est_seconds: number
  hold_seconds_est: number
  rate_measured?: boolean
  worth: boolean
}

export interface PackProgress {
  phase: 'waiting' | 'copying' | 'writing' | 'finishing'
  /** 0–1, or -1 where this OS gives the phase no reading. */
  progress: number
  started_ms: number
  elapsed_ms: number
  est_seconds: number
  events_wait: boolean
}

export interface PackLast {
  at_ms: number
  ok: boolean
  why?: string
  before_bytes: number
  after_bytes?: number
  took_ms: number
  hold_ms?: number
}

/** GET /v1/storage/pack. */
export interface PackReport {
  compression: CompressionJob
  pack: { db_bytes: number; running?: PackProgress; offer?: PackOffer; estimating?: boolean; last?: PackLast }
}

export type DbWork =
  | { kind: 'compressing'; progress: number; saved: number }
  | { kind: 'restoring'; progress: number }
  | { kind: 'offer'; offer: PackOffer; dbBytes: number }
  | { kind: 'packing'; run: PackProgress }
  | { kind: 'packed'; last: PackLast }
  | { kind: 'failed'; last: PackLast }

/** How long a finished pack stays on the line. */
export const PACKED_SHOW_MS = 60_000
/** How long a pack that stopped stays on the line. */
export const FAILED_SHOW_MS = 10 * 60_000
/** How long *Not now* hides the offer. */
export const PACK_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000
export const PACK_SNOOZE_KEY = 'caprock.packOffer.snoozedUntil'

/** What the indicator shows, if anything. */
export function dbWork(r: PackReport | undefined, now: number, snoozedUntil: number): DbWork | undefined {
  if (!r) return undefined
  const p = r.pack
  if (p.running) return { kind: 'packing', run: p.running }
  if (p.last) {
    const age = now - p.last.at_ms
    if (p.last.ok && age < PACKED_SHOW_MS) return { kind: 'packed', last: p.last }
    if (!p.last.ok && age < FAILED_SHOW_MS) return { kind: 'failed', last: p.last }
  }
  const z = r.compression
  if (z.on && z.pending) return { kind: 'compressing', progress: clamp01(z.progress ?? 0), saved: z.saved_bytes ?? 0 }
  if (!z.on && z.restoring) return { kind: 'restoring', progress: clamp01(z.progress ?? 0) }
  if (p.offer?.worth && now >= snoozedUntil) return { kind: 'offer', offer: p.offer, dbBytes: p.db_bytes }
  return undefined
}

function clamp01(v: number): number {
  return Math.min(Math.max(v, 0), 1)
}

/** A share as a whole percent, rounded down so 99.6% never reads as done. */
export function pct(v: number): string {
  return `${Math.floor(clamp01(v) * 100)}%`
}

/** A duration estimate in words: *40 s*, *2 min*. */
export function fmtSeconds(s: number): string {
  if (s < 120) return `${Math.max(Math.round(s / 5) * 5, 5)} s`
  return `${Math.round(s / 60)} min`
}

const PHASE: Record<PackProgress['phase'], string> = {
  waiting: 'starting',
  copying: 'copying',
  writing: 'writing back',
  finishing: 'finishing',
}

/** The strip's short form of each state. */
export function dbWorkChip(w: DbWork): string {
  switch (w.kind) {
    case 'compressing':
      return `Compressing · ${pct(w.progress)} · ${fmtBytes(w.saved)} saved`
    case 'restoring':
      return `Restoring · ${pct(w.progress)}`
    case 'offer':
      return `Pack database · ~${fmtSeconds(w.offer.est_seconds)}`
    case 'packing':
      return `Packing${w.run.progress >= 0 ? ` · ${pct(w.run.progress)}` : ` · ${PHASE[w.run.phase]}`}`
    case 'packed':
      return `Packed · ${fmtBytes(w.last.before_bytes)} → ${fmtBytes(w.last.after_bytes ?? 0)}`
    case 'failed':
      return 'Pack stopped'
  }
}

/** The long form of each state: the popover's first line. */
export function dbWorkText(w: DbWork): string {
  switch (w.kind) {
    case 'compressing':
      return `Compressing old tool output · ${pct(w.progress)} · ${fmtBytes(w.saved)} saved`
    case 'restoring':
      return `Restoring compressed tool output · ${pct(w.progress)}`
    case 'offer':
      return `Pack the database · about ${fmtSeconds(w.offer.est_seconds)} · frees ~${fmtBytes(w.offer.free_bytes_est)}`
    case 'packing':
      return `Packing the database · ${PHASE[w.run.phase]}${w.run.progress >= 0 ? ` · ${pct(w.run.progress)}` : ''}`
    case 'packed':
      return `Packed · ${fmtBytes(w.last.before_bytes)} → ${fmtBytes(w.last.after_bytes ?? 0)}`
    case 'failed':
      return `Packing stopped: ${w.last.why ?? 'it failed'}`
  }
}

/** The tooltip: where the figures come from, and what happens. */
export function dbWorkTitle(w: DbWork): string {
  if (w.kind === 'offer') {
    return `${dbWorkText(w)} (an estimate from ${w.offer.sampled_pages.toLocaleString('en-US')} of its pages; the time ` +
      `${w.offer.rate_measured ? 'from the last pack on this computer' : 'from a measured pack, until this computer has run one'}). ` +
      `Rewrites the ${fmtBytes(w.dbBytes)} file without its empty space. Sessions keep running; new events wait about ` +
      `${fmtSeconds(w.offer.hold_seconds_est)} and are recorded when it is done.`
  }
  return `${dbWorkText(w)}. ${dbWorkDetail(w)}`
}

/** What the popover says under the line, for every state but the offer. */
export function dbWorkDetail(w: DbWork): string {
  switch (w.kind) {
    case 'compressing':
      return 'Tool calls older than a day are compressed in small steps whenever your agents pause for a few seconds, ' +
        'using at most a tenth of one core; prompts and replies stay as they are. The figure is the tool output saved; ' +
        'the space comes back to the disk as it goes.'
    case 'restoring':
      return 'Compress tool output is off, so the compressed rows are put back as plain JSON in small steps.'
    case 'offer':
      return ''
    case 'packing':
      return w.run.events_wait ? 'New events wait and are recorded when it is done; sessions keep running.' : 'New events are being recorded again.'
    case 'packed':
      return `Took ${fmtSeconds(w.last.took_ms / 1000)}${w.last.hold_ms ? `; new events waited ${fmtSeconds(w.last.hold_ms / 1000)}` : ''}.`
    case 'failed':
      return 'Nothing changed; you can try again.'
  }
}

function readSnooze(): number {
  try {
    const v = Number(localStorage.getItem(PACK_SNOOZE_KEY) ?? 0)
    return Number.isFinite(v) ? v : 0
  } catch { return 0 }
}

let snoozedUntil = readSnooze()
const subs = new Set<() => void>()

/** *Not now* on the offer: hide it for PACK_SNOOZE_MS. */
export function snoozePackOffer(now = Date.now()): void {
  snoozedUntil = now + PACK_SNOOZE_MS
  try { localStorage.setItem(PACK_SNOOZE_KEY, String(snoozedUntil)) } catch { /* hidden for this page only */ }
  for (const f of subs) f()
}

/** For tests: read the snooze from storage again. */
export function reloadPackSnooze(): void {
  snoozedUntil = readSnooze()
  for (const f of subs) f()
}

function useSnooze(): number {
  return useSyncExternalStore(
    (f) => { subs.add(f); return () => { subs.delete(f) } },
    () => snoozedUntil,
    () => snoozedUntil,
  )
}

/** How long until the next read, by what is on the line. */
export function pollMs(w: DbWork | undefined): number {
  if (!w) return 5 * 60_000
  switch (w.kind) {
    case 'packing': return 2_000
    case 'compressing':
    case 'restoring': return 5_000
    case 'packed':
    case 'failed': return 15_000
    default: return 5 * 60_000
  }
}

const readPack = () => api.storagePack()
const startPack = () => api.startPack()

/**
 * The indicator's state and its one action. `start` posts the pack and
 * reads again at once; its refusal (no disk room, one already running) is
 * kept as `error` for the line to say.
 */
export function useDbWork(
  read: () => Promise<PackReport> = readPack,
  post: () => Promise<PackReport> = startPack,
): { work?: DbWork; start: () => Promise<void>; error: string; snooze: () => void } {
  const [report, setReport] = useState<PackReport>()
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)
  const snooze = useSnooze()
  const owner = !isPairedDevice()
  const alive = useRef(true)
  const now = Date.now()
  const work = owner ? dbWork(report, now, snooze) : undefined
  // While the daemon reads its page sample the offer is a few seconds away.
  const wait = report?.pack.estimating ? 5_000 : pollMs(work)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  useEffect(() => {
    if (!owner) return
    // One chain of reads per run of this effect: a read still in flight when
    // the effect re-runs must not start a second timer beside the new one.
    let live = true
    let t: ReturnType<typeof setTimeout> | undefined
    read().then((r) => { if (live && alive.current) setReport(r) }).catch(() => { /* keep what it knew */ })
      .finally(() => { if (live) t = setTimeout(() => setTick((n) => n + 1), wait) })
    const onFocus = () => setTick((n) => n + 1)
    window.addEventListener('focus', onFocus)
    return () => {
      live = false
      if (t) clearTimeout(t)
      window.removeEventListener('focus', onFocus)
    }
  }, [owner, read, wait, tick])
  const start = useCallback(async () => {
    setError('')
    try {
      const r = await post()
      if (alive.current) setReport(r)
    } catch (e) {
      if (alive.current) setError(errText(e))
    }
  }, [post])
  return { work, start, error, snooze: snoozePackOffer }
}
