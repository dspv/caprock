/**
 * The sidebar footer's hint to turn Compress tool output on (ADR-093;
 * .ai/04-ui.md § App sidebar footer).
 *
 * Owner, 2026-11-06, translated: "how will a user understand or learn that
 * they need to turn on compression? Put it somewhere, e.g. in the Caprock
 * indicator at the bottom". The switch is off by default and lives in
 * Settings → Storage, where an existing user never looks.
 *
 * **Every figure is the user's own.** The daemon copies the database's
 * measured size and the saving estimated from a sample of their own tool
 * calls out of its daily storage measurement (`compress_offer` on
 * `/v1/status`); the line says *about*, because the saving is an estimate.
 * Nothing is computed here, and nothing is asked of the daemon but a status
 * read: at start, on focus at most every ten minutes, and after the switch
 * moves.
 *
 * **Quiet, and only where it matters.** Shown while the switch is off and the
 * estimate is at least `MIN_SAVING`; never on a small install. A click opens
 * the switch; it never turns it on. *Not now* hides it for 30 days, per
 * browser.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { api, isPairedDevice, type Status } from './api'
import { fmtBytes } from './format'
import { REVEAL_EVENT } from '@/components/SettingsParts'

export type CompressOffer = NonNullable<Status['compress_offer']>

/** Below this estimated saving the hint is not worth a line (decimal, as fmtBytes counts). */
export const MIN_SAVING = 300_000_000

/** How long *Not now* hides the hint. */
export const SNOOZE_MS = 30 * 24 * 60 * 60 * 1000

/** The time until which *Not now* hides the hint, in milliseconds. */
export const SNOOZE_KEY = 'caprock.compressHint.snoozedUntil'

/** Sent by the Storage switch when it moves, so the hint goes at once. */
export const COMPRESS_CHANGED_EVENT = 'caprock:compress-changed'

/** The Storage section's id (SettingsParts.sectionId('Storage')). */
export const STORAGE_SECTION = 'settings-storage'

/** How often a regained focus may read the status again. */
const REFRESH_MS = 10 * 60 * 1000

/** Whether the hint shows: an offer worth a line, not snoozed. */
export function compressHintShown(offer: CompressOffer | undefined, snoozedUntil: number, now: number): offer is CompressOffer {
  if (!offer || offer.sample_rows <= 0 || offer.db_bytes <= 0) return false
  if (offer.est_saving_bytes < MIN_SAVING) return false
  return now >= snoozedUntil
}

/** The hint's one line. */
export function compressHintText(o: CompressOffer): string {
  return `Database ${fmtBytes(o.db_bytes)} · compressing frees about ${fmtBytes(o.est_saving_bytes)}`
}

/** The tooltip: the line, where the figure comes from, what a click does. */
export function compressHintTitle(o: CompressOffer): string {
  return `${compressHintText(o)} (an estimate from ${o.sample_rows.toLocaleString('en-US')} of your tool calls). ` +
    'Click to open Settings → Storage and turn on Compress tool output.'
}

function readSnooze(): number {
  try {
    const v = Number(localStorage.getItem(SNOOZE_KEY) ?? 0)
    return Number.isFinite(v) ? v : 0
  } catch { return 0 }
}

let snoozedUntil = readSnooze()
const subs = new Set<() => void>()

/** *Not now*: hide the hint for SNOOZE_MS from `now`. */
export function snoozeCompressHint(now = Date.now()): void {
  snoozedUntil = now + SNOOZE_MS
  try { localStorage.setItem(SNOOZE_KEY, String(snoozedUntil)) } catch { /* hidden for this page only */ }
  for (const f of subs) f()
}

/** For tests: read the snooze from storage again. */
export function reloadCompressSnooze(): void {
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

/** The Storage switch moved: the hint asks again, and goes at once when it is on. */
export function noteCompressChanged(on: boolean): void {
  window.dispatchEvent(new CustomEvent<boolean>(COMPRESS_CHANGED_EVENT, { detail: on }))
}

const readStatus = () => api.status()

/**
 * The offer to show, or undefined. A paired device never sees it: the
 * switch is the machine owner's (ADR-029).
 */
export function useCompressHint(read: () => Promise<Pick<Status, 'compress_offer'>> = readStatus): CompressOffer | undefined {
  const [offer, setOffer] = useState<CompressOffer>()
  const snooze = useSnooze()
  const owner = !isPairedDevice()
  useEffect(() => {
    if (!owner) return
    let alive = true
    let last = 0
    const ask = () => {
      last = Date.now()
      read().then((s) => { if (alive) setOffer(s.compress_offer) }).catch(() => { /* keep what it knew */ })
    }
    const onFocus = () => { if (Date.now() - last >= REFRESH_MS) ask() }
    const onChanged = (e: Event) => {
      if ((e as CustomEvent<boolean>).detail) setOffer(undefined)
      ask()
    }
    ask()
    window.addEventListener('focus', onFocus)
    window.addEventListener(COMPRESS_CHANGED_EVENT, onChanged)
    return () => {
      alive = false
      window.removeEventListener('focus', onFocus)
      window.removeEventListener(COMPRESS_CHANGED_EVENT, onChanged)
    }
  }, [owner, read])
  return compressHintShown(offer, snooze, Date.now()) ? offer : undefined
}

/** Where a click on the hint goes. */
export const COMPRESS_HINT_TARGET = '#/settings'

/**
 * Open Settings on the Compress tool output switch: the Storage section
 * unfolded, the switch scrolled into the middle and lit for a moment. The
 * switch is left as it is; turning it on is the user's click there.
 */
export function openCompressSwitch(): void {
  location.hash = COMPRESS_HINT_TARGET
  let tries = 0
  let unfolded = false
  const look = () => {
    if (typeof document === 'undefined') return
    const section = document.getElementById(STORAGE_SECTION)
    // A folded section has no switch in it: unfold it, then look again.
    if (section && !unfolded) {
      unfolded = true
      window.dispatchEvent(new CustomEvent(REVEAL_EVENT, { detail: STORAGE_SECTION }))
    }
    const el = section?.querySelector<HTMLElement>('[data-compress-tool-output]')
    if (el) { lightSwitch(el); return }
    // The panel draws after its own read of /v1/storage: up to five seconds.
    if (++tries < 200) setTimeout(look, 25)
  }
  setTimeout(look, 0)
}

function lightSwitch(el: HTMLElement): void {
  el.scrollIntoView?.({ block: 'center' })
  el.dataset.compressLit = ''
  el.style.transition = 'box-shadow 700ms ease-out'
  el.style.borderRadius = '8px'
  el.style.boxShadow = '0 0 0 2px var(--color-accent)'
  setTimeout(() => { el.style.boxShadow = '' }, 2400)
  setTimeout(() => { delete el.dataset.compressLit; el.style.transition = '' }, 3200)
}
