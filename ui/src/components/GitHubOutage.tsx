/**
 * Whose fault it is when GitHub cannot be read, said in the freshness line
 * (Freshness), and the opt-in status-bar dot while GitHub reports an
 * incident. The rules and rule 4 are in lib/githubOutage.ts.
 */
import { useEffect, useState } from 'react'
import { ApiError } from '@/lib/api'
import { openExternal } from '@/lib/nudges'
import {
  STATUS_PAGE_URL, hasIncident, outageText, readStatusPage, setWatching, useWatchedStatus, useWatching, type StatusPage,
} from '@/lib/githubOutage'

/**
 * "Checking GitHub Status…", then what the status page says. Asked once per
 * failure (`reason`); nothing at all while GitHub is not connected or the
 * daemon has no such endpoint. `compact` (a header) says it in a few words
 * with the sentence in the tooltip, and leaves the watch tick out.
 */
export function GitHubStatusCheck({ reason, compact }: { reason?: string; compact?: boolean }) {
  const [state, setState] = useState<{ s?: StatusPage; done: boolean; gone?: boolean }>({ done: false })
  useEffect(() => {
    let alive = true
    setState({ done: false })
    readStatusPage().then(
      (s) => { if (alive) setState({ s, done: true }) },
      (e) => {
        if (!alive) return
        const gone = e instanceof ApiError && (e.status === 409 || e.status === 404 || e.status === 501)
        setState({ done: true, gone })
      },
    )
    return () => { alive = false }
  }, [reason])
  if (state.gone) return null
  if (!state.done) {
    return (
      <span data-gh-status="checking" className="inline-flex shrink-0 items-center gap-1.5 text-fg-faint">
        <span aria-hidden className="inline-block h-[6px] w-[6px] rounded-full bg-fg-faint/70 animate-pulse motion-reduce:animate-none" />
        {compact ? 'checking GitHub Status…' : 'Checking GitHub Status…'}
      </span>
    )
  }
  const said = state.s ? outageText(state.s) : { kind: 'unknown' as const, text: 'GitHub Status could not be read either.', url: STATUS_PAGE_URL }
  const tone = said.kind === 'outage' ? 'text-warn' : 'text-fg-muted'
  const link = (
    <button type="button" data-gh-status-open onClick={() => openExternal(said.url)}
      className="shrink-0 text-accent hover:underline" title={said.url}>
      {compact ? 'githubstatus.com ↗' : 'Open githubstatus.com'}
    </button>
  )
  if (compact) {
    const short = said.kind === 'outage' ? 'GitHub reports an outage' : said.kind === 'clear' ? 'likely your connection' : 'GitHub Status unknown'
    return (
      <span data-gh-status={said.kind} className={`inline-flex min-w-0 items-baseline gap-1.5 ${tone}`} title={said.text}>
        <span className="min-w-0 truncate">{short}</span>{' '}
        {said.kind === 'outage' && link}
      </span>
    )
  }
  return (
    <span data-gh-status={said.kind} className="inline-flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className={`min-w-0 ${tone}`}>{said.text}</span>{' '}
      {said.kind !== 'clear' && link}{' '}
      <WatchToggle />
    </span>
  )
}

/** *Watch GitHub Status*: off by default; on, the status bar shows a dot while GitHub reports an incident. */
function WatchToggle() {
  const on = useWatching()
  return (
    <label className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 text-fg-faint hover:text-fg-muted"
      title="Ask githubstatus.com every 5 minutes while GitHub is connected, and show a dot in the status bar while GitHub reports an incident. Off by default.">
      <input type="checkbox" data-gh-status-watch checked={on} onChange={(e) => setWatching(e.target.checked)} className="h-[12px] w-[12px] accent-[var(--color-accent)]" />
      Watch GitHub Status
    </label>
  )
}

/**
 * The status-bar dot: only while *Watch GitHub Status* is ticked and GitHub
 * reports an incident. A click opens the incident, or the status page.
 */
export function GitHubStatusDot() {
  const s = useWatchedStatus()
  if (!s || !hasIncident(s)) return null
  const said = outageText(s)
  const major = s.indicator === 'major' || s.indicator === 'critical'
  return (
    <button type="button" data-gh-status-dot onClick={() => openExternal(said.url)}
      title={`${said.text}\nFrom githubstatus.com, read every 5 minutes. Click to open it.`}
      className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap hover:text-fg">
      <span aria-hidden className={`inline-block h-[7px] w-[7px] rounded-full ${major ? 'bg-danger' : 'bg-warn'}`} />
      GitHub
    </button>
  )
}
