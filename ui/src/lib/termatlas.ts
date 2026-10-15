/**
 * The WebGL glyph atlas, kept honest on the GPU.
 *
 * xterm's WebGL addon (0.19) rasterises glyphs into atlas pages (2D canvases)
 * and each terminal's renderer uploads a page to its texture unit `i` when
 * `pages[i].version` differs from the version it last uploaded there. That
 * version is a counter **per page**, and pages move: when the atlas reaches
 * its page cap (16 texture units in WebKit on Apple GPUs) it merges four
 * pages into a new one, deletes them, and the pages above shift down. The
 * merged page starts at version 1 and never changes again. On the second
 * merge, the new merged page lands at the index where the first merged page
 * sat — also version 1 — so the renderer sees "already uploaded" and keeps
 * the old merged page's pixels in that unit, while every glyph of the four
 * most-used pages now points into it. A shifted page whose version happens
 * to equal what its new unit last held is skipped the same way.
 *
 * Result: glyphs drawn from the wrong cells of the atlas — clipped,
 * overlapped, stretched letters on a screen whose layout, colours and box
 * rules are right — for good, because a merged page is never written again.
 * Only something that resets every unit's version (`setAtlas`: a font
 * size change, a new atlas, our re-upload on show) cleared it, which is why
 * font +/- "fixed" it (owner, 2026-10-14 and 2026-10-15). The atlas is
 * shared by every terminal of the same face, size, palette and pixel ratio,
 * so five Claude Code tabs fill one atlas with their colour combinations and
 * reach the merges in a working day. Fixed upstream in 0.20 betas (a global
 * version counter); `healAtlasMerges` does the same here: on a merge every
 * terminal sharing the atlas marks all its units stale (`reuploadGlyphs`)
 * and redraws.
 */
import type { IDisposable, Terminal as Xterm } from '@xterm/xterm'

/**
 * Sends the WebGL renderer's glyph atlas to the GPU again, from the canvas it
 * was rasterised into, without rasterising anything: the next frame re-uploads
 * every page (the addon's own `setAtlas`, which marks each page's texture
 * stale). False when the addon's insides are not what this expects (another
 * version); the caller then rebuilds the atlas instead.
 */
export function reuploadGlyphs(addon: unknown): boolean {
  const r = (addon as { _renderer?: { _charAtlas?: unknown; _glyphRenderer?: { value?: { setAtlas?: (a: unknown) => void } } } })._renderer
  const glyphs = r?._glyphRenderer?.value
  if (!r?._charAtlas || typeof glyphs?.setAtlas !== 'function') return false
  try { glyphs.setAtlas(r._charAtlas) } catch { return false }
  return true
}

/** What healAtlasMerges needs of the addon: the event a page merge fires. */
export type AtlasEvents = {
  onRemoveTextureAtlasCanvas?: (listener: () => void) => IDisposable
}

/**
 * Keeps `term` drawing from the right atlas pages across a page merge, by
 * any terminal sharing its atlas. A merge is the only thing that removes an
 * atlas page (`onRemoveTextureAtlasCanvas`, fired four times per merge, by
 * every terminal's addon subscribed to that atlas). In it: every texture unit
 * is marked stale at once (synchronously — the merge can happen in the middle
 * of this terminal's own frame, and that frame's upload must already see it),
 * and the whole viewport is redrawn once on the next frame, since the cells
 * drawn before the merge in that frame point at page indices that shifted.
 * `fallback` runs (once, after the merge) when the addon's insides are not
 * there; it should rebuild the atlas. Rare — a handful of merges a day — so
 * the cost (one texImage2D per page) is nothing; never a per-frame loop.
 */
export function healAtlasMerges(addon: AtlasEvents, term: Pick<Xterm, 'refresh' | 'rows'>, fallback: () => void = () => {}): IDisposable {
  let queued = false
  let failed = false
  const after = () => {
    queued = false
    if (failed) { failed = false; try { fallback() } catch { /* disposed */ } return }
    try { term.refresh(0, term.rows - 1) } catch { /* disposed */ }
  }
  const sub = addon.onRemoveTextureAtlasCanvas?.(() => {
    if (!reuploadGlyphs(addon)) failed = true
    if (!queued) { queued = true; queueMicrotask(after) }
  })
  return { dispose: () => sub?.dispose() }
}
