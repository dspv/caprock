/**
 * Update automatically (Settings → Updates, `app_update: "auto"`; ADR-042 as
 * amended 2026-10-15): the rules for when the desktop app may restart into a
 * downloaded update on its own. The component that acts on them is
 * components/AppAutoUpdate.
 *
 * A restart is safe only when all of these hold at once:
 *
 * - **No agent is working or waiting on a permission prompt** in any tab —
 *   the daemon's count (`GET /v1/update/busy`, the keep-awake count). Not
 *   knowing (the request failed) counts as busy.
 * - **The user has been away for two minutes** — no key, click, pointer
 *   move or scroll on the page.
 * - **Nothing is typed into a text field** on the page — a draft a reload
 *   would lose. The terminal's own input line is not one: it lives in the
 *   session's process, which the restart does not touch.
 * - **The user did not say Not now** to this version within the hour.
 *
 * Then a ten-second notice with Not now, and the restart.
 */
import { newerVersion, v } from './appupdate'

/** How long the page must have been left alone. */
export const IDLE_MS = 2 * 60_000
/** The notice before the restart, in seconds. */
export const COUNTDOWN_S = 10
/** How long Not now holds an update back. */
export const POSTPONE_MS = 60 * 60_000
/** How often a waiting update looks again. */
export const RECHECK_MS = 30_000
/** How long after a failed download it is tried again. */
export const RETRY_FAILED_MS = 60 * 60_000

/** Why the app may not restart now; null when it may. */
export type Blocker =
  | { kind: 'busy'; working: number }
  | { kind: 'unknown' }
  | { kind: 'active'; idleMs: number }
  | { kind: 'draft' }
  | { kind: 'postponed'; until: number }

export interface RestartState {
  /** Sessions working or waiting on a permission prompt; undefined when the count could not be read. */
  working: number | undefined
  /** Milliseconds since the last key, click, pointer move or scroll on the page. */
  idleMs: number
  /** Something is typed into a text field. */
  draft: boolean
  now: number
  /** Not now holds the update until then (ms), 0 when not postponed. */
  postponedUntil: number
}

/** The first reason not to restart now, or null when it is safe. */
export function restartBlocker(s: RestartState): Blocker | null {
  if (s.postponedUntil > s.now) return { kind: 'postponed', until: s.postponedUntil }
  if (s.working === undefined) return { kind: 'unknown' }
  if (s.working > 0) return { kind: 'busy', working: s.working }
  if (s.idleMs < IDLE_MS) return { kind: 'active', idleMs: s.idleMs }
  if (s.draft) return { kind: 'draft' }
  return null
}

/** A blocker in words, for the Settings line and the strip's tooltip. */
export function blockerText(b: Blocker): string {
  switch (b.kind) {
    case 'busy': return b.working === 1 ? 'waiting: an agent is working' : `waiting: ${b.working} agents are working`
    case 'unknown': return 'waiting: could not tell whether an agent is working'
    case 'active': return 'waiting until you step away for 2 minutes'
    case 'draft': return 'waiting: something is typed and not sent'
    case 'postponed': return 'held back for an hour (Not now)'
  }
}

let lastActivity = Date.now()
let tracking = false
const ACTIVITY = ['keydown', 'pointerdown', 'pointermove', 'wheel', 'touchstart'] as const
const touch = () => { lastActivity = Date.now() }

/** Starts listening for the user on this page; once per page. */
export function trackActivity() {
  if (tracking || typeof window === 'undefined') return
  tracking = true
  for (const e of ACTIVITY) window.addEventListener(e, touch, { capture: true, passive: true })
}

/** Milliseconds since the user last did anything on the page. */
export function idleFor(now = Date.now()): number {
  return Math.max(0, now - lastActivity)
}

/** Tests only: pretend the last activity was at `t`. */
export function setLastActivity(t: number) { lastActivity = t }

const TEXT_INPUTS = new Set(['text', 'search', 'email', 'url', 'tel', ''])

/**
 * Something typed and not sent, which a restart would lose: a non-empty
 * text area or editable block anywhere on the page, or the focused text
 * input. xterm's own hidden text area is skipped — what is typed into a
 * terminal is in the session's process, which survives — and so are
 * inputs not in focus: a filter left in a search box is not a draft.
 */
export function hasDraft(root: ParentNode = document): boolean {
  for (const el of Array.from(root.querySelectorAll<HTMLTextAreaElement>('textarea'))) {
    if (el.classList.contains('xterm-helper-textarea') || el.readOnly || el.disabled) continue
    if (el.value.trim()) return true
  }
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[contenteditable="true"], [contenteditable=""]'))) {
    if ((el.textContent ?? '').trim()) return true
  }
  const active = typeof document !== 'undefined' ? document.activeElement : null
  if (active instanceof HTMLInputElement && TEXT_INPUTS.has(active.type) && !active.readOnly && active.value.trim()) {
    return root.contains(active)
  }
  return false
}

/** What the app installed on its own, so the next start can say so. */
export const UPDATED_KEY = 'caprock.update.autoInstalled'

/** Before an automatic install: remember the version, for the note after the restart. */
export function rememberAutoInstall(next: string) {
  try { localStorage.setItem(UPDATED_KEY, v(next)) } catch { /* no note, the update still runs */ }
}

/**
 * After a start: the version the app updated itself to, once, when it is
 * the one now running. A note left by an install that did not happen (the
 * app is still older) waits for it; one this version has passed is dropped.
 */
export function takeUpdatedNote(version: string): string | null {
  let stored = ''
  try { stored = localStorage.getItem(UPDATED_KEY) ?? '' } catch { return null }
  if (!stored) return null
  if (stored === v(version)) {
    try { localStorage.removeItem(UPDATED_KEY) } catch { /* shown once more at worst */ }
    return stored
  }
  if (!newerVersion(stored, version)) {
    try { localStorage.removeItem(UPDATED_KEY) } catch { /* stale */ }
  }
  return null
}
