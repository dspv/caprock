/**
 * A screen that throws, turned into a report the user can send us.
 *
 * Nothing is sent from here, the same promise as lib/feedback.ts: the report
 * becomes a prefilled GitHub issue or an email the user opens, reads and sends
 * themselves. What goes in is what fixes a crash and nothing else: the error,
 * where in the code, the version and the platform. A home directory in a
 * message is folded to `~`, and the route keeps its name, not its query.
 */
import { body, issueURL } from './feedback'
import { isTauri } from './appmode'
import { servedVersion } from './staleui'

/** Where an emailed report goes. */
export const CRASH_EMAIL = 'hi@caprock.dev'

/** Saved view state a "reset the view" clears: caches and the deck's panels, never tabs or settings. */
const VIEW_STATE = [/^caprock-swr-v1:/, /^caprock\.deck\./, /^caprock\.app\.deck$/]

export interface Crash {
  message: string
  /** The diagnostics, one line each: version, platform, screen, where it threw. */
  lines: string[]
}

/** A user's home directory written out in a path, folded to `~`. */
export function scrub(text: string): string {
  return text
    .replace(/\/(?:Users|home)\/[^/\s'"`)]+/g, '~')
    .replace(/[A-Za-z]:\\Users\\[^\\\s'"`)]+/g, '~')
    .replace(/https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?/g, '')
}

function platform(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  const os = /Mac/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'unknown OS'
  return `${isTauri() ? 'desktop app' : 'browser'} on ${os}`
}

/** The first frames of a stack, without the page's origin. */
function frames(stack: string | undefined, n: number): string[] {
  return (stack ?? '').split('\n').map((l) => scrub(l.trim())).filter(Boolean).slice(0, n)
}

export function describeCrash(error: Error, componentStack?: string | null, where = typeof location === 'undefined' ? '' : location.hash): Crash {
  const message = scrub(`${error.name}: ${error.message}`)
  const route = where.split('?')[0] || '#/'
  return {
    message,
    lines: [
      `Caprock ${servedVersion() ?? 'version unknown'} · ${platform()}`,
      `Screen: ${route}`,
      `Error: ${message}`,
      ...frames(error.stack, 6).filter((l) => !l.startsWith(error.name)).map((l) => `Stack: ${l}`),
      ...frames(componentStack ?? undefined, 4).map((l) => `Component: ${l}`),
    ],
  }
}

/** The prefilled GitHub issue. */
export function crashIssueURL(c: Crash): string {
  return issueURL({ kind: 'bug', title: `Screen error: ${c.message}`, text: 'Caprock showed an error instead of the screen.', ctx: c.lines, shots: 0 })
}

/** The same report as an email. Mail clients cut long mailto links, so the body stays short. */
export function crashMailURL(c: Crash): string {
  const text = body({ kind: 'bug', title: '', text: 'Caprock showed an error instead of the screen.', ctx: c.lines, shots: 0 })
  const q = `subject=${encodeURIComponent(`Caprock screen error: ${c.message}`.slice(0, 150))}&body=${encodeURIComponent(text.slice(0, 1500))}`
  return `mailto:${CRASH_EMAIL}?${q}`
}

/** The report as plain text, for the clipboard. */
export function crashText(c: Crash): string {
  return c.lines.join('\n')
}

/** Clears the saved view state a crash may live in; returns how many entries went. */
export function resetViewState(storage: Storage = localStorage): number {
  const gone: string[] = []
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i)
    if (k && VIEW_STATE.some((re) => re.test(k))) gone.push(k)
  }
  for (const k of gone) storage.removeItem(k)
  return gone.length
}
