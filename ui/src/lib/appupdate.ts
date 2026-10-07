/**
 * The desktop app's own updater (F20, ADR-042), as the page sees it: the
 * app's version, whether this install can replace itself, the first-launch
 * question, and where a check or an install stands. The shell holds the
 * state (app/src-tauri/src/updater.rs) and dispatches `caprock:app-update`
 * whenever it changes; outside the shell there is nothing here.
 *
 * What tells the page a newer release exists is still the daemon's release
 * check (`/v1/update`, off until the user turns it on). The shell fetches
 * `latest.json` only when asked to: a click on Update or on Check for
 * Updates.
 */
import { useSyncExternalStore } from 'react'
import { isTauri } from './appmode'
import { shell } from './shell'
import type { UpdateStatus } from './api'

export type AppUpdatePhase =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'up_to_date' }
  | { phase: 'available'; next: string }
  | { phase: 'downloading'; next: string; downloaded: number; total: number | null }
  | { phase: 'installing'; next: string }
  | { phase: 'failed'; error: string }

export type AppUpdateInfo = {
  /** This app's own version, without a leading v. */
  version: string
  /** Whether this install can update itself; `blocked` says why not. */
  supported: boolean
  blocked?: string
  /** The first-launch question has been answered. */
  asked: boolean
} & AppUpdatePhase

/** The event the shell dispatches with the new state as its detail. */
export const APP_UPDATE_EVENT = 'caprock:app-update'

let current: AppUpdateInfo | undefined
let started = false
const subs = new Set<() => void>()

function set(i: AppUpdateInfo | undefined) {
  current = i
  for (const f of subs) f()
}

function onEvent(e: Event) {
  const d = (e as CustomEvent<AppUpdateInfo>).detail
  if (d && typeof d === 'object' && typeof d.phase === 'string') set(d)
}

function start() {
  if (started || !isTauri()) return
  started = true
  window.addEventListener(APP_UPDATE_EVENT, onEvent)
  void appUpdate.refresh()
}

export const appUpdate = {
  refresh: () => shell.updateStatus().then(set, () => { /* an older shell: no updater */ }),
  /** Fetch latest.json once (Check for Updates). */
  check: () => shell.updateCheck().then(set, () => {}),
  /** Download, verify, install and restart; resolves only if it did not. */
  install: () => shell.updateInstall().then(set, () => {}),
  /** The first-launch question was answered. */
  asked: () => shell.updateAsked().then(() => appUpdate.refresh(), () => {}),
}

/** The updater's state, or undefined outside the shell (or before it answers). */
export function useAppUpdate(): AppUpdateInfo | undefined {
  return useSyncExternalStore(
    (f) => { start(); subs.add(f); return () => { subs.delete(f) } },
    () => current,
    () => undefined,
  )
}

/** Tests only: forget the state and listen afresh. */
export function resetAppUpdate() {
  if (typeof window !== 'undefined') window.removeEventListener(APP_UPDATE_EVENT, onEvent)
  started = false
  current = undefined
}

/** `a` is a newer version than `b`; either may carry a leading v. Pre-release tags rank below the release. */
export function newerVersion(a?: string, b?: string): boolean {
  const parse = (v?: string) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?/.exec((v ?? '').trim())
    return m ? { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? '' } : undefined
  }
  const x = parse(a), y = parse(b)
  if (!x || !y) return false
  for (let i = 0; i < 3; i++) {
    const a = x.n[i] ?? 0, b = y.n[i] ?? 0
    if (a !== b) return a > b
  }
  if (x.pre === y.pre) return false
  if (!x.pre) return true
  if (!y.pre) return false
  return x.pre > y.pre
}

/** What the status strip offers. */
export type Offer =
  | { kind: 'none' }
  /** One click: download, verify, install, restart. */
  | { kind: 'install'; next: string }
  | { kind: 'checking' }
  | { kind: 'progress'; next: string; pct: number | null }
  | { kind: 'installing'; next: string }
  | { kind: 'failed'; error: string }
  | { kind: 'up_to_date'; version: string }
  /** The command or the release page: a browser, or an install that cannot update itself. */
  | { kind: 'commands'; latest: string }

/** A version as the daemon writes it, with the v. */
export const v = (s: string) => (s.startsWith('v') ? s : `v${s}`)

/**
 * The offer from the app's updater and the daemon's release check. A newer
 * release the daemon knows of is offered as one click when this install can
 * replace itself, else as the command for how it was installed; `dismissed`
 * (Not now) hides a passive offer for that version, never the answer to a
 * check the user asked for.
 */
export function offerFor(info: AppUpdateInfo | undefined, st: UpdateStatus | undefined, dismissed: string): Offer {
  if (info?.supported) {
    switch (info.phase) {
      case 'checking': return { kind: 'checking' }
      case 'downloading': return { kind: 'progress', next: v(info.next), pct: info.total ? Math.min(100, Math.floor((info.downloaded / info.total) * 100)) : null }
      case 'installing': return { kind: 'installing', next: v(info.next) }
      case 'failed': return { kind: 'failed', error: info.error }
      case 'available': return dismissed === v(info.next) ? { kind: 'none' } : { kind: 'install', next: v(info.next) }
      default: break
    }
    const latest = st?.enabled ? st.latest : undefined
    if (latest && newerVersion(latest, info.version) && dismissed !== latest) return { kind: 'install', next: v(latest) }
    if (info.phase === 'up_to_date') return { kind: 'up_to_date', version: v(info.version) }
    return { kind: 'none' }
  }
  if (!st?.enabled || !st.update_available || !st.latest || dismissed === st.latest) return { kind: 'none' }
  return { kind: 'commands', latest: st.latest }
}
