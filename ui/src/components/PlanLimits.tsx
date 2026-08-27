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
import { Stat } from '@/components/ui'

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
 * The compact form for Now: a cell in the Today row, not a band of its own.
 *
 * It was a full-width panel holding two percentages. On the owner's machine
 * both windows were stale — a 5-hour window claiming a reset in 2030 — so the
 * band spent its width on a sentence explaining that the two figures beside it
 * meant nothing, three rows above the money. "It looks strange and it is not
 * part of anything," which is what a lone panel around a reference figure
 * reads as.
 *
 * Now it sits in the Today grid with burn, sessions and cache hit: the same
 * question ("can I keep going") asked at the same size as its neighbours, and
 * when the numbers are stale it says the short version of why.
 */
export function PlanLimitsStat({ limits, now }: { limits: RateLimits | undefined; now: number }) {
  const windows: [string, RateWindow][] = []
  if (limits?.five_hour) windows.push(['5h', limits.five_hour])
  if (limits?.seven_day) windows.push(['7d', limits.seven_day])
  if (windows.length === 0) return null

  const read = windows.map(([label, w]) => ({ label, ...readWindow(w, now) }))
  // A window whose clock cannot be believed is not a small caveat on a
  // percentage — it means the percentage is old too, and 24% from an unknown
  // time ago is not a fact about anything.
  const live = read.filter((r) => !r.stale)
  const allStale = live.length === 0
  // The cell leads with whichever window is closest to its limit, because
  // that is the one that will stop the work.
  const lead = (live.length ? live : read).reduce((a, b) => (b.pct > a.pct ? b : a))
  const other = read.find((r) => r.label !== lead.label)

  return (
    <Stat
      label="Plan limits"
      value={<span className={allStale ? 'text-fg-faint' : lead.color}>{lead.pct}%</span>}
      sub={
        allStale ? (
          <span title="Claude Code writes these to its status line; they stop updating when no session is running">
            last reported a while ago
          </span>
        ) : (
          <span>
            {lead.label} window
            {lead.resetsAt ? ` · resets ${lead.resetsAt}` : ''}
            {other ? ` · ${other.label} ${other.pct}%` : ''}
          </span>
        )
      }
      tone={allStale ? undefined : lead.pct > 85 ? 'danger' : lead.pct >= 60 ? 'warn' : undefined}
      size="compact"
    />
  )
}
