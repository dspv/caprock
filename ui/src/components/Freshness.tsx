import { useEffect, useState } from 'react'
import { freshText } from '@/lib/deckCache'
import { agoWords, isReachFailure } from '@/lib/githubOutage'
import { GitHubStatusCheck } from './GitHubOutage'

/**
 * The header's one quiet line on how fresh what is shown is (owner,
 * 2026-10-14, translated: "we need an indicator that it's updating — like
 * 'wait' — so I understand whether this data is real or cached"). Never a
 * bare "updating…": always with the time of what is shown.
 *
 *   - Fresh: "Updated just now", ticking.
 *   - Being read again: "Saved 5 h ago · refreshing…" when what is shown is
 *     the copy kept from before (not yet re-confirmed), "Updated 2 min ago ·
 *     refreshing…" when the daemon said so this time, a faint pulse beside.
 *   - The last read failed: "Couldn't refresh: <reason>. Showing data from
 *     6 min ago. Retry", the exact time and the raw reason in the tooltip.
 *     `compact` (the deck's header) keeps the reason to the tooltip.
 *   - It failed on the way to GitHub (a timeout, no route, a 5xx; `github`
 *     callers only): "Couldn't reach GitHub. Showing data from 6 min ago.
 *     Retry", then what GitHub's status page says (GitHubStatusCheck,
 *     lib/githubOutage.ts; owner, 2026-10-15).
 *
 * Its own clock, every 5 s while visible.
 */
export function Freshness({ at, loading, failed, reason, confirmed = true, onRetry, compact, github }: {
  at?: number
  loading: boolean
  failed: boolean
  reason?: string
  confirmed?: boolean
  onRetry?: () => void
  compact?: boolean
  /** What is shown is GitHub's: a failure on the way to it asks GitHub's status page. */
  github?: boolean
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!at) return
    setNow(Date.now())
    const t = window.setInterval(() => { if (!document.hidden) setNow(Date.now()) }, 5_000)
    return () => window.clearInterval(t)
  }, [at])
  if (!at) return null
  const when = new Date(at)
  const ago = freshText(Math.max(0, now - at))
  const said = (confirmed ? ago : ago.replace(/^updated/, 'saved')).replace(/^./, (c) => c.toUpperCase())
  const retry = onRetry && (
    <button type="button" data-deck-fresh-retry onClick={onRetry} className="shrink-0 text-accent hover:underline">Retry</button>
  )
  if (failed) {
    const raw = reason?.trim().replace(/[.;:]+$/, '')
    const reach = !!github && isReachFailure(reason)
    const why = reach ? 'Couldn’t reach GitHub' : raw ? `Couldn’t refresh: ${raw}` : 'Couldn’t refresh'
    const from = agoWords(at, now)
    const title = `${raw ? `${raw}.\n` : ''}Showing what was read at ${when.toLocaleString()}.`
    return (
      <span data-deck-fresh="failed" data-deck-fresh-reach={reach ? 'yes' : undefined} title={title}
        className={`flex min-w-0 items-baseline gap-x-1.5 text-warn ${compact ? '' : 'flex-wrap gap-y-0.5'}`}>
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="min-w-0 truncate">{compact ? (reach ? why : 'Couldn’t refresh') : `${why}.`}</span>{' '}
          <span className="num shrink-0 text-fg-faint">{compact ? `· showing data from ${from}` : `Showing data from ${from}.`}</span>
        </span>{' '}
        {retry}{' '}
        {reach && <GitHubStatusCheck reason={reason} compact={compact} />}
      </span>
    )
  }
  if (loading) {
    return (
      <span data-deck-fresh="updating" data-deck-fresh-confirmed={confirmed ? 'yes' : 'no'} className="num flex shrink-0 items-center gap-1.5 text-fg-faint"
        title={`${confirmed ? 'Read' : 'Kept from before'} at ${when.toLocaleString()}; being read again`}>
        <span aria-hidden className="inline-block h-[6px] w-[6px] rounded-full bg-accent/70 animate-pulse motion-reduce:animate-none" />
        {said} · refreshing…
      </span>
    )
  }
  return <span data-deck-fresh="ok" className="num shrink-0 text-fg-faint" title={`Read at ${when.toLocaleString()}`}>{said}</span>
}
