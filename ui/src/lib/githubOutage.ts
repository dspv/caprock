/**
 * When GitHub cannot be read: whose fault is it?
 *
 * Owner, 2026-10-15: "Couldn't refresh: could not reach GitHub
 * (api.github.com): context deadline exceeded. Check the connection; Caprock
 * tries again later · showing data from 17:27 · Retry" says nothing a person
 * can act on. After a failure that is GitHub's or the way to it (a timeout,
 * no route, a 5xx), the daemon reads GitHub's own status page
 * (githubstatus.com, `GET /v1/github/statuspage`, kept five minutes) and the
 * line says either "GitHub reports: Partial outage — …" or "GitHub reports
 * all systems operational — likely your connection."
 *
 * Rule 4 (ADR-047, ADR-066): the status page is one more destination of the
 * GitHub integration — asked by the daemon, never the browser; only while
 * GitHub is connected; with no token, no cookie and nothing about the user.
 * Without the opt-in below it is asked only after such a failure.
 *
 * *Watch GitHub Status* (off by default, ticked in that same line) asks it
 * every five minutes while GitHub is connected, and the status bar shows a
 * dot only while GitHub reports an incident. The tick is this viewer's
 * (browser storage): it changes what this window shows and how often it
 * asks, and the daemon's five-minute keep bounds the requests whatever the
 * number of windows.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { ApiError } from './api'
import { agoText, githubApi } from './github'
import type { GitHubStatus as StatusPage } from './reposci'

export type { StatusPage }

export const STATUS_PAGE_URL = 'https://www.githubstatus.com'
export const WATCH_EVERY_MS = 5 * 60_000
const WATCH_KEY = 'caprock.github-status-watch'

/** GitHub's status page through the daemon. Rejects with 409 while GitHub is not connected. */
export function readStatusPage(): Promise<StatusPage> {
  return githubApi.statusPage()
}

/**
 * Whether a failure is GitHub's, or the network's on the way to it — the
 * ones the status page can explain. Not a refused token, a spent rate limit
 * or a missing repository: those are said as they are.
 */
export function isReachFailure(reason: string | undefined): boolean {
  if (!reason) return false
  return /could not reach GitHub|could not download the log|answer from GitHub was cut off|GitHub had a problem \(5\d\d|answered 5\d\d|\b50[234]\b|deadline exceeded|timed? ?out|timeout|connection (refused|reset)|no such host|network is unreachable|failed to fetch|networkerror/i.test(reason)
}

/** How long ago, in words (lib/github.ts agoText): "6 min ago", "2 h ago"; "a moment ago" for under a minute. */
export function agoWords(at: number, now: number): string {
  const t = agoText(at, now)
  return t === 'just now' ? 'a moment ago' : t
}

/** Whether GitHub reports anything wrong. */
export function hasIncident(s: StatusPage | undefined): boolean {
  if (!s || !s.indicator) return false
  return s.indicator !== 'none' || s.incidents.length > 0 || s.components.some((c) => c.status !== 'operational' && c.status !== 'under_maintenance')
}

const INDICATOR: Record<string, string> = {
  minor: 'Partial outage',
  major: 'Major outage',
  critical: 'Critical outage',
  maintenance: 'Maintenance',
}

/**
 * The status page in one line. `kind` is what it says: GitHub reports a
 * problem (`outage`), reports none (`clear`), or could not be read
 * (`unknown`). `url` is the incident's own page, else the status page.
 */
export function outageText(s: StatusPage): { kind: 'outage' | 'clear' | 'unknown'; text: string; url: string } {
  if (s.error && !s.indicator) return { kind: 'unknown', text: 'GitHub Status could not be read either.', url: STATUS_PAGE_URL }
  if (!hasIncident(s)) return { kind: 'clear', text: 'GitHub reports all systems operational — likely your connection.', url: STATUS_PAGE_URL }
  const label = INDICATOR[s.indicator] ?? 'Partial outage'
  const what = s.incidents[0]?.name || s.description
  return { kind: 'outage', text: `GitHub reports: ${label}${what ? ` — ${what}` : ''}`, url: s.incidents[0]?.url || STATUS_PAGE_URL }
}

// The watch tick: this viewer's, re-rendering every reader on a change.
const listeners = new Set<() => void>()
function readWatch(): boolean {
  try { return localStorage.getItem(WATCH_KEY) === '1' } catch { return false }
}
export function setWatching(on: boolean) {
  try {
    if (on) localStorage.setItem(WATCH_KEY, '1')
    else localStorage.removeItem(WATCH_KEY)
  } catch { /* private mode: the tick lasts this page */ }
  for (const l of listeners) l()
}
function subscribe(l: () => void) {
  listeners.add(l)
  return () => { listeners.delete(l) }
}
export function useWatching(): boolean {
  return useSyncExternalStore(subscribe, readWatch, () => false)
}

/**
 * The status page every five minutes while *Watch GitHub Status* is ticked;
 * nothing otherwise. A 409 (GitHub not connected) or an older daemon (404)
 * stops asking until the tick changes.
 */
export function useWatchedStatus(): StatusPage | undefined {
  const on = useWatching()
  const [s, setS] = useState<StatusPage>()
  useEffect(() => {
    if (!on) { setS(undefined); return }
    let alive = true
    let timer = 0
    const tick = () => {
      if (document.hidden) { timer = window.setTimeout(tick, WATCH_EVERY_MS); return }
      readStatusPage().then(
        (v) => { if (alive) { setS(v); timer = window.setTimeout(tick, WATCH_EVERY_MS) } },
        (e) => {
          if (!alive) return
          setS(undefined)
          if (e instanceof ApiError && (e.status === 409 || e.status === 404 || e.status === 501)) return
          timer = window.setTimeout(tick, WATCH_EVERY_MS)
        },
      )
    }
    tick()
    return () => { alive = false; window.clearTimeout(timer) }
  }, [on])
  return s
}
