/**
 * A page never stays older than the daemon it talks to (.ai/21-app.md
 * § Updating the daemon).
 *
 * A daemon upgrade restarts the daemon under pages that stay loaded — a
 * browser tab, a phone, the desktop app's window. The live link reconnects to
 * the new daemon and everything looks fine, but the code running is the old
 * UI's: on 2026-10-07 the app's window ran 0.78.1's UI against a 0.78.2
 * daemon for the rest of the run, and nothing could bring it forward.
 *
 * So the page knows which daemon served it — the daemon writes its version
 * into the page as `<meta name="caprock-version">` (internal/api/ui.go);
 * failing that (the Vite dev server), the first `/v1/status` the page reads —
 * and every time the live link opens again it asks `/v1/status` which daemon
 * answers now. A different version means a different UI:
 *
 * - **Reload at once**, keeping the URL and so the route. A terminal's
 *   half-typed line lives in its pty-host, not in the page, so a reload
 *   loses nothing typed there.
 * - **Offer instead** — a "Reload — Caprock was updated" pill in the status
 *   strip, or the dashboard's header — when a modal sheet holds typed text,
 *   which a reload would lose.
 * - **Never loop**: a page reloaded once for a version that still reads
 *   stale offers rather than reloading again.
 *
 * Kept free of React (but for the hook) so the policy can be tested directly.
 */
import { useSyncExternalStore } from 'react'
import { api } from './api'
import { live } from './live'

/** The version a reload was made for, per tab: the loop guard. */
export const RELOADED_KEY = 'caprock.ui.reloadedFor'

/** The version of the daemon that served this page, from the meta it wrote. */
export function servedVersion(doc: Document = document): string | undefined {
  const v = doc.querySelector<HTMLMetaElement>('meta[name="caprock-version"]')?.content?.trim()
  return v || undefined
}

export type StaleAction = 'none' | 'reload' | 'offer'

export interface StaleFacts {
  /** The daemon that served the page. */
  served?: string
  /** The daemon that answers now. */
  running?: string
  /** The version this tab already reloaded for, if any. */
  reloadedFor?: string | null
  /** A modal sheet holds typed text a reload would lose. */
  unsaved: boolean
}

/** What to do about the daemon that answers now. */
export function staleAction(f: StaleFacts): StaleAction {
  if (!f.served || !f.running || f.served === f.running) return 'none'
  if (f.reloadedFor === f.running) return 'offer'
  return f.unsaved ? 'offer' : 'reload'
}

const TEXT_TYPES = new Set(['', 'text', 'search', 'url', 'email', 'tel', 'number', 'password'])

/**
 * Whether an open modal sheet holds typed text. Only modal sheets count: a
 * terminal keeps its input in the pty-host, and a filter field in the page is
 * cheap to retype.
 */
export function hasUnsavedInput(doc: Document = document): boolean {
  const fields = doc.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    '[role="dialog"] textarea, [role="dialog"] input, [aria-modal="true"] textarea, [aria-modal="true"] input',
  )
  for (const f of fields) {
    if (f.closest('[hidden]')) continue
    if (f instanceof HTMLInputElement && !TEXT_TYPES.has(f.type)) continue
    if (f.value.trim() !== '') return true
  }
  return false
}

// The store behind the pill: the version the page is stale against, while
// it waits for a click.
let offered: string | undefined
const listeners = new Set<() => void>()
function setOffered(v: string | undefined) {
  if (offered === v) return
  offered = v
  for (const l of listeners) l()
}
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
const getOffered = () => offered

/** The newer daemon's version while the page offers a reload; undefined otherwise. */
export function useStaleUi(): string | undefined {
  return useSyncExternalStore(subscribe, getOffered, getOffered)
}

function readKey(): string | null {
  try { return sessionStorage.getItem(RELOADED_KEY) } catch { return null }
}
function writeKey(v: string | null) {
  try {
    if (v === null) sessionStorage.removeItem(RELOADED_KEY)
    else sessionStorage.setItem(RELOADED_KEY, v)
  } catch { /* private mode: a second stale read offers, as the guard is lost */ }
}

/** Reloads the page for the daemon at `running`, recording it so it is done once. */
export function reloadFor(running: string, reload: () => void = () => location.reload()) {
  writeKey(running)
  reload()
}

export interface WatchDeps {
  status: () => Promise<{ version: string }>
  /** Calls back on every change of the live link; returns the unsubscribe. */
  subscribe: (fn: () => void) => () => void
  /** Whether the live link is open. */
  isOpen: () => boolean
  reload: () => void
  doc: Document
}

const defaults = (): WatchDeps => ({
  status: () => api.status(),
  subscribe: (fn) => live.observe(fn),
  isOpen: () => live.getState().conn === 'open',
  reload: () => location.reload(),
  doc: document,
})

/**
 * Watches for a daemon newer (or older) than the page's, for the life of the
 * page: once at start, then each time the live link opens again. Returns
 * the stop.
 */
export function watchUiVersion(deps: Partial<WatchDeps> = {}): () => void {
  const d = { ...defaults(), ...deps }
  let served = servedVersion(d.doc)
  let stopped = false
  const check = () => {
    d.status().then((s) => {
      if (stopped || !s?.version) return
      if (!served) { served = s.version; return }
      const action = staleAction({ served, running: s.version, reloadedFor: readKey(), unsaved: hasUnsavedInput(d.doc) })
      if (action === 'reload') { setOffered(undefined); reloadFor(s.version, d.reload); return }
      if (action === 'offer') { setOffered(s.version); return }
      // The page matches its daemon: the guard is spent, the pill is gone.
      writeKey(null)
      setOffered(undefined)
    }).catch(() => { /* the daemon is away: the next open asks again */ })
  }
  check()
  let open = d.isOpen()
  const unsub = d.subscribe(() => {
    const now = d.isOpen()
    if (now && !open) check()
    open = now
  })
  return () => { stopped = true; unsub() }
}

/** Test hook: the pill's store back to empty. */
export function resetStaleUi() { setOffered(undefined) }
