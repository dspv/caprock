/**
 * How the cockpit draws its Context and Plan limits sections, per viewer:
 * *compact*, one line each high in the cockpit, or *full*, the meter and
 * the window bars with their lines. Compact until a viewer opens one
 * (owner, 2026-10-14, translated: "make it compact or like now; plan and
 * limits too, two versions").
 *
 * Every other section folds the same way, on the same chevron: *compact*
 * is its heading alone with the one line of figures it carries at its
 * right, *full* the whole section. Full until a viewer folds one (owner,
 * 2026-10-14, translated: "Subagents and Recent tools should be collapsible
 * like Context, Plan, Spend", then "every section, the CI and Processes
 * too").
 */
import { useSyncExternalStore } from 'react'

export type Look = 'compact' | 'full'

export interface CockpitLooks {
  context: Look
  limits: Look
  subagents: Look
  tools: Look
  now: Look
  tasks: Look
  changes: Look
  ci: Look
  processes: Look
}

export const DEFAULT_LOOKS: CockpitLooks = {
  context: 'compact', limits: 'compact', subagents: 'full', tools: 'full',
  now: 'full', tasks: 'full', changes: 'full', ci: 'full', processes: 'full',
}

export const LOOKS_KEY = 'caprock.app.cockpit-looks'

/** Whatever was stored, made valid field by field. */
export function normalizeLooks(raw: unknown): CockpitLooks {
  const v = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  const look = (x: unknown, d: Look): Look => (x === 'compact' || x === 'full' ? x : d)
  const out = { ...DEFAULT_LOOKS }
  for (const k of Object.keys(DEFAULT_LOOKS) as (keyof CockpitLooks)[]) out[k] = look(v[k], DEFAULT_LOOKS[k])
  return out
}

let current: CockpitLooks | undefined
const listeners = new Set<() => void>()

export function getLooks(): CockpitLooks {
  if (current) return current
  try {
    const s = localStorage.getItem(LOOKS_KEY)
    current = normalizeLooks(s ? JSON.parse(s) : undefined)
  } catch {
    current = DEFAULT_LOOKS
  }
  return current
}

export function setLook(section: keyof CockpitLooks, look: Look): void {
  current = { ...getLooks(), [section]: look }
  try {
    localStorage.setItem(LOOKS_KEY, JSON.stringify(current))
  } catch {
    // Private storage: the choice holds until the window closes.
  }
  for (const fn of listeners) fn()
}

/** For tests: forget what was read, so the next read is from storage. */
export function resetLooksForTest(): void {
  current = undefined
}

export function useLooks(): CockpitLooks {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    getLooks,
    getLooks,
  )
}
