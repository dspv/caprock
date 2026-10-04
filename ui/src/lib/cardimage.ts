/**
 * A card on screen, as a PNG — drawn in the browser, nothing uploaded.
 *
 * html-to-image (MIT, pinned, bundled) clones the node into an SVG
 * foreignObject and paints that onto a canvas. The fonts it embeds are the
 * product's own bundled files, read from this same origin, so drawing makes no
 * request off the machine — the same promise as the rest of the dashboard.
 *
 * The node is captured at its own size, not as it is scaled on screen, so the
 * file is exactly the 1200x675 or 1080x1350 the layout is drawn for.
 */
import { toBlob } from 'html-to-image'

export async function renderCardPNG(node: HTMLElement, size: { w: number; h: number }): Promise<Blob | null> {
  // Wait for the bundled faces; a capture taken before they load falls back
  // to system fonts and no longer looks like the screen.
  try { await document.fonts?.ready } catch { /* draw with what there is */ }
  const bg = getComputedStyle(node).backgroundColor
  return toBlob(node, {
    width: size.w,
    height: size.h,
    pixelRatio: 1,
    backgroundColor: bg,
    // The clone is drawn untransformed even if a parent scales it.
    style: { transform: 'none', margin: '0' },
    cacheBust: false,
  })
}
