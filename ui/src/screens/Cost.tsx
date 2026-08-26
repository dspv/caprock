import { useState } from 'react'
import { api, type DailyStat } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { fmtModel, fmtPct, fmtTokens, fmtUSD } from '@/lib/format'
import { Empty, Panel, Skeleton, Stat } from '@/components/ui'
import { BarChart, BarReadout } from '@/components/BarChart'
import { DayGrid } from '@/components/DayGrid'
import { PlanValue } from '@/components/PlanValue'
import { usePlan } from '@/components/PlanPicker'
import { costBasis, costBasisLong } from '@/components/CostBasis'
import { RateLimitRow } from '@/components/PlanLimits'
import { PremiumBanner } from '@/components/PremiumBanner'
import { UnpricedNote } from '@/components/Unpriced'
import { WorkMix } from '@/components/WorkMix'

type Range = 'today' | '7d' | '30d' | 'all'

export function CostScreen() {
  // 30d, matching the Projects panel on Now. On `today` the plan multiple
  // divides a single heavy day by 1/30th of a monthly fee and reads 87x where
  // the honest monthly figure is 37x — a headline that halves when you click
  // another tab is indistinguishable from an invented one.
  const [range, setRange] = useState<Range>('30d')
  // Only used to judge whether a reset clock is plausible, so a value read at
  // render is enough — a ticking clock would repaint the whole screen to move
  // a staleness threshold that is eight days wide.
  const now = Date.now()
  const summary = useApi(() => api.summary(range), [range], { intervalMs: 5000 })
  const daily = useApi(() => api.daily(30), [], { intervalMs: 30000 })
  const [plan] = usePlan()
  const [activeDay, setActiveDay] = useState<string | null>(null)
  const [dayView, setDayView] = useState<'calendar' | 'bars'>('calendar')
  const s = summary.data
  // Before anything has been captured the API returns Go zero values, so this
  // screen rendered a board of $0.00 / 0 with a warn-toned "0% hit rate" — a
  // fault light for a cache that has never been used.
  const measured = !!s && s.turns > 0
  const days = groupDays(daily.data ?? [])
  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-1">
        {(['today', '7d', '30d', 'all'] as Range[]).map((r) => (
          <button key={r} onClick={() => setRange(r)} className={`px-2 py-1 text-[12px] rounded-sm ${range === r ? 'bg-panel-2 text-fg' : 'text-fg-muted hover:text-fg'}`}>{r}</button>
        ))}
        <span className="ml-auto text-[11px] text-fg-faint">{costBasisLong(plan)}{s ? ` (table ${s.pricing_version})` : ''}</span>
      </div>
      {summary.error && !s && <Empty title="Cannot reach the daemon">{summary.error.message}</Empty>}
      {/* Not on `today`: one day is not an average, and a banner that says
        * "$212 a day across 1 active day" is arithmetic dressed as insight. */}
      {range !== 'today' && s && (
        <PremiumBanner
          costUSD={days.reduce((a, d) => a + d.cost, 0)}
          days={days.filter((d) => d.cost > 0).length}
          now={now}
        />
      )}

      <PlanValue summary={s} plan={plan} days={rangeDays(range, s?.from_ms)} />
      <Panel title={`Totals · ${range}`}>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 divide-x divide-border">
          {/* The basis belongs on the tile, not only in the corner note above:
              the misreading happens where the number is. */}
          {/* The basis belongs on the tile, not only in the corner note above:
              the misreading happens where the number is. The session count used
              to live here and now does not — appended to the basis it pushed
              the line past the column and truncated the part that matters. */}
          <Stat label="Cost" value={measured ? fmtUSD(s!.cost_usd) : '—'} sub={<span title={costBasisLong(plan)}>{measured ? costBasis(plan) : 'nothing measured in this range'}</span>} tone="info" size="hero" />
          <Stat label="Burn now" value={measured ? `${fmtUSD(s!.burn.usd_per_hour)}/h` : '—'} sub={measured ? `${fmtTokens(Math.round(s!.burn.tokens_per_min))} tok/min · ${s!.sessions} sessions` : undefined}  />
          <Stat label="Input" value={measured ? fmtTokens(s!.tokens_in) : '—'} sub="fresh, full price" />
          <Stat label="Output" value={measured ? fmtTokens(s!.tokens_out) : '—'} sub={measured ? `${s!.turns} turns` : undefined} />
          <Stat label="Cache read" value={measured ? fmtTokens(s!.cache_read) : '—'} sub={measured ? `${fmtPct(s!.savings.hit_rate * 100)} hit rate` : undefined} tone={measured && s!.savings.hit_rate < 0.9 ? 'warn' : undefined} />
          <Stat label="Cache write" value={measured ? fmtTokens(s!.cache_write) : '—'} sub={measured ? `${fmtPct(s!.savings.cut_pct)} input cost cut by cache` : undefined} />
        </div>
        {/* The money screen is exactly where an incomplete total misleads. */}
        <UnpricedNote u={s?.unpriced} className="mx-3 mb-2.5" />
      </Panel>
      {/* Three cuts of one question — by model, by kind of work, by project —
          so they sit as equals in one row rather than leaving the third
          orphaned at half width beside dead space. They collapse to two
          columns and then to one as the viewport narrows. */}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <Panel title="Model mix" right={<span>by cost</span>}>
          {!s ? <Skeleton rows={4} /> : s.models.length === 0 && <Empty title="No priced turns in range" />}
          <table className="w-full text-[12px]">
            <tbody>
              {(s?.models ?? []).map((m) => (
                <tr key={m.model} className="border-b border-border/60 last:border-0">
                  <td className="px-3 py-1 mono" title={m.model || undefined}>{m.model ? fmtModel(m.model) : 'unknown'}</td>
                  <td className="px-3 py-1 num text-right text-fg-muted">{m.turns} turns</td>
                  <td className="px-3 py-1 num text-right text-fg-muted">{fmtTokens(m.tokens)}</td>
                  {/* An unpriced model summed to 0 and rendered "$0.00",
                      which reads as free. It has no price, so it shows none. */}
                  <td className="px-3 py-1 num text-right">{(s?.unpriced?.models ?? []).includes(m.model) ? <span className="text-warn" title="this model is not in the pricing table, so its cost is unknown">unpriced</span> : fmtUSD(m.cost_usd)}</td>
                  <td className="px-3 py-1 num text-right text-fg-faint w-14">{s && s.cost_usd > 0 && !(s.unpriced?.models ?? []).includes(m.model) ? fmtPct((100 * m.cost_usd) / s.cost_usd) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
        {/* The third cut of "where did the money go": by model, by project, and
            by the KIND of work each turn did. It sits with its siblings rather
            than on a screen of its own because it answers the same question. */}
        <WorkMix summary={s} />
        <Panel title="Per project" right={<span>by cost</span>}>
          {!s ? <Skeleton rows={4} /> : s.projects.length === 0 && <Empty title="No priced turns in range" />}
          <table className="w-full text-[12px]">
            <tbody>
              {(s?.projects ?? []).map((p) => (
                <tr key={p.project} className="border-b border-border/60 last:border-0">
                  <td className="px-3 py-1">{p.project || 'unknown'}</td>
                  <td className="px-3 py-1 num text-right text-fg-muted">{fmtTokens(p.tokens)}</td>
                  <td className="px-3 py-1 num text-right">{fmtUSD(p.cost_usd)}</td>
                  <td className="px-3 py-1 num text-right text-fg-faint w-14">{s && s.cost_usd > 0 ? fmtPct((100 * p.cost_usd) / s.cost_usd) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
      {/* The month and the limits share a row: the chart does not need full
          width to be read, and the two limit rows left most of theirs empty.
          Side by side each one is the size of what it has to say. */}
      <div className="grid gap-3 lg:grid-cols-3">
        <Panel
          className="lg:col-span-2"
          title="Last 30 days"
          right={
            <span className="flex items-center gap-3">
              <BarReadout bars={days} active={activeDay} total={days.reduce((a, d) => a + d.cost, 0)} />
              {/* Two readings of the same month: the calendar shows the rhythm
                * — which weekdays you work — and the bars show the amounts. */}
              <span className="flex items-center gap-1">
                {(['calendar', 'bars'] as const).map((v) => (
                  <button
                    key={v}
                    onClick={() => setDayView(v)}
                    className={`px-1.5 py-0.5 rounded-sm text-[11px] ${dayView === v ? 'bg-panel-2 text-fg' : 'text-fg-faint hover:text-fg'}`}
                  >
                    {v}
                  </button>
                ))}
              </span>
            </span>
          }
        >
          {!daily.data ? <Skeleton rows={2} /> : days.length === 0 && <Empty title="No history yet" />}
          {days.length > 0 &&
            (dayView === 'calendar' ? (
              <DayGrid bars={days} active={activeDay} onActive={setActiveDay} />
            ) : (
              <BarChart bars={days} active={activeDay} onActive={setActiveDay} />
            ))}
        </Panel>
      {/* Rendered even with no data. The panel used to vanish when Claude Code
        * was not feeding the status line, so the one screen that could have
        * explained why there are no limits showed nothing at all — the same
        * shape as the spawn button that hid the dialog explaining itself. */}
      {s && (
        <Panel title="Plan limits">
          {/* px-3 like every other panel's body. Without it the rows ran into
            * the panel border on both sides, which is the one place the eye
            * reads a table as unfinished rather than dense. */}
          {s.rate_limits ? (
            <div className="flex flex-col gap-2 px-3 pt-1">
              {s.rate_limits.five_hour && <RateLimitRow label="5-hour window" w={s.rate_limits.five_hour} now={now} />}
              {s.rate_limits.seven_day && <RateLimitRow label="7-day window" w={s.rate_limits.seven_day} now={now} />}
            </div>
          ) : (
            <div className="px-3 pt-1 text-sm text-fg-muted">
              No window state yet. Caprock reads this from Claude Code's status line, so it appears
              once a Pro or Max session has run with <span className="mono text-fg">caprock statusline</span> registered —
              <span className="mono text-fg"> caprock up</span> offers to do that. API-billed usage has no windows to report.
            </div>
          )}
          <div className="mt-2 px-3 pb-3 text-[11px] text-fg-faint leading-relaxed">
            Live from Claude Code's status line (Pro/Max). The percentage is your usage of the window; a
            forecast is shown only when your measured pace would reach the limit before the window resets.
          </div>
        </Panel>
      )}
      </div>
      <div className="text-[11px] text-fg-faint">
        {s && s.throttles > 0
          ? `${s.throttles} rate-limit / overloaded event${s.throttles === 1 ? "" : "s"} observed in this range (from Claude Code's StopFailure hook).`
          : "No rate-limit events observed in this range."}{" "}
        Everything here is measured — no invented numbers.
      </div>
    </div>
  )
}

export function groupDays(rows: DailyStat[]): { day: string; cost: number; tokens: number; sessions: number }[] {
  const m = new Map<string, { day: string; cost: number; tokens: number; sessions: number }>()
  for (const r of rows) {
    const d = m.get(r.day) ?? { day: r.day, cost: 0, tokens: 0, sessions: 0 }
    d.cost += r.cost_usd
    d.tokens += r.tokens_total
    d.sessions += r.sessions
    m.set(r.day, d)
  }
  return [...m.values()].sort((a, b) => a.day.localeCompare(b.day))
}

// rangeDays is how many days the selected range covers, used to scale a monthly
// plan fee to the same window. "all" is treated as 30 so the comparison stays a
// like-for-like month rather than a number that grows with retention.
// rangeDays is how many days the selected range covers, used to scale a monthly
// plan fee to the same window. "all" is derived from the summary's own start so
// the comparison stays like-for-like: hardcoding 30 divided all-time usage by a
// 30-day fee and inflated the headline multiple by however much history exceeds
// a month, while the caption claimed the denominator was 30 days.
function rangeDays(range: Range, fromMs?: number): number {
  switch (range) {
    case 'today': return 1
    case '7d': return 7
    case '30d': return 30
    default:
      if (!fromMs) return 30
      return Math.max(1, Math.ceil((Date.now() - fromMs) / 86_400_000))
  }
}
