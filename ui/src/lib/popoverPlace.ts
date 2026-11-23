/**
 * Where a hover card goes so the whole of it stays on screen (.ai/04-ui.md §
 * Hovering a PR's checks). Owner screenshot, 2026-11-24, translated: "the
 * modal is cut off at the bottom" — the cockpit's list of a PR's 16 checks
 * stood level with a row near the window's foot and its last seven rows
 * fell past the edge, with no way to scroll to them.
 *
 * Pure: the caller measures the anchor, the card's natural size and the
 * viewport, and puts the card at the `left`/`top` this returns, no taller
 * than `maxHeight` (its list scrolls inside, the header stays).
 */

/** The gap kept between the card and every edge of the window. */
export const POP_MARGIN = 8

export type PopRect = { top: number; bottom: number; left: number; right: number }
export type PopSize = { w: number; h: number }
export type PopPlace = { left: number; top: number; maxHeight: number; side: 'below' | 'above' | 'beside' }

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi))

/** The left edge that keeps a card of width `w` inside a viewport `vw` wide, from where it would like to be. */
function fitLeft(want: number, w: number, vw: number): number {
  return clamp(want, POP_MARGIN, Math.max(POP_MARGIN, vw - POP_MARGIN - w))
}

/**
 * Under or over the anchor, its right edge aligned with the anchor's: under
 * when the card fits there, over when it fits there instead, otherwise on
 * whichever side has more room, cut to that room.
 */
export function placeNear(anchor: PopRect, card: PopSize, vp: PopSize, gap = 6): PopPlace {
  const below = Math.max(0, vp.h - anchor.bottom - gap - POP_MARGIN)
  const above = Math.max(0, anchor.top - gap - POP_MARGIN)
  const left = fitLeft(anchor.right - card.w, card.w, vp.w)
  const down = card.h <= below || (card.h > above && below >= above)
  if (down) {
    const maxHeight = Math.min(card.h, below)
    return { left, top: anchor.bottom + gap, maxHeight, side: 'below' }
  }
  const maxHeight = Math.min(card.h, above)
  return { left, top: anchor.top - gap - maxHeight, maxHeight, side: 'above' }
}

/**
 * Beside a panel, left of its edge (`edgeLeft`), level with the anchor's
 * row: lifted as far as it takes to end above the window's foot, never above
 * its top, and cut to the window's height when it is taller than that. With
 * no room left of the edge it keeps to the window's left margin.
 */
export function placeBeside(anchor: PopRect, edgeLeft: number, card: PopSize, vp: PopSize, gap = 10): PopPlace {
  const maxHeight = Math.max(0, Math.min(card.h, vp.h - 2 * POP_MARGIN))
  const top = clamp(anchor.top - 8, POP_MARGIN, vp.h - POP_MARGIN - maxHeight)
  return { left: fitLeft(edgeLeft - gap - card.w, card.w, vp.w), top, maxHeight, side: 'beside' }
}
