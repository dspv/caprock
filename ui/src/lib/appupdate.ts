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
 * Updates, or — with Update automatically chosen — once the daemon reports
 * a newer version (components/AppAutoUpdate).
 *
 * The two can disagree for a few minutes after a release: the daemon sees it
 * as soon as GitHub publishes it, `latest.json` is uploaded minutes later
 * (owner, 2026-11-23: the panel said *v0.190.0 is out* over a button that
 * installed 0.189.1, and never looked again). While the updater offers
 * nothing newer than this app, or something older than the release the
 * daemon knows, that is a gap (`updaterGap`): the offer is `preparing`, the
 * older bundle is not offered, and `useGapRecheck` asks for `latest.json`
 * again every GAP_RECHECK_MS, at most GAP_RECHECK_MAX times per release, and
 * when the version panel opens, until the two agree. Install and download
 * carry the daemon's version (`known`) so the shell never installs an older
 * bundle in its name (app/src-tauri/src/updater.rs `behind`).
 */
import { useEffect, useSyncExternalStore } from 'react'
import { isTauri } from './appmode'
import { shell } from './shell'
import type { UpdateStatus } from './api'

export type AppUpdatePhase =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'up_to_date' }
  | { phase: 'available'; next: string }
  | { phase: 'downloading'; next: string; downloaded: number; total: number | null }
  /** Downloaded and verified, held until the install (Update automatically). */
  | { phase: 'ready'; next: string }
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
let background = 0
/** The release a background re-check (`appUpdate.recheck`) is looking for. */
let recheckingFor = ''
/** When the last gap re-check started, and how many ran for `gapFor`. */
let lastGapCheck = 0
let gapFor = ''
let gapTries = 0

/** How often `latest.json` is asked again while the app update lags the release. */
export const GAP_RECHECK_MS = 2 * 60_000
/** At most this many re-checks per release (about 16 minutes); then *Check now*. */
export const GAP_RECHECK_MAX = 8
/** Opening the version panel re-checks at most this often. */
export const GAP_OPEN_MIN_MS = 20_000

/** The updater's last known state, outside React. */
export function appUpdateNow(): AppUpdateInfo | undefined { return current }

/** A background download (Update automatically) is running. */
export function inBackground(): boolean { return background > 0 }
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
  check: () => shell.updateCheck().then((i) => { set(i); return i }, () => undefined),
  /** Download and verify in the background, install later (Update automatically).
   *  While it runs, `inBackground()` is true: its "checking" is nobody's question.
   *  `known` is the daemon's newest release: an older bundle is not fetched. */
  download: (known?: string) => {
    background++
    return shell.updateDownload(known).then((i) => { set(i); background-- }, () => { background-- })
  },
  /** Download, verify, install and restart; resolves only if it did not.
   *  `known` is the daemon's newest release: an older bundle is not installed in its name. */
  install: (known?: string) => shell.updateInstall(known).then(set, () => {}),
  /** Fetch latest.json again while a gap lasts; nobody's question, so the
   *  strip does not flash *Checking…* and the offer stays `preparing`. */
  recheck: (known: string) => {
    background++
    recheckingFor = known
    return shell.updateCheck().then((i) => { set(i); background--; recheckingFor = '' }, () => { background--; recheckingFor = '' })
  },
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

/**
 * While the app update lags the release (`updaterGap`), ask for
 * `latest.json` again every GAP_RECHECK_MS, at most GAP_RECHECK_MAX times
 * per release; the gap closing (or a newer release) stops or restarts it.
 * The same URL a click on Check for Updates fetches (rule 4), and only after
 * the updater has answered once: an app that never asked makes no request.
 */
export function useGapRecheck(info: AppUpdateInfo | undefined, st: UpdateStatus | undefined) {
  const gap = updaterGap(info, st)
  useEffect(() => {
    if (!gap) return
    if (gapFor !== gap) { gapFor = gap; gapTries = 0 }
    const t = window.setInterval(() => {
      if (gapTries >= GAP_RECHECK_MAX) { window.clearInterval(t); return }
      if (recheckingFor || inBackground()) return
      gapTries++
      lastGapCheck = Date.now()
      void appUpdate.recheck(gap)
    }, GAP_RECHECK_MS)
    return () => window.clearInterval(t)
  }, [gap])
}

