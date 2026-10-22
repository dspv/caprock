/**
 * The update card folded into the status strip (owner, 2026-10-22,
 * translated: "I want this to be collapsible, with the status continuing to
 * show only in the bottom line. Orca does it that way").
 *
 * The card (components/AppUpdateToast) folds for one version: the strip's
 * update line (components/AppUpdateNotice) then shows a compact item, and a
 * click on it unfolds the card. A newer version starts unfolded, because the
 * key holds the version that was folded, not a yes/no.
 *
 * `lastNext` is the version the card last showed on its way in (offered,
 * downloading, ready or installing). A failed phase carries no version, so
 * this is how a failure is put to the folded card's version: the strip says
 * it in the warn colour and a click opens the card on the error.
 */
import { useSyncExternalStore } from 'react'

/** The version (with its v) whose card is folded into the strip. */
export const FOLD_KEY = 'caprock.update.cardFolded'

export type UpdateCardState = {
  /** The folded version, or ''. */
  folded: string
  /** The version the card last showed, or ''. */
  lastNext: string
  /** The card was opened on a failure; it shows the error until closed or folded. */
  error: boolean
}

function readFolded(): string {
  try { return localStorage.getItem(FOLD_KEY) ?? '' } catch { return '' }
}

let state: UpdateCardState = { folded: readFolded(), lastNext: '', error: false }
const subs = new Set<() => void>()

function set(patch: Partial<UpdateCardState>) {
  const next = { ...state, ...patch }
  if (next.folded === state.folded && next.lastNext === state.lastNext && next.error === state.error) return
  state = next
  for (const f of subs) f()
}

function saveFolded(version: string) {
  try {
    if (version) localStorage.setItem(FOLD_KEY, version)
    else localStorage.removeItem(FOLD_KEY)
  } catch { /* folded for this page only */ }
}

export const updateCard = {
  /** Fold the card for this version; its status goes on in the strip. */
  fold(version: string) {
    saveFolded(version)
    set({ folded: version, error: false })
  },
  /** Unfold it (a click on the strip's item). On a failure, onto the error. */
  unfold(failed = false) {
    saveFolded('')
    set({ folded: '', error: failed })
  },
  /** The card shows this version on its way in. */
  note(version: string) { set({ lastNext: version }) },
  /** The error was read and closed; the strip's own *Update failed* stays. */
  closeError() { set({ error: false }) },
}

/** The failure belongs to the card: folded with its version, or opened on it. */
export function cardOwnsFailure(s: UpdateCardState = state): boolean {
  return !!s.lastNext && (s.folded === s.lastNext || s.error)
}

export function useUpdateCard(): UpdateCardState {
  return useSyncExternalStore(
    (f) => { subs.add(f); return () => { subs.delete(f) } },
    () => state,
    () => state,
  )
}

/** Tests only: read the key again and forget the rest. */
export function resetUpdateCard() {
  state = { folded: readFolded(), lastNext: '', error: false }
}
