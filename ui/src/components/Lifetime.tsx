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
import { SLOW_LIVE_MS } from '@/lib/refresh'
import { StaleNote, Stat } from '@/components/ui'
import { fmtUSD } from '@/lib/format'
import { costBasis, costBasisLong } from '@/components/CostBasis'
import type { Settings } from '@/lib/api'
import { useLicensed, useNudgeSlot } from '@/lib/nudges'
import { extTitle } from '@/lib/externalLinks'

export function LifetimeStrip({ plan }: { plan?: Settings }) {
  // Lifetime totals move slowly; a minute is far more often than they change,
  // and this must never compete with the live panels below it for the socket.
  const h = useApi(() => api.history('all'), [], { intervalMs: 60000, cache: 'history:all', liveMs: SLOW_LIVE_MS })
  const t = h.data?.totals
  if (!t || t.sessions === 0) return null

  // Sessions per active day, to one decimal — the figure that turns "58 days"
  // into a sense of how the work is shaped. Under 1.0 it reads oddly ("0.7
  // sessions a day"), so it is simply left out there.
  const perDay = t.days > 0 ? t.sessions / t.days : 0

  // Tiles, the Cost screen's Totals row: a label over each figure, five equal
  // cells that never wrap mid-row (owner, 2026-10-31: the running line spilt
  // "sessions a day" onto a second line). The stale note and the cap hint
  // sit under the row only when there is something to say.
  return (
    // Sized by its own width, not the window's: the strip shares its row with
    // Quick chat and New session, so the window says little about its room.
    // One row of equal tiles from 520 px, two columns below.
    <div data-lifetime-strip className="@container h-full overflow-hidden rounded-[var(--radius-panel)] border border-border bg-panel">
      <div className="grid grid-cols-2 divide-x divide-border @min-[520px]:grid-flow-col @min-[520px]:auto-cols-fr">
        <Stat data="lifetime-cost" label="all time" size="compact" tone="info" value={fmtUSD(t.cost_usd)}
          sub={<span title={costBasisLong(plan)}>{costBasis(plan)}</span>} />
        <Stat data="lifetime-sessions" label="sessions" size="compact" value={t.sessions.toLocaleString('en-US')} />
        <Stat data="lifetime-days" label="active days" size="compact" value={t.days.toLocaleString('en-US')} />
        <Stat data="lifetime-turns" label="turns" size="compact" value={t.turns.toLocaleString('en-US')} />
        {perDay >= 1 && <Stat data="lifetime-per-day" label="sessions a day" size="compact" value={perDay.toFixed(1)} />}
      </div>
      <div className="flex items-baseline justify-end gap-4 border-t border-border px-3 py-1.5 text-[11px] empty:hidden">
        {h.stale && <StaleNote at={h.cachedAt} />}
        <CapHint />
      </div>
    </div>
  )
}

/**
 * The spend-cap offer, shown on the days it would have been worth having.
 *
 * A permanent link is wallpaper — read once, ignored after. This appears when
 * today has already cost half again what a normal day costs on this machine,
 * which is both when the thought occurs on its own and the only honest moment
 * to raise it. On an ordinary day it is absent, and the row is quieter for it.
 *
 * The comparison is against the median of the last thirty days rather than the
 * mean: one runaway afternoon drags a mean upward and would then suppress the
 * hint on exactly the days that follow it.
 */
function CapHint() {
  const daily = useApi(() => api.daily(30), [], { intervalMs: 300000, cache: 'daily:30', liveMs: SLOW_LIVE_MS })
  const today = useApi(() => api.summary('today'), [], { intervalMs: 30000, cache: 'summary:today:all' })

  const rows = daily.data ?? []
  const byDay = new Map<string, number>()
  for (const r of rows) byDay.set(r.day, (byDay.get(r.day) ?? 0) + r.cost_usd)
  const spent = [...byDay.values()].filter((v) => v > 0).sort((a, b) => a - b)
  const median = spent[Math.floor(spent.length / 2)] ?? 0
  const cost = today.data?.cost_usd ?? 0
  // Fewer than a week of data is not a baseline, and a threshold drawn from
  // two days would fire on the second one. Never to a payer, and one offer
  // on screen at a time (lib/nudges.ts).
  const licensed = useLicensed()
  const mine = useNudgeSlot('premium-cap', !licensed && spent.length >= 7 && median > 0 && cost >= median * 1.5)
  if (!mine) return null

  return (
    <a
      href="https://caprock.dev/premium"
      target="_blank"
      rel="noreferrer"
      className="text-[11px] text-warn hover:text-accent no-underline"
      title={extTitle("Caprock pauses the sessions it started once the day's cost passes a number you choose")}
    >
      today is {(cost / median).toFixed(1)}× a normal day — set a limit
    </a>
  )
}
