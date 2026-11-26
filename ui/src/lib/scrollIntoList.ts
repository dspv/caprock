/**
 * Brings a row of a scrolling list into view by scrolling that list alone,
 * to the nearest edge, as `scrollIntoView({ block: 'nearest' })` would.
 * `scrollIntoView` scrolls every scrolling ancestor too, on both axes: with a
 * dropdown reaching past a sheet's edge it slid the sheet's whole body
 * sideways (New agent's Project list, owner, 2026-11-26).
 */
export function scrollIntoList(list: HTMLElement | null | undefined, row: HTMLElement | null | undefined): void {
  if (!list || !row) return
  const l = list.getBoundingClientRect()
  const r = row.getBoundingClientRect()
  if (r.top < l.top) list.scrollTop -= l.top - r.top
  else if (r.bottom > l.bottom) list.scrollTop += r.bottom - l.bottom
}