/** The gap re-checks for `latest` have not run out (GAP_RECHECK_MAX). */
export function gapRechecking(latest: string): boolean {
  return gapFor !== latest || gapTries < GAP_RECHECK_MAX
}

/**
 * The version panel opened: when the daemon knows a newer release than the
 * updater offers (or the updater has not asked yet), ask now. At most once
 * every GAP_OPEN_MIN_MS, and never over a check, download or install.
 */
export function recheckOnOpen(info: AppUpdateInfo | undefined, st: UpdateStatus | undefined): boolean {
  const latest = knownLatest(st)
  if (!info?.supported || !latest || !newerVersion(latest, info.version)) return false
  const lags = info.phase === 'idle' || info.phase === 'up_to_date'
    || ((info.phase === 'available' || info.phase === 'ready') && newerVersion(latest, info.next))
  if (!lags || recheckingFor || inBackground() || Date.now() - lastGapCheck < GAP_OPEN_MIN_MS) return false
  // Never asked: an ordinary check, whose *checking* the panel shows. A known
  // gap: the quiet re-check, so the panel keeps saying it is being prepared.
  lastGapCheck = Date.now()
  if (info.phase === 'idle') {
    void appUpdate.check()
  } else {
    void appUpdate.recheck(latest)
  }
  return true
}

/** Tests only: forget the state and listen afresh. */
export function resetAppUpdate() {
  if (typeof window !== 'undefined') window.removeEventListener(APP_UPDATE_EVENT, onEvent)
  started = false
  current = undefined
  background = 0
  recheckingFor = ''
  lastGapCheck = 0
  gapFor = ''
  gapTries = 0
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
  /** The daemon knows `latest`, the app's updater does not offer it yet
   *  (`latest.json` is uploaded minutes after the release): nothing to
   *  install, checking again. The older bundle is deliberately not offered. */
  | { kind: 'preparing'; latest: string }

/** A version as the daemon writes it, with the v. */
export const v = (s: string) => (s.startsWith('v') ? s : `v${s}`)

/** The newest release the daemon's check knows, with the v; '' with checks off. */
export function knownLatest(st: UpdateStatus | undefined): string {
  return st?.enabled && st.latest ? v(st.latest) : ''
}

/**
 * The release the daemon knows and the app's updater does not offer yet, or
 * ''. A gap is only claimed once the updater has answered: up to date, or
 * an offer (available, or downloaded and held) older than that release.
 * Idle has not asked, and checking, a download or an install is under way.
 */
export function updaterGap(info: AppUpdateInfo | undefined, st: UpdateStatus | undefined): string {
  const latest = knownLatest(st)
  if (!info?.supported || !latest || !newerVersion(latest, info.version)) return ''
  switch (info.phase) {
    case 'up_to_date': return latest
    case 'available':
    case 'ready': return newerVersion(latest, info.next) ? latest : ''
    case 'checking': return recheckingFor && v(recheckingFor) === latest ? latest : ''
    default: return ''
  }
}

/**
 * The offer from the app's updater and the daemon's release check. A newer
 * release the daemon knows of is offered as one click when this install can
 * replace itself, else as the command for how it was installed; `dismissed`
 * (Not now) hides a passive offer for that version, never the answer to a
 * check the user asked for.
 */
export function offerFor(info: AppUpdateInfo | undefined, st: UpdateStatus | undefined, dismissed: string): Offer {
  if (info?.supported) {
    // The release is out, its app update is not: never the older bundle
    // under the newer version's name.
    const gap = updaterGap(info, st)
    if (gap) return dismissed === gap ? { kind: 'none' } : { kind: 'preparing', latest: gap }
    switch (info.phase) {
      case 'checking': return { kind: 'checking' }
      case 'downloading': return { kind: 'progress', next: v(info.next), pct: info.total ? Math.min(100, Math.floor((info.downloaded / info.total) * 100)) : null }
      case 'installing': return { kind: 'installing', next: v(info.next) }
      case 'failed': return { kind: 'failed', error: info.error }
      case 'available':
      case 'ready': return dismissed === v(info.next) ? { kind: 'none' } : { kind: 'install', next: v(info.next) }
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
