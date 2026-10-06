/**
 * Polling that rests while the page is hidden (WP-16).
 *
 * A hidden app window still runs its page (the shell turns WebKit's
 * background throttling off, so the live socket can raise notifications), and
 * every poll and clock kept it at about 1% of a core where the budget is 0.2%
 * (bench/results-2026-10-06). The live socket stays; polls and clocks skip
 * their ticks while hidden and run once as soon as the page is shown again.
 */

/**
 * Like setInterval, but ticks while the page is hidden are skipped — or, with
 * `hiddenMs`, run at that slower pace — and one runs on showing if any was
 * skipped. Returns the stop.
 */
export function everyWhileVisible(fn: () => void, ms: number, hiddenMs?: number): () => void {
  let missed = false
  let lastRun = Date.now()
  const run = () => { lastRun = Date.now(); missed = false; fn() }
  const id = window.setInterval(() => {
    if (document.visibilityState !== 'hidden') { run(); return }
    if (hiddenMs !== undefined && Date.now() - lastRun >= hiddenMs) run()
    else missed = true
  }, ms)
  const onShow = () => {
    if (document.visibilityState === 'hidden' || !missed) return
    run()
  }
  document.addEventListener('visibilitychange', onShow)
  return () => {
    window.clearInterval(id)
    document.removeEventListener('visibilitychange', onShow)
  }
}
