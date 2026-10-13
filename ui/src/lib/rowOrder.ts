/**
 * Where each row under a project sits in the sidebar: fixed (owner,
 * 2026-10-13, translated: "when I pick a session in a project from the list,
 * it moves up. I want them to stay in their places, only if moved by hand …
 * fixed positions, I orient visually by them").
 *
 * A row is placed by the session it shows, never by what happened to it:
 * first the order set by hand (dragged, or ⌥⇧↑ ⌥⇧↓), then when the session
 * started, then its id. Opening a row as a tab, bringing it to the front, a
 * new event or a state change moves nothing; a new session lands last; a
 * session that ends leaves no gap, since only the relative order is kept.
 *
 * The order set by hand is this viewer's, per project, in localStorage, and
 * survives a restart. ⌥⌘↑ ⌥⌘↓ walk the rows in this same order.
 */
import { namingLeaf, type Tab } from './tabs'

export const ROW_ORDER_KEY = 'caprock.app.row-order'
/** Said on window when the order set by hand changes, so every reader asks again. */
export const ROW_ORDER_EVENT = 'caprock:row-order'
/** Rows remembered per project, at most: the rest fall back to start order. */
const ROW_ORDER_MAX = 200

export type RowOrders = Readonly<Record<string, readonly string[]>>

export function loadRowOrders(): RowOrders {
  try {
    const v = JSON.parse(localStorage.getItem(ROW_ORDER_KEY) ?? 'null') as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    const out: Record<string, string[]> = {}
    for (const [k, list] of Object.entries(v as Record<string, unknown>)) {
      if (Array.isArray(list)) out[k] = list.filter((x): x is string => typeof x === 'string')
    }
    return out
  } catch {
    return {}
  }
}

/** Keeps a project's order set by hand: every row's key, top to bottom. */
export function saveRowOrder(projectId: string, keys: readonly string[]) {
  const all = { ...loadRowOrders(), [projectId]: keys.slice(0, ROW_ORDER_MAX) }
  try { localStorage.setItem(ROW_ORDER_KEY, JSON.stringify(all)) } catch { /* for this page only */ }
  window.dispatchEvent(new CustomEvent(ROW_ORDER_EVENT, { detail: projectId }))
}

/** A tab's row key: the session it is named after, so a row keeps its place when it becomes a tab. */
export function tabRowKey(tab: Tab): string {
  return namingLeaf(tab).target.sessionId
}

/**
 * Rows in their fixed order: by hand first, then by start time (unknown
 * last), then by key. Nothing that changes while a session runs is read.
 */
export function orderRows<T>(items: readonly T[], keyOf: (t: T) => string, startedOf: (t: T) => number | undefined, manual?: readonly string[]): T[] {
  const rank = new Map((manual ?? []).map((k, i) => [k, i] as const))
  const big = Number.MAX_SAFE_INTEGER
  return items
    .map((it) => { const k = keyOf(it); return { it, k, r: rank.get(k) ?? big, s: startedOf(it) ?? big } })
    .sort((a, b) => a.r - b.r || a.s - b.s || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))
    .map((x) => x.it)
}

/** `keys` with `key` moved before or after `target`; unchanged when either is missing or they are the same. */
export function moveKey(keys: readonly string[], key: string, target: string, where: 'before' | 'after'): string[] {
  if (key === target || !keys.includes(key) || !keys.includes(target)) return [...keys]
  const rest = keys.filter((k) => k !== key)
  rest.splice(rest.indexOf(target) + (where === 'after' ? 1 : 0), 0, key)
  return rest
}
