/**
 * The arithmetic of a drag that is drawn as it happens, shared by the tab
 * strip (sideways) and the sidebar's session rows (up and down): which slot
 * the dragged item would land in, and how far each neighbour slides to open
 * it. Pointer events and the DOM stay with each component; this is only the
 * geometry, so both draw the same Chrome-style drag (owner, 2026-10-23).
 */

/** How long the neighbours take to make room, and a released item to land. */
export const SLIDE_MS = 150

export function reducedMotion(): boolean {
  try { return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

/** An item's extent along the drag's axis. */
export interface Span { start: number; size: number }

/**
 * The slot the item at `at`, moved by `offset`, would take: once its
 * leading edge passes a neighbour's middle it takes that neighbour's place,
 * as Chrome's tabs do — half a neighbour of travel, not a whole one, and a
 * tall row held at the end of its list still passes a short one there.
 */
export function slotFor(spans: readonly Span[], at: number, offset: number): number {
  const r = spans[at]!
  const start = r.start + offset
  const end = start + r.size
  let slot = at
  spans.forEach((o, j) => {
    const mid = o.start + o.size / 2
    if (j > at && end >= mid) slot++
    if (j < at && start <= mid) slot--
  })
  return slot
}

/**
 * How far neighbour `j` slides while the item at `at` would land in `slot`:
 * by `step` (the dragged item's own size and the gap) toward the place it
 * left, or not at all.
 */
export function shiftFor(j: number, at: number, slot: number, step: number): number {
  return j > at && j <= slot ? -step : j < at && j >= slot ? step : 0
}

/** The offset that keeps an item inside the first..last spans of its group. */
export function clampOffset(spans: readonly Span[], at: number, offset: number): number {
  const r = spans[at]!
  const first = spans[0]!
  const last = spans[spans.length - 1]!
  return Math.max(first.start - r.start, Math.min(offset, last.start + last.size - (r.start + r.size)))
}
