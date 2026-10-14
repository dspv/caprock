/**
 * How the cockpit draws its Context and Plan limits sections, per viewer:
 * *compact*, one line each high in the cockpit, or *full*, the meter and
 * the window bars with their lines. Compact until a viewer opens one
 * (owner, 2026-10-14, translated: "make it compact or like now; plan and
 * limits too, two versions").
 *
 * Subagents and Recent tools fold the same way, on the same chevron:
 * *compact* is their heading alone with one line of what is in them, *full*
 * the rows. Full until a viewer folds one (owner, 2026-10-14, translated:
 * "Subagents and Recent tools should be collapsible like Context, Plan,
 * Spend").
 */
import { useSyncExternalStore } from 'react'

export type Look = 'compact' | 'full'

export interface CockpitLooks {
  context: Look
  limits: Look
  subagents: Look
  tools: Look
}

export const DEFAULT_LOOKS: CockpitLooks = { context: 'compact', limits: 'compact', subagents: 'full', tools: 'full' }

export const LOOKS_KEY = 'caprock.app.cockpit-looks'

/** Whatever was stored, made valid field by field. */
export function normalizeLooks(raw: unknown): CockpitLooks {
  const v = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  const look = (x: unknown, d: Look): Look => (x === 'compact' || x === 'full' ? x : d)
  return {
    context: look(v.context, DEFAULT_LOOKS.context),
    limits: look(v.limits, DEFAULT_LOOKS.limits),
    subagents: look(v.subagents, DEFAULT_LOOKS.subagents),
    tools: look(v.tools, DEFAULT_LOOKS.tools),
  }
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
