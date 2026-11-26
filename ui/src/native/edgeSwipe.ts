/**
 * Back with a swipe from the left edge, in the iOS app (.ai/04-ui.md § The
 * iOS app, *Back from the edge*). Safari does this on m.caprock.dev; the
 * app's WKWebView does not (`allowsBackForwardNavigationGestures` is off in
 * Capacitor and no setting turns it on), and its back-forward snapshots do
 * not follow a hash route's screen anyway. So the page does it: a finger that
 * starts within EDGE_PX of the left edge and travels BACK_PX to the right,
 * mostly sideways, goes back one step in the history — every screen change
 * is a hash, so that is the screen before. A round mark with ‹ follows the
 * finger from the edge and says when letting go will go back.
 *
 * Not from inside what scrolls sideways itself (a code block, a table, the
 * terminal) or while a sheet or a dialog is open, and only when there is a
 * step to go back to. Only in the app: reached by dynamic import behind
 * isNativeApp(), so the web page keeps Safari's own gesture alone.
 */

/** How near the left edge a back swipe starts, in px. */
export const EDGE_PX = 20
/** How far it travels before letting go goes back, in px. */
export const BACK_PX = 72

/** Where a back swipe may not start: boxes with their own sideways scroll. */
const OWN_SWIPE = 'pre, [data-doc-table], [data-code-block], .xterm, [data-scroll-x], input[type=range]'

/** Starts listening on `win`; the returned function stops. */
export function edgeSwipeBack(win: Window = window, back: () => void = () => win.history.back()): () => void {
  const doc = win.document
  let x0 = -1
  let y0 = 0
  let armed = false
  let mark: HTMLDivElement | null = null
  const reduce = typeof win.matchMedia === 'function' && win.matchMedia('(prefers-reduced-motion: reduce)').matches

  const clear = () => {
    x0 = -1
    armed = false
    mark?.remove()
    mark = null
  }
  const draw = (dx: number, y: number) => {
    if (!mark) {
      mark = doc.createElement('div')
      mark.setAttribute('aria-hidden', 'true')
      mark.dataset.edgeBack = ''
      mark.textContent = '‹'
      Object.assign(mark.style, {
        position: 'fixed', left: '4px', width: '36px', height: '36px', zIndex: '60', pointerEvents: 'none',
        display: 'grid', placeItems: 'center', borderRadius: '999px', fontSize: '24px', lineHeight: '1',
        background: 'var(--color-panel-2)', color: 'var(--color-fg)', border: '1px solid var(--color-border-strong)',
        boxShadow: '0 6px 18px -8px rgba(0,0,0,0.5)',
      })
      doc.body.appendChild(mark)
    }
    const k = Math.min(1, dx / BACK_PX)
    mark.style.top = `${Math.round(y - 18)}px`
    mark.style.opacity = String(0.25 + 0.75 * k)
    if (!reduce) mark.style.transform = `translateX(${Math.round(k * 16)}px)`
    mark.style.color = k >= 1 ? 'var(--color-accent)' : 'var(--color-fg)'
  }

  const down = (e: TouchEvent) => {
    clear()
    const t = e.touches[0]
    if (e.touches.length !== 1 || !t || t.clientX > EDGE_PX) return
    const target = e.target instanceof Element ? e.target : null
    if (target?.closest(OWN_SWIPE)) return
    if (doc.querySelector('[role=dialog], [aria-modal=true], [data-phone-sheet], [data-composer-plus]')) return
    if (win.history.length <= 1) return
    x0 = t.clientX
    y0 = t.clientY
  }
  const move = (e: TouchEvent) => {
    const t = e.touches[0]
    if (x0 < 0 || !t) return
    const dx = t.clientX - x0
    const dy = Math.abs(t.clientY - y0)
    // Up or down more than sideways: a scroll that started at the edge.
    if (dy > 40 && dy > dx) { clear(); return }
    if (dx <= 6) return
    armed = dx >= BACK_PX
    draw(dx, t.clientY)
  }
  const up = () => {
    const go = armed
    clear()
    if (go) back()
  }
  win.addEventListener('touchstart', down, { passive: true })
  win.addEventListener('touchmove', move, { passive: true })
  win.addEventListener('touchend', up)
  win.addEventListener('touchcancel', clear)
  return () => {
    clear()
    win.removeEventListener('touchstart', down)
    win.removeEventListener('touchmove', move)
    win.removeEventListener('touchend', up)
    win.removeEventListener('touchcancel', clear)
  }
}
