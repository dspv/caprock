/**
 * A release check when the window comes to the front (owner, 2026-10-16:
 * a release had been out for twelve minutes and the app said nothing).
 *
 * The daemon checks every 15 minutes on its own; this asks it for one more
 * when the user looks — the window gains focus or is shown — if the last
 * check is at least ten minutes old. The daemon holds the same floor
 * (`update.SoonInterval`), so however often the window is switched to,
 * unforced checks stay at one per ten minutes between the two. Only while
 * Settings → Updates allows checks (rule 4); the daemon refuses otherwise.
 */
import { api, type UpdateStatus } from './api'
import { onPageVisibility } from './visible'

/** No focus check sooner than this after the last check of any kind. */
export const SOON_MS = 10 * 60_000

let askedAt = 0
let inflight: Promise<UpdateStatus | undefined> | null = null

/** Whether a focus check is due: checks on, and neither this page's last
 *  ask nor the daemon's last check (`checked_at`) is ten minutes old. */
export function soonDue(st: UpdateStatus | undefined, now: number, asked = askedAt): boolean {
  if (!st?.enabled) return false
  const last = Math.max(asked, st.checked_at ?? 0)
  return now - last >= SOON_MS
}

/**
 * Asks the daemon for a focus check when one is due; resolves to the fresh
 * status, or is null when nothing was asked. Every caller in the same moment
 * shares one request.
 */
export function askSoon(st: UpdateStatus | undefined, now = Date.now()): Promise<UpdateStatus | undefined> | null {
  if (inflight) return inflight
  if (!soonDue(st, now)) return null
  askedAt = now
  inflight = api.checkUpdateSoon()
    .catch(() => undefined)
    .finally(() => { inflight = null })
  return inflight
}

/** Calls `fn` when the window gains focus or the page is shown. Returns the stop. */
export function onWindowFront(fn: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener('focus', fn)
  const off = onPageVisibility((hidden) => { if (!hidden) fn() })
  return () => { window.removeEventListener('focus', fn); off() }
}

/** For tests: forget the last ask. */
export function resetSoon(): void {
  askedAt = 0
  inflight = null
}
