/**
 * Warms the terminal up once, while the app is idle after start (WP-16).
 *
 * The first tab of a launch used to hold the page for 70–150 ms
 * (bench/results-2026-10-06): the first xterm on a cold page compiles its
 * code paths, measures the font and lays out its DOM. Doing that once on a
 * throwaway terminal, off screen, a moment after the app is drawn,
 * moves the cost to a time nobody is waiting on it.
 */
import { Terminal as Xterm } from '@xterm/xterm'
import { getTerminalPrefs, xtermOptions } from './termprefs'

/** How long after the workspace is drawn the warm-up runs. */
export const WARM_DELAY_MS = 300

let warmed = false

/** Builds, fills and disposes one off-screen terminal; once per page. Returns a cancel. */
export function warmTerminal(delayMs: number = WARM_DELAY_MS): () => void {
  if (warmed) return () => {}
  const timer = window.setTimeout(() => {
    if (warmed) return
    warmed = true
    const host = document.createElement('div')
    host.setAttribute('aria-hidden', 'true')
    host.style.cssText = 'position:fixed;left:-10000px;top:0;width:800px;height:400px;visibility:hidden;pointer-events:none'
    document.body.append(host)
    const mono = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'monospace'
    const term = new Xterm({ ...xtermOptions(getTerminalPrefs(), mono), scrollback: 100 })
    term.open(host)
    const line = '\x1b[38;5;75m000001\x1b[0m \x1b[2mwarming the terminal up, γράφω\x1b[0m\r\n'
    term.write(line.repeat(60), () => {
      term.dispose()
      host.remove()
    })
  }, delayMs)
  return () => window.clearTimeout(timer)
}
