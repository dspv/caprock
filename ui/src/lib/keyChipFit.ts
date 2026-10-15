/**
 * Whether a key chip has room, measured, so a narrow sidebar drops a chip
 * whole instead of drawing it small (owner, 2026-10-15, translated: "the
 * shortcuts there are tiny, you can't see a damn thing"). Every chip in the
 * sidebar footer is the New agent chip's size; one that does not fit beside
 * its words, or over its icon, is left out and its key stays in the
 * tooltip. Used by components/SidebarFooter.tsx.
 */
import { useLayoutEffect, useRef, useState, type RefObject } from 'react'

/** What a labelled row has to spare, in px, as measured. */
export interface RowRoom {
  /** Room the words leave unused: their box minus their natural width, summed. Negative when cut. */
  labelFree: number
  /** Width of the parts that give way first (a hint like "bug, idea, question"). */
  give: number
  /** How far the row's content spills past it. */
  overflow: number
  /** The chip's own width and the gap before it. */
  chip: number
  gap: number
}

/**
 * Whether the chip belongs in the row. Shown, it stays while the words are
 * whole and nothing spills; left out, it comes back once the words' spare
 * room and the giving parts hold the chip and its gap. Both read the same
 * space, so a row at one width never flips back and forth.
 */
export function chipFits(r: RowRoom, shown: boolean): boolean {
  const slack = 0.5
  if (shown) return r.labelFree >= -slack && r.overflow <= slack
  return r.labelFree + r.give - Math.max(0, r.overflow) + slack >= r.chip + r.gap
}

/**
 * Which keys the folded row draws over its icons. A column is as wide as
 * its chip, never under `minCol` (the 32px icon); `room` is what the columns
 * share. While they do not fit, the widest chip still shown goes first (on
 * a tie, the rightmost), and its column falls back to the icon's width.
 * `null` is a column with no key.
 */
export function fitFoldedChips(chips: readonly (number | null)[], room: number, minCol = 32): boolean[] {
  const shown = chips.map((w) => w !== null)
  const need = () => chips.reduce<number>((sum, w, i) => sum + (shown[i] && w !== null ? Math.max(minCol, w) : minCol), 0)
  while (need() > room + 0.5) {
    let drop = -1
    for (let i = 0; i < chips.length; i++) {
      const w = chips[i]
      if (shown[i] && w != null && (drop < 0 || w >= (chips[drop] ?? 0))) drop = i
    }
    if (drop < 0) break
    shown[drop] = false
  }
  return shown
}

/** The natural width of an element's text, cut or not. */
function textWidth(el: Element): number {
  const r = document.createRange()
  r.selectNodeContents(el)
  return typeof r.getBoundingClientRect === 'function' ? r.getBoundingClientRect().width : el.scrollWidth
}

function px(v: string): number {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : 0
}

/** Reads a row marked up with `data-key-chip`, `data-key-label` and `data-key-give`. */
export function measureRow(row: HTMLElement): RowRoom | null {
  const chip = row.querySelector<HTMLElement>('[data-key-chip]')
  // Nothing laid out (hidden, or no layout engine): nothing to decide.
  if (!chip || row.clientWidth === 0) return null
  let labelFree = 0
  for (const el of row.querySelectorAll<HTMLElement>('[data-key-label]')) labelFree += el.clientWidth - textWidth(el)
  let give = 0
  for (const el of row.querySelectorAll<HTMLElement>('[data-key-give]')) give += el.clientWidth
  const parent = chip.parentElement ?? row
  return {
    labelFree,
    give,
    overflow: row.scrollWidth - row.clientWidth,
    chip: chip.getBoundingClientRect().width,
    gap: px(getComputedStyle(parent).columnGap),
  }
}

/** Re-runs `check` whenever `el` resizes and once the fonts are in. */
function useMeasure(ref: RefObject<HTMLElement | null>, check: () => void, deps: readonly unknown[]) {
  const latest = useRef(check)
  latest.current = check
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const run = () => latest.current()
    const ro = new ResizeObserver(run)
    ro.observe(el)
    run()
    let live = true
    void document.fonts?.ready.then(() => { if (live) run() })
    return () => { live = false; ro.disconnect() }
  }, deps)
}

/**
 * A labelled row's chip: whether it is drawn. True until measured (and
 * where nothing can measure, as in tests), so the key is never lost to an
 * absent layout. Left out, the chip stays in the row unseen and out of
 * the flow (`absolute invisible`), so its width can still be read.
 */
export function useChipFit<T extends HTMLElement>(deps: readonly unknown[] = []): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null)
  const [fits, setFits] = useState(true)
  const shown = useRef(true)
  useMeasure(ref, () => {
    const row = ref.current
    const room = row && measureRow(row)
    if (!room) return
    const next = chipFits(room, shown.current)
    if (next !== shown.current) { shown.current = next; setFits(next) }
  }, deps)
  return [ref, fits]
}

/**
 * The folded row's chips: which are drawn. Its columns are the children
 * marked `data-key-slot`, each with its chip as `[data-key-chip]`; every
 * other child (the fold arrow) keeps its width.
 */
export function useFoldedChipFit<T extends HTMLElement>(count: number, enabled: boolean): [RefObject<T | null>, boolean[]] {
  const ref = useRef<T>(null)
  const [shown, setShown] = useState<boolean[]>(() => Array<boolean>(count).fill(true))
  const last = useRef('')
  useMeasure(ref, () => {
    const row = ref.current
    if (!row || !enabled || row.clientWidth === 0) return
    const cs = getComputedStyle(row)
    const gap = px(cs.columnGap)
    const kids = [...row.children] as HTMLElement[]
    const slots = kids.filter((k) => k.hasAttribute('data-key-slot'))
    const fixed = kids.filter((k) => !k.hasAttribute('data-key-slot')).reduce((s, k) => s + k.getBoundingClientRect().width, 0)
    const room = row.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight) - fixed - gap * Math.max(0, kids.length - 1)
    const chips = slots.map((s) => {
      const k = s.querySelector<HTMLElement>('[data-key-chip]')
      return k ? k.getBoundingClientRect().width : null
    })
    const next = fitFoldedChips(chips, room)
    const key = next.join()
    if (key !== last.current) { last.current = key; setShown(next) }
  }, [count, enabled])
  return [ref, shown]
}
