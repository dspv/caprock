/**
 * Where each Live pulse row sits: fixed (owner, 2026-10-14, translated:
 * "here again the order jumps by activity — not allowed. They must have a
 * fixed position: by who was added when … plus let me swap them").
 *
 * A row is placed by the session it shows, never by what happened to it —
 * the rule the sidebar's rows follow (lib/rowOrder.ts):
 *
 * - **By hand first.** Dragged, or moved with ⌥⇧↑ ⌥⇧↓ (Ctrl+Shift off
 *   macOS); kept per viewer in localStorage.
 * - **Then the tab strip.** Sessions open as tabs keep the strip's order
 *   among themselves, in the places their rows already held — opening a tab
 *   moves no row past one without a tab.
 * - **Then when the session started**, then its id. A new session lands
 *   last; one that ends leaves no gap.
 *
 * A new event, a state change, a cost or which minute was busiest moves
 * nothing.
 */
import { orderRows } from './rowOrder'
import { loadWorkspace, namingLeaf } from './tabs'

export const PULSE_ORDER_KEY = 'caprock.pulse.order'
/** Rows remembered by hand, at most: the rest fall back to the rule. */
const PULSE_ORDER_MAX = 200

export function loadPulseOrder(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(PULSE_ORDER_KEY) ?? '[]') as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** Keeps the order set by hand: every row's session id, top to bottom. */
export function savePulseOrder(ids: readonly string[]): void {
  try { localStorage.setItem(PULSE_ORDER_KEY, JSON.stringify(ids.slice(0, PULSE_ORDER_MAX))) } catch { /* a convenience */ }
}

/** The sessions open as tabs, in strip order (the app's workspace; empty in a browser). */
export function tabSessionOrder(): string[] {
  const out: string[] = []
  for (const t of loadWorkspace().tabs) {
    const id = namingLeaf(t).target.sessionId
    if (id && !out.includes(id)) out.push(id)
  }
  return out
}

/**
 * Sessions in their fixed order: by hand, then the tab strip's order among
 * the ones with a tab, then by start time.
 */
export function pulseOrder<T extends { session_id: string; started_at: number }>(items: readonly T[], manual: readonly string[] = [], tabs: readonly string[] = []): T[] {
  const base = orderRows(items, (s) => s.session_id, (s) => s.started_at || undefined)
  // The tabbed rows trade places among themselves to follow the strip; every
  // other row keeps its slot.
  const at = new Map(tabs.map((id, i) => [id, i] as const))
  const slots = base.map((s, i) => (at.has(s.session_id) ? i : -1)).filter((i) => i >= 0)
  const tabbed = slots.map((i) => base[i]!).sort((a, b) => at.get(a.session_id)! - at.get(b.session_id)!)
  const placed = [...base]
  slots.forEach((slot, k) => { placed[slot] = tabbed[k]! })
  // By hand outranks both; a row never placed by hand keeps its turn after them.
  const rank = new Map(manual.map((id, i) => [id, i] as const))
  const big = Number.MAX_SAFE_INTEGER
  return placed
    .map((s, i) => ({ s, i, r: rank.get(s.session_id) ?? big }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.s)
}
