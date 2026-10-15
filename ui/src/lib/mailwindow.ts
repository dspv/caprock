/**
 * Mail opens in a window of its own, not as a tab inside Caprock's window
 * (owner, 2026-10-15, translated: "Mail still launches in a crappy way; it
 * should be native — either call the installed app, or show a big banner to
 * go there").
 *
 * In the desktop app, in order: the installed Caprock Mail preview (macOS,
 * app/mail-mac), else a second native window of the app on `/?mail=1`, else
 * — an older shell without the commands — the Mail tab as before. In a
 * browser the Mail tab stays, under a banner that opens `/?mail=1` in a
 * browser window of its own (MailWindowBanner).
 */
import { isTauri, MAIL_QUERY } from './appmode'
import { shell } from './shell'

/** Mail alone on this daemon (`ui/src/screens/mail/MailApp.tsx`). */
export function mailWindowURL(origin: string = location.origin): string {
  return `${origin}/?${MAIL_QUERY}=1`
}

/**
 * The desktop app's way out of the tab: true when Mail was shown in the
 * preview app or the app's own Mail window, false when the page has to show
 * its tab (not in the app, or a shell without the commands).
 */
export async function openMailOutside(): Promise<boolean> {
  if (!isTauri()) return false
  try {
    if (await shell.openMailApp()) return true
  } catch { /* an older shell: no such command */ }
  try {
    if (await shell.openMailWindow()) return true
  } catch { /* an older shell: no such command */ }
  return false
}

/** The browser's window name, so a second click brings the same window up. */
export const MAIL_WINDOW_NAME = 'caprock-mail'

/** In a browser: Mail alone in a window of its own, reused when already open. */
export function openMailBrowserWindow(): void {
  const w = window.open(mailWindowURL(), MAIL_WINDOW_NAME, 'popup,width=1100,height=720')
  w?.focus()
}
