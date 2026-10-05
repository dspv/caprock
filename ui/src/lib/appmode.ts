/**
 * The app mode: the terminal-first workspace the desktop app loads (WP-04).
 *
 * The same `ui/` serves three layouts — browser, app, phone — switched on by
 * detection, never forked (ADR-038). The app is on when the page is opened at
 * `#/app`, with `?app=1`, or inside the Tauri shell. Once on, it stays on for
 * the life of the page and the tab: the dashboard screens are hash routes
 * (`#/cost`, `#/session/…`) opened inside the app, and following one of those
 * links must not drop the reader out of the workspace.
 */

/** The hash route of the workspace. The Tauri shell loads `<daemon>/#/app`. */
export const APP_ROUTE = '#/app'

/** The query flag that turns the app mode on for any route. */
export const APP_QUERY = 'app'

const LATCH_KEY = 'caprock.app.mode'

/** Whether the page runs inside the Tauri shell. */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** Whether a location asks for the app, read from its hash and query alone. */
export function asksForApp(hash: string, search: string): boolean {
  if (hash === APP_ROUTE || hash.startsWith(`${APP_ROUTE}/`) || hash.startsWith(`${APP_ROUTE}?`)) return true
  const flag = new URLSearchParams(search).get(APP_QUERY)
  return flag === '1' || flag === 'true'
}

/** Whether this page shows the app workspace rather than the dashboard. */
export function isAppMode(): boolean {
  if (typeof window === 'undefined') return false
  if (isTauri() || asksForApp(location.hash, location.search)) {
    try { sessionStorage.setItem(LATCH_KEY, '1') } catch { /* private mode: the URL still says so */ }
    return true
  }
  try {
    return sessionStorage.getItem(LATCH_KEY) === '1'
  } catch {
    return false
  }
}

/** Whether the hash shows the workspace (as opposed to a dashboard screen inside the app). */
export function isWorkspaceHash(hash: string): boolean {
  // No hash at all is the app opened bare (`/?app=1`): the workspace. `#/` is
  // the Now screen, a dashboard route like any other.
  if (hash === '' || hash === '#') return true
  return hash === APP_ROUTE || hash.startsWith(`${APP_ROUTE}/`) || hash.startsWith(`${APP_ROUTE}?`)
}

/** Whether the platform's app modifier is Cmd (macOS) rather than Ctrl+Shift. */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Mac|iP(hone|ad)/.test(navigator.platform || navigator.userAgent)
}
