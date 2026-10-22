/**
 * The sidebar's two blocks under the list, Second Brain and a private
 * module's row (ADR-076, amended 2026-10-22), unfold as an accordion: opening
 * one folds the other (owner, 2026-10-22, translated: "one expands while the
 * other collapses"). Each fold is kept in this browser, as the sidebar keeps
 * its other folds; read from storage on every look, so a change in another
 * window or a test's setup is seen as it is.
 */
import { useSyncExternalStore } from 'react'

/** Second Brain's fold: 'open', 'closed', or unset (folded by default). */
export const BRAIN_FOLD_KEY = 'caprock.app.brain-fold'
/** The id of the module whose row is unfolded; unset when none is. */
export const MODULE_FOLD_KEY = 'caprock.app.module-fold'

const listeners = new Set<() => void>()

function read(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch { /* a private window: not kept */ }
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  window.addEventListener('storage', l)
  return () => {
    listeners.delete(l)
    window.removeEventListener('storage', l)
  }
}

function changed(): void {
  for (const l of listeners) l()
}

function brainFold(): 'open' | 'closed' | null {
  const v = read(BRAIN_FOLD_KEY)
  return v === 'open' || v === 'closed' ? v : null
}

/** Second Brain's fold as this browser keeps it. */
export function useBrainFold(): 'open' | 'closed' | null {
  return useSyncExternalStore(subscribe, brainFold, brainFold)
}

/** Which module's row is unfolded, if any. */
export function useModuleFold(): string | null {
  return useSyncExternalStore(subscribe, () => read(MODULE_FOLD_KEY), () => null)
}

/** Unfolds or folds Second Brain; unfolding it folds a module's row. */
export function setBrainFold(open: boolean): void {
  write(BRAIN_FOLD_KEY, open ? 'open' : 'closed')
  if (open) write(MODULE_FOLD_KEY, null)
  changed()
}

/** Unfolds a module's row (null folds it); unfolding one folds Second Brain. */
export function setModuleFold(id: string | null): void {
  write(MODULE_FOLD_KEY, id)
  if (id !== null) write(BRAIN_FOLD_KEY, 'closed')
  changed()
}
