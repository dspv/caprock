/**
 * A dashboard panel, as a PNG — drawn in the browser, nothing uploaded
 * (.ai/04-ui.md § Share, "Any panel").
 *
 * The panel on screen is copied, not touched: the copy has the names swept
 * (lib/panelShare.ts, when Hide project names is on), its chrome taken out —
 * the share button, fold chevrons, More and Hide toggles, hover-only buttons,
 * tooltips (SHARE_CHROME) — so the picture is the title and the content; every canvas (the Live pulse's bars) carried over as its current
 * picture, and images from anywhere but this page (a GitHub avatar) blanked,
 * so drawing fetches nothing off the machine. Under it, one faint line: when
 * it was taken and caprock.dev, as on the share card. html-to-image (already
 * bundled for the share card, lib/cardimage.ts) paints the copy at 2x, with
 * the page's own fonts and the theme's colours, which the copy inherits from
 * <html> while it sits, out of sight, in this document.
 *
 * Loaded only when a panel's share menu draws, so the dashboard's first
 * screen does not carry it.
 */
import { toBlob } from 'html-to-image'
import { hideNamesIn, isShareChrome, shareStamp, stripChrome, type Aliaser } from './panelShare'
import { pageFontCSS } from './fontEmbed'

/** The margin round the panel and the gap above the footer, in CSS pixels. */
const PAD = 16

export async function renderPanelPNG(section: HTMLElement, aliaser: Aliaser, at = new Date()): Promise<Blob | null> {
  // A capture taken before the bundled faces load falls back to system fonts.
  try { await document.fonts?.ready } catch { /* draw with what there is */ }
  const width = Math.ceil(section.getBoundingClientRect().width)
  if (width <= 0) return null

  const clone = section.cloneNode(true) as HTMLElement
  clone.style.width = `${width}px`
  clone.style.margin = '0'
  // A canvas copies empty: put each one's current picture in its place.
  const from = section.querySelectorAll('canvas')
  clone.querySelectorAll('canvas').forEach((c, i) => {
    const src = from[i]
    const img = document.createElement('img')
    const r = src?.getBoundingClientRect()
    try { img.src = src ? src.toDataURL('image/png') : '' } catch { img.src = '' }
    img.style.width = `${r?.width ?? c.width}px`
    img.style.height = `${r?.height ?? c.height}px`
    img.style.display = 'block'
    img.className = c.className
    c.replaceWith(img)
  })
  // After the canvases are matched up by position: a skipped one would shift them.
  stripChrome(clone)
  // Rule 4: an image from another address would be fetched again to embed it.
  for (const img of clone.querySelectorAll('img')) {
    const src = img.getAttribute('src') ?? ''
    if (src.startsWith('data:') || src.startsWith('blob:')) continue
    try {
      if (new URL(src, location.href).origin === location.origin) continue
    } catch { /* not a URL: blank it */ }
    const box = document.createElement('span')
    const r = img.getBoundingClientRect()
    box.style.display = 'inline-block'
    box.style.width = `${r.width || 16}px`
    box.style.height = `${r.height || 16}px`
    box.className = 'rounded-full bg-panel-2'
    img.replaceWith(box)
  }
  hideNamesIn(clone, aliaser)

  const frame = document.createElement('div')
  frame.setAttribute('data-panel-share-frame', '')
  frame.className = 'bg-bg text-fg'
  Object.assign(frame.style, {
    position: 'fixed', left: '-100000px', top: '0', width: `${width + PAD * 2}px`,
    padding: `${PAD}px`, boxSizing: 'border-box', pointerEvents: 'none',
  })
  const foot = document.createElement('div')
  foot.className = 'mono flex items-center justify-between text-[11px] text-fg-faint'
  foot.style.marginTop = `${PAD / 2}px`
  const when = document.createElement('span')
  when.textContent = shareStamp(at)
  const brand = document.createElement('span')
  brand.textContent = 'caprock.dev'
  foot.append(when, brand)
  frame.append(clone, foot)
  document.body.append(frame)
  try {
    const h = Math.ceil(frame.getBoundingClientRect().height)
    // The faces this page loaded, from the browser's cache (lib/fontEmbed.ts).
    const fontEmbedCSS = await pageFontCSS()
    return await toBlob(frame, {
      ...(fontEmbedCSS ? { fontEmbedCSS } : {}),
      width: width + PAD * 2,
      height: h,
      pixelRatio: 2,
      backgroundColor: getComputedStyle(frame).backgroundColor,
      style: { position: 'static', left: '0', top: '0', transform: 'none', margin: '0' },
      cacheBust: false,
      // The clone is stripped already; this keeps anything added since out too.
      filter: (node) => !isShareChrome(node),
    })
  } finally {
    frame.remove()
  }
}
