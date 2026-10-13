/**
 * The phone home screen's decisions, kept out of the component so they can be
 * tested without a DOM (components/PhoneHome.tsx; .ai/04-ui.md § The phone
 * home).
 */
import type { SessionSummary } from './api'
import { quotePath } from './xtermInput'

/** How many sessions Continue lists. */
export const CONTINUE_MAX = 5
/** A session quiet for longer than this is history, not something to continue. */
export const CONTINUE_WINDOW_MS = 2 * 24 * 60 * 60 * 1000

function at(s: SessionSummary): number {
  return Math.max(s.worked_at || 0, s.last_event_at || 0)
}

function rank(s: SessionSummary): number {
  const h = s.activity?.health
  if (h === 'waiting-on-you') return 0
  if (h === 'working' || h === 'looping' || h === 'error') return 1
  if (s.status !== 'ended') return 2
  return 3
}

/**
 * The sessions worth one tap: waiting on you first, then working, then the
 * rest of what is open, then what ended lately — newest first within each,
 * the last two days only, at most CONTINUE_MAX.
 */
export function continueList(sessions: readonly SessionSummary[], now: number, max = CONTINUE_MAX): SessionSummary[] {
  return sessions
    .filter((s) => rank(s) < 2 || now - at(s) < CONTINUE_WINDOW_MS)
    .slice()
    .sort((a, b) => rank(a) - rank(b) || at(b) - at(a))
    .slice(0, max)
}

/** Sessions a permission prompt or a question holds, that this screen may answer. */
export function waitingOnYou(sessions: readonly SessionSummary[]): SessionSummary[] {
  return sessions.filter((s) => s.activity?.health === 'waiting-on-you' && s.owned && s.status !== 'ended' && !s.detached)
}

/** What another app shared, read off the share target's GET (manifest.json). */
export interface Shared { text: string }

/**
 * The text a Web Share Target put in the query (`/?title=&text=&url=`), joined
 * as a person would write it; null when nothing was shared. Android Chrome
 * sends a link as `text` in some apps and `url` in others, and a title that
 * often repeats the text, so a part already contained in another is dropped.
 */
export function sharedFromSearch(search: string): Shared | null {
  const q = new URLSearchParams(search)
  if (!['title', 'text', 'url'].some((k) => q.has(k))) return null
  const parts: string[] = []
  for (const key of ['title', 'text', 'url']) {
    const v = (q.get(key) ?? '').trim()
    if (v && !parts.some((p) => p.includes(v))) parts.push(v)
  }
  return { text: parts.join('\n') }
}

/** Which sheet a home-screen shortcut asked for: `#/?open=chat` or `#/?open=save`. */
export function openFromHash(hash: string): 'chat' | 'save' | null {
  const q = new URLSearchParams(hash.split('?')[1] ?? '')
  const v = q.get('open')
  return v === 'chat' || v === 'save' ? v : null
}

/** A first message: the words, then each file's path quoted as the paste path is. */
export function messageWith(text: string, paths: readonly string[]): string {
  const files = paths.map(quotePath).join(' ')
  const t = text.trim()
  return [t, files].filter(Boolean).join(t && files ? '\n\n' : '')
}

/** Which way a browser adds a page to the home screen, for the install hint. */
export type InstallWay = 'ios' | 'android' | null

/**
 * Whether to offer the hint, and how: a phone, in its browser rather than the
 * home-screen app, that has not dismissed it. iPadOS reports a Mac, so a
 * touch Mac counts as iOS.
 */
export function installWay(ua: string, standalone: boolean, touchPoints: number): InstallWay {
  if (standalone) return null
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)) return 'ios'
  if (/Android/.test(ua)) return 'android'
  return null
}

/** Whether this page runs as the home-screen app. */
export function isStandalone(): boolean {
  try {
    if (window.matchMedia?.('(display-mode: standalone)').matches) return true
  } catch { /* an old browser */ }
  return (navigator as Navigator & { standalone?: boolean }).standalone === true
}

export const INSTALL_HINT_KEY = 'caprock.phone.installHint'
