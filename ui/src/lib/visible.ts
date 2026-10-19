/**
 * A hidden window does no work (WP-16; .ai/04-ui.md § A hidden window does no work).
 *
 * A hidden app window still runs its page (the shell turns WebKit's
 * background throttling off, so the live socket can raise notifications), and
 * every poll and clock kept it at about 1% of a core where the budget is 0.2%
 * (bench/results-2026-10-06). The live socket stays; polls and clocks stop
 * while hidden — no timer wakes the page at all — and run once as soon as the
 * page is shown again, so it comes back current.
 *
 * "Hidden" is the document's visibility: a minimized or closed window, one
 * covered by others (WebKit's occlusion detection), another tab in a browser.
 */

/** The page is out of sight. */
export function pageHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

/** Calls `fn(hidden)` each time the page is hidden or shown. Returns the stop. */
export function onPageVisibility(fn: (hidden: boolean) => void): () => void {
  if (typeof document === 'undefined') return () => {}
  let was = pageHidden()
  const on = () => {
    const now = pageHidden()
    if (now === was) return
    was = now
    fn(now)
  }
  document.addEventListener('visibilitychange', on)
  return () => document.removeEventListener('visibilitychange', on)
}

/**
 * Like setInterval, but while the page is hidden there is no timer at all —
 * or, with `hiddenMs`, one at that slower pace — and on showing it runs at
 * once if a tick came due meanwhile. Returns the stop.
 */
export function everyWhileVisible(fn: () => void, ms: number, hiddenMs?: number): () => void {
  let lastRun = Date.now()
  let id = 0
  const run = () => { lastRun = Date.now(); fn() }
  const arm = () => {
    if (id) window.clearInterval(id)
    id = 0
    if (!pageHidden()) id = window.setInterval(run, ms)
    else if (hiddenMs !== undefined) id = window.setInterval(run, Math.max(ms, hiddenMs))
  }
  arm()
  const off = onPageVisibility((hidden) => {
    if (!hidden && Date.now() - lastRun >= ms) run()
    arm()
  })
  return () => {
    if (id) window.clearInterval(id)
    id = 0
    off()
  }
}

/**
 * Marks <html data-page-hidden> while the page is out of sight, which pauses
 * every CSS animation (design/tokens.css): a pulsing dot in a hidden window
 * still asks the compositor for frames. Returns the stop.
 */
export function markPageVisibility(): () => void {
  if (typeof document === 'undefined') return () => {}
  const root = document.documentElement
  const apply = (hidden: boolean) => {
    if (hidden) root.setAttribute('data-page-hidden', '')
    else root.removeAttribute('data-page-hidden')
  }
  apply(pageHidden())
  return onPageVisibility(apply)
}

/**
 * A terminal's cursor blinks only while the page is shown: each blink is a
 * frame drawn, and a hidden window drew one every 600 ms for nobody. `blink`
 * is what the terminal asks for when shown. Returns the stop (leaving the
 * cursor as asked).
 */
export function blinkWhileVisible(term: { options: { cursorBlink?: boolean } }, blink: boolean): () => void {
  const apply = (hidden: boolean) => {
    const want = blink && !hidden
    if (term.options.cursorBlink !== want) term.options.cursorBlink = want
  }
  apply(pageHidden())
  return onPageVisibility(apply)
}

/**
 * Runs `fn` at most once per `ms`, on the trailing edge, however often it is
 * asked for — and not at all while the page is hidden, where an ask waits and
 * runs as soon as the page is shown. The live feed's bursts (several frames a
 * second while agents work) become one render per window instead of one per
 * frame. Returns `{ ask, flush, cancel }`.
 */
export function coalesce(fn: () => void, ms: number): { ask: () => void; flush: () => void; cancel: () => void } {
  let timer = 0
  let due = false
  let offVis: (() => void) | null = null
  const fire = () => {
    timer = 0
    if (pageHidden()) {
      // Shown again: run then. One listener, however many asks.
      offVis ??= onPageVisibility((hidden) => { if (!hidden) flush() })
      return
    }
    if (!due) return
    due = false
    fn()
  }
  const flush = () => {
    if (timer) window.clearTimeout(timer)
    timer = 0
    offVis?.()
    offVis = null
    if (!due) return
    due = false
    fn()
  }
  return {
    ask: () => {
      due = true
      if (!timer && !offVis) timer = window.setTimeout(fire, ms)
    },
    flush,
    cancel: () => {
      if (timer) window.clearTimeout(timer)
      timer = 0
      due = false
      offVis?.()
      offVis = null
    },
  }
}

/**
 * A page out of sight this long lets its terminal sockets go
 * (suspendWhileHidden): a flicker of occlusion or a quick switch of Spaces
 * keeps them.
 */
export const PAGE_HIDDEN_SUSPEND_MS = 2_000

/**
 * While the page is hidden — the app's window minimised, hidden or covered, a
 * browser tab behind another — a terminal client lets its socket go after
 * `ms` (lib/termv2 `suspend`), so nothing is sent to a window that draws
 * nothing: one hidden stream at 20 lines a second kept WebKit's Networking
 * process at 0.64% of a core (docs/app-window-footprint-2026-10-19.md). The
 * daemon keeps what the session prints, and the wake on showing (the
 * caller's visibility handler) asks from the last byte the client has
 * (`since`), so nothing is lost and nothing repaints. Returns the stop.
 */
export function suspendWhileHidden(client: { suspend(): void }, ms = PAGE_HIDDEN_SUSPEND_MS): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = (hidden: boolean) => {
    clearTimeout(timer)
    timer = undefined
    if (hidden) timer = setTimeout(() => { timer = undefined; client.suspend() }, ms)
  }
  const off = onPageVisibility(arm)
  if (pageHidden()) arm(true)
  return () => { off(); clearTimeout(timer) }
}
