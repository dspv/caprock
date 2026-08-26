/**
 * How much of the plan's window is left.
 *
 * This lived only on the Cost screen, in the second column of the bottom row,
 * below a thirty-day chart — and a user who wanted it went looking and did not
 * find it. That is a placement problem, not a missing feature: Cost answers
 * "what has this cost me", and a limit answers "can I keep going", which is a
 * question about right now. So it also belongs on Now, beside the burn rate.
 *
 * The two screens share this file rather than each rendering their own rows.
 * The staleness rule below is subtle enough that two copies of it would drift,
 * and the copy that drifts is the one nobody is looking at.
 */
import type { RateLimits, RateWindow } from '@/lib/api'

/** A window's percentage, and whether its reset clock can be believed. */
export function readWindow(w: RateWindow, now: number) {
  const pct = Math.round(w.used_percentage)
  // These come from Claude Code's status line and go stale the moment a session
  // stops writing them. A reset already past, or implausibly far ahead, is a
  // stale sample rather than a fact — rendered as a clock, the 5-hour window
  // confidently announced a reset in 2030.
  const resetMs = (w.resets_at ?? 0) * 1000
  const plausible = resetMs > now && resetMs < now + 8 * 24 * 3600 * 1000
  return {
    pct,
    color: pct > 85 ? 'text-danger' : pct >= 60 ? 'text-warn' : 'text-fg',
    resetsAt: plausible
      ? new Date(resetMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : null,
    stale: w.resets_at ? !plausible : false,
  }
}

export function RateLimitRow({ label, w, now }: { label: string; w: RateWindow; now: number }) {
  const { pct, color, resetsAt, stale } = readWindow(w, now)
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-fg-muted">{label}</span>
      <span className="flex items-baseline gap-3">
        <span className={`font-mono tabular-nums ${color}`}>{pct}%</span>
        {resetsAt && <span className="text-fg-faint">resets {resetsAt}</span>}
        {stale && <span className="text-fg-faint" title="Claude Code has not refreshed this window recently">reset time stale</span>}
        {w.forecast && <span className="text-warn">{w.forecast}</span>}
      </span>
    </div>
  )
}

/**
 * The compact form for Now: one line, both windows, no panel.
 *
 * Renders nothing when there is no data — but unlike the Cost panel, that is
 * the right answer here rather than a hiding place. Now is not where someone
 * would go to learn the feature exists; the Cost screen says so instead.
 */
export function PlanLimitsLine({ limits, now }: { limits: RateLimits | undefined; now: number }) {
  const windows: [string, RateWindow][] = []
  if (limits?.five_hour) windows.push(['5h', limits.five_hour])
  if (limits?.seven_day) windows.push(['7d', limits.seven_day])
  if (windows.length === 0) return null
  return (
    <div className="flex items-baseline gap-4 px-0.5 text-[12px]">
      <span className="uppercase tracking-[0.08em] text-fg-faint">Plan limits</span>
      {windows.map(([label, w]) => {
        const { pct, color, resetsAt, stale } = readWindow(w, now)
        return (
          <span key={label} className="flex items-baseline gap-1.5">
            <span className="text-fg-muted">{label}</span>
            <span className={`mono tabular-nums ${color}`}>{pct}%</span>
            {resetsAt && <span className="text-fg-faint">resets {resetsAt}</span>}
            {stale && <span className="text-fg-faint" title="Claude Code has not refreshed this window recently">stale</span>}
            {w.forecast && <span className="text-warn">{w.forecast}</span>}
          </span>
        )
      })}
      <a href="#/cost" className="link ml-auto text-[11px] text-fg-faint hover:text-fg-muted">details</a>
    </div>
  )
}
