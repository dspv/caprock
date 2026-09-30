import type { HandoffGroup } from '@/lib/api'

/** Sessions each group needs to have reached a first edit before a comparison is shown. */
export const HANDOFF_MIN_REACHED = 5

/**
 * Whether the handoff is worth anything, measured on this machine.
 *
 * A new session is handed what the last one in its folder left behind; with a
 * holdout on, some are not, at random. Both groups are timed to their first
 * edit — how long a session spends finding its footing. Until each has enough
 * sessions this says how far along the count is rather than a number that
 * would move with the next session.
 */
export function HandoffEffect({ holdout, served, withheld }: { holdout?: number; served?: HandoffGroup; withheld?: HandoffGroup }) {
  if (!holdout && !withheld?.sessions) return null
  const ready = (served?.reached ?? 0) >= HANDOFF_MIN_REACHED && (withheld?.reached ?? 0) >= HANDOFF_MIN_REACHED
  return (
    <div className="border border-border rounded-[var(--radius-panel)] px-3 py-2 text-[12px] grid gap-1">
      <div className="flex items-baseline gap-2">
        <span className="text-fg font-medium">Does the handoff help?</span>
        <span className="text-fg-faint text-[11px]">time to a session’s first edit, with and without it</span>
      </div>
      {ready && served && withheld ? (
        <div className="grid grid-cols-[auto_auto_auto] gap-x-4 gap-y-0.5 w-fit num">
          <span className="text-fg-muted">with it</span>
          <span className="text-fg">{served.median_min.toFixed(1)} min</span>
          <span className="text-fg-muted">{served.median_calls} tool calls · {served.reached} sessions</span>
          <span className="text-fg-muted">without</span>
          <span className="text-fg">{withheld.median_min.toFixed(1)} min</span>
          <span className="text-fg-muted">{withheld.median_calls} tool calls · {withheld.reached} sessions</span>
        </div>
      ) : (
        <span className="text-fg-muted">
          Measuring: {served?.reached ?? 0} with it and {withheld?.reached ?? 0} without have reached an edit; the
          comparison shows once each has {HANDOFF_MIN_REACHED}.
        </span>
      )}
    </div>
  )
}
