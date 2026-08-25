/**
 * The lifetime line: everything Caprock has ever seen, in one row.
 *
 * These are the figures people quote — a hundred and twenty-nine sessions,
 * fifty-eight days, ten thousand dollars of usage — and they were behind a tab
 * called "History", which reads as a log you would scroll rather than a total
 * you would repeat. Someone who opens the dashboard daily could use it for
 * weeks without seeing the one number that says what all of this added up to.
 *
 * Not the whole screen copied up here: the tool table and the model mix are
 * genuinely a screen's worth of reading. This is the summary — the total, and
 * the three things that make it mean something (how long, how much of it was
 * working days, how many sessions) — with the rest one click away.
 */
import { api } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { fmtUSD } from '@/lib/format'
import { costBasis, costBasisLong } from '@/components/CostBasis'
import type { Settings } from '@/lib/api'

export function LifetimeStrip({ plan }: { plan?: Settings }) {
  // Lifetime totals move slowly; a minute is far more often than they change,
  // and this must never compete with the live panels below it for the socket.
  const h = useApi(() => api.history('all'), [], { intervalMs: 60000 })
  const t = h.data?.totals
  if (!t || t.sessions === 0) return null

  // Sessions per active day, to one decimal — the figure that turns "58 days"
  // into a sense of how the work is shaped. Under 1.0 it reads oddly ("0.7
  // sessions a day"), so it is simply left out there.
  const perDay = t.days > 0 ? t.sessions / t.days : 0

  return (
    <a
      href="#/history"
      className="group flex flex-wrap items-baseline gap-x-6 gap-y-1 rounded-[var(--radius-panel)] border border-border bg-panel px-3 py-2.5 no-underline hover:no-underline hover:border-border-strong"
      title="Every session Caprock has captured — tools, models and projects on the Lifetime screen"
    >
      <span className="text-[10px] uppercase tracking-[0.12em] text-fg-faint">all time</span>

      <span className="inline-flex items-baseline gap-2">
        <span className="num font-semibold tracking-[-0.01em] text-[22px] leading-none text-info">
          {fmtUSD(t.cost_usd)}
        </span>
        <span className="text-[11px] text-fg-faint" title={costBasisLong(plan)}>
          {costBasis(plan)}
        </span>
      </span>

      <Figure value={t.sessions.toLocaleString('en-US')} label="sessions" />
      <Figure value={t.days.toLocaleString('en-US')} label="active days" />
      <Figure value={t.turns.toLocaleString('en-US')} label="turns" />
      {perDay >= 1 && <Figure value={perDay.toFixed(1)} label="sessions a day" />}

      <span className="ml-auto text-[11px] text-fg-faint group-hover:text-accent">
        tools, models, projects →
      </span>
    </a>
  )
}

function Figure({ value, label }: { value: string; label: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="num text-[13px] text-fg">{value}</span>
      <span className="text-[11px] text-fg-muted">{label}</span>
    </span>
  )
}
