import { useEffect, useState } from 'react'
import { freshText } from '@/lib/deckCache'

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
 *   - The last read failed: "Couldn't refresh: <reason> · showing data from
 *     15:02 · Retry". `compact` (the deck's header) keeps the reason to the
 *     tooltip.
 *
 * Its own clock, every 5 s while visible.
 */
export function Freshness({ at, loading, failed, reason, confirmed = true, onRetry, compact }: {
  at?: number
  loading: boolean
  failed: boolean
  reason?: string
  confirmed?: boolean
  onRetry?: () => void
  compact?: boolean
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
  const clock = when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const day = new Date(now).toDateString() === when.toDateString() ? clock : `${when.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${clock}`
  const ago = freshText(Math.max(0, now - at))
  const said = (confirmed ? ago : ago.replace(/^updated/, 'saved')).replace(/^./, (c) => c.toUpperCase())
  const retry = onRetry && (
    <button type="button" data-deck-fresh-retry onClick={onRetry} className="shrink-0 text-accent hover:underline">Retry</button>
  )
  if (failed) {
    const why = reason ? `Couldn’t refresh: ${reason.trim().replace(/[.;:]+$/, '')}` : 'Couldn’t refresh'
    return (
      <span data-deck-fresh="failed" className="flex min-w-0 items-baseline gap-1.5 text-warn" title={`${why}. Showing what was read at ${when.toLocaleString()}.`}>
        <span className="min-w-0 truncate">{compact ? 'Couldn’t refresh' : why}</span>
        <span className="num shrink-0 text-fg-faint">· showing data from {day}</span>
        {retry && <span aria-hidden className="text-fg-faint">·</span>}{retry}
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
