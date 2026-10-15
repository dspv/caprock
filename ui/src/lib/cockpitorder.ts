/**
 * The order of the cockpit's sections under the agent, per viewer (owner,
 * 2026-10-14, translated: "I want to be able to reorder the sections, but so
 * it doesn't trigger by accident — so everyone sets up what interests
 * them"; 2026-10-15: "reorderable by users … and to be able to move all of
 * it higher"). Changed in the cockpit's *Arrange* mode, by dragging a
 * section's own small handle (never its heading), by ⌥⇧↑ ⌥⇧↓ on that
 * handle, or from the handle's menu (Move up, Move down, Move to top, Reset
 * order); kept in localStorage. Anything stored that is not a known section
 * is dropped, and a section the stored order lacks takes its default place.
 */
import { useSyncExternalStore } from 'react'

export type CockpitSection = 'now' | 'context' | 'limits' | 'spend' | 'subagents' | 'tasks' | 'tools' | 'changes' | 'ci' | 'release' | 'processes'

/** The order the cockpit opens in, and what *Reset to default order* restores. */
export const DEFAULT_ORDER: readonly CockpitSection[] = ['now', 'context', 'limits', 'spend', 'subagents', 'tasks', 'tools', 'changes', 'ci', 'release', 'processes']

/** Each section's name, as its heading and the Arrange list say it. */
export const SECTION_NAMES: Record<CockpitSection, string> = {
  now: 'Now',
  context: 'Context',
  limits: 'Plan limits',
  spend: 'Spend',
  subagents: 'Subagents',
  tasks: 'Tasks',
  tools: 'Recent tools',
  changes: 'Changes',
  ci: 'CI',
  release: 'Release',
  processes: 'Processes',
}

export const ORDER_KEY = 'caprock.app.cockpit-order'

/**
 * Whatever was stored, made a whole order: the known sections in the stored
 * order, once each, and any one missing (a section added after the choice
 * was made) put back after the section that precedes it by default.
 */
export function normalizeOrder(raw: unknown): CockpitSection[] {
  const known = new Set<string>(DEFAULT_ORDER)
  const out: CockpitSection[] = []
  if (Array.isArray(raw)) {
    for (const x of raw) {
      if (typeof x === 'string' && known.has(x) && !out.includes(x as CockpitSection)) out.push(x as CockpitSection)
    }
  }
  DEFAULT_ORDER.forEach((id, i) => {
    if (out.includes(id)) return
    const before = DEFAULT_ORDER.slice(0, i).reverse().find((p) => out.includes(p))
    out.splice(before ? out.indexOf(before) + 1 : 0, 0, id)
  })
  return out
}

/** The order with one section moved a place up (-1) or down (+1); unchanged at an edge. */
export function moveSection(order: readonly CockpitSection[], id: CockpitSection, by: -1 | 1): CockpitSection[] {
  const next = [...order]
  const i = next.indexOf(id)
  const j = i + by
  if (i < 0 || j < 0 || j >= next.length) return next
  next[i] = next[j]!
  next[j] = id
  return next
}

/** The order with one section put at `index` (0 is the top), the others closing up around it. */
export function moveSectionTo(order: readonly CockpitSection[], id: CockpitSection, index: number): CockpitSection[] {
  const rest = order.filter((x) => x !== id)
  if (rest.length === order.length) return [...order]
  const at = Math.max(0, Math.min(rest.length, Math.round(index)))
  rest.splice(at, 0, id)
  return rest
}

/**
 * The order with a section moved one place among those `shown` (the
 * sections drawn for this session; one with nothing to show is skipped, so
 * every press moves it past a section the viewer can see): just above the
 * shown one before it (-1), or just below the one after it (+1). Unchanged
 * at an edge.
 */
export function stepSection(order: readonly CockpitSection[], id: CockpitSection, shown: readonly CockpitSection[], by: -1 | 1): CockpitSection[] {
  const seen = order.filter((x) => x === id || shown.includes(x))
  const i = seen.indexOf(id)
  const other = i < 0 ? undefined : seen[i + by]
  if (!other) return [...order]
  const rest = order.filter((x) => x !== id)
  const at = rest.indexOf(other)
  rest.splice(by < 0 ? at : at + 1, 0, id)
  return rest
}

/**
 * The order after a section dragged among those shown is dropped at place
 * `k` of the others shown (0 above the first, their count below the last).
 */
export function dropSection(order: readonly CockpitSection[], id: CockpitSection, others: readonly CockpitSection[], k: number): CockpitSection[] {
  const rest = order.filter((x) => x !== id)
  if (others.length === 0) return [...order]
  const at = k < others.length ? rest.indexOf(others[k]!) : rest.indexOf(others[others.length - 1]!) + 1
  if (at < 0) return [...order]
  rest.splice(at, 0, id)
  return rest
}

/**
 * Where a dragged section lands: the place among the other sections, top to
 * bottom, whose vertical middles are `mids`, that the pointer at `y` is
 * above — past every middle, the end.
 */
export function dropIndex(mids: readonly number[], y: number): number {
  const i = mids.findIndex((m) => y < m)
  return i < 0 ? mids.length : i
}

export function isDefaultOrder(order: readonly CockpitSection[]): boolean {
  return order.length === DEFAULT_ORDER.length && order.every((id, i) => id === DEFAULT_ORDER[i])
}

let current: CockpitSection[] | undefined
const listeners = new Set<() => void>()

export function getOrder(): CockpitSection[] {
  if (current) return current
  try {
    const s = localStorage.getItem(ORDER_KEY)
    current = normalizeOrder(s ? JSON.parse(s) : undefined)
  } catch {
    current = [...DEFAULT_ORDER]
  }
  return current
}

/** Stores an order. The default is stored as nothing, so a later default reaches this viewer too. */
export function setOrder(order: readonly CockpitSection[]): void {
  current = normalizeOrder(order)
  try {
    if (isDefaultOrder(current)) localStorage.removeItem(ORDER_KEY)
    else localStorage.setItem(ORDER_KEY, JSON.stringify(current))
  } catch {
    // Private storage: the order holds until the window closes.
  }
  for (const fn of listeners) fn()
}

/** For tests: forget what was read, so the next read is from storage. */
export function resetOrderForTest(): void {
  current = undefined
}

export function useSectionOrder(): CockpitSection[] {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    getOrder,
    getOrder,
  )
}
