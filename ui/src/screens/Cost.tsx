import { useState } from 'react'
import { api, type DailyStat, type RateWindow } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { fmtPct, fmtTokens, fmtUSD } from '@/lib/format'
import { Empty, Panel, Stat } from '@/components/ui'

type Range = 'today' | '7d' | '30d' | 'all'

export function CostScreen() {
  const [range, setRange] = useState<Range>('today')
  const summary = useApi(() => api.summary(range), [range], { intervalMs: 5000 })
  const daily = useApi(() => api.daily(30), [], { intervalMs: 30000 })
  const s = summary.data
  const days = groupDays(daily.data ?? [])
  const maxDay = Math.max(...days.map((d) => d.cost), 1e-9)
  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-1">
        {(['today', '7d', '30d', 'all'] as Range[]).map((r) => (
          <button key={r} onClick={() => setRange(r)} className={`px-2 py-1 text-[12px] rounded-sm ${range === r ? 'bg-panel-2 text-fg' : 'text-fg-muted hover:text-fg'}`}>{r}</button>
        ))}
        <span className="ml-auto text-[11px] text-fg-faint">Costs are computed at Anthropic API list prices{s ? ` (table ${s.pricing_version})` : ''}. On a Pro/Max plan they are an API-equivalent, not money out of pocket.</span>
      </div>
      <Panel title={`Totals · ${range}`}>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 divide-x divide-border">
          <Stat label="Cost" value={fmtUSD(s?.cost_usd)} sub={s ? `${s.sessions} sessions` : undefined} />
          <Stat label="Burn now" value={s ? `${fmtUSD(s.burn.usd_per_hour)}/h` : '—'} sub={s ? `${fmtTokens(Math.round(s.burn.tokens_per_min))} tok/min · ${s.burn.turns} turns / ${s.burn.window_min}m` : undefined} tone={s && s.burn.usd_per_hour > 0 ? 'info' : undefined} />
          <Stat label="Input" value={fmtTokens(s?.tokens_in)} sub="fresh, full price" />
          <Stat label="Output" value={fmtTokens(s?.tokens_out)} sub={s ? `${s.turns} turns` : undefined} />
          <Stat label="Cache read" value={fmtTokens(s?.cache_read)} sub={s ? `${fmtPct(s.savings.hit_rate * 100)} hit rate` : undefined} tone={s && s.savings.hit_rate > 0.5 ? 'ok' : undefined} />
          <Stat label="Cache write" value={fmtTokens(s?.cache_write)} sub={s ? `${fmtPct(s.savings.cut_pct)} input cost cut by cache` : undefined} />
        </div>
      </Panel>
      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title="Model mix" right={<span>by cost</span>}>
          {s && s.models.length === 0 && <Empty title="No priced turns in range" />}
          <table className="w-full text-[12px]">
            <tbody>
              {(s?.models ?? []).map((m) => (
                <tr key={m.model} className="border-b border-border/60 last:border-0">
                  <td className="px-3 py-1 mono">{m.model || 'unknown'}</td>
                  <td className="px-3 py-1 num text-right text-fg-muted">{m.turns} turns</td>
                  <td className="px-3 py-1 num text-right text-fg-muted">{fmtTokens(m.tokens)}</td>
                  <td className="px-3 py-1 num text-right">{fmtUSD(m.cost_usd)}</td>
                  <td className="px-3 py-1 num text-right text-fg-faint w-14">{s && s.cost_usd > 0 ? fmtPct((100 * m.cost_usd) / s.cost_usd) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
        <Panel title="Per project" right={<span>by cost</span>}>
          {s && s.projects.length === 0 && <Empty title="No priced turns in range" />}
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
      <Panel title="Last 30 days" right={<span className="num">{fmtUSD(days.reduce((a, d) => a + d.cost, 0))}</span>}>
        {days.length === 0 && <Empty title="No history yet" />}
        {days.length > 0 && (
          <div className="px-3 py-3 flex items-end gap-[3px]">
            {days.map((d) => (
              <div key={d.day} className="flex-1 flex flex-col items-center justify-end gap-1 min-w-0" style={{ height: 112 }} title={`${d.day}: ${fmtUSD(d.cost)} · ${fmtTokens(d.tokens)} tokens · ${d.sessions} sessions`}>
                <div className="w-full bg-accent/70 hover:bg-accent rounded-t-sm" style={{ height: Math.max(2, Math.round((96 * d.cost) / maxDay)) }} />
                <div className="num text-[9px] text-fg-faint">{d.day.slice(8)}</div>
              </div>
            ))}
          </div>
        )}
      </Panel>
      {s?.rate_limits && (
        <Panel title="Plan limits">
          <div className="flex flex-col gap-2">
            {s.rate_limits.five_hour && <RateLimitRow label="5-hour window" w={s.rate_limits.five_hour} />}
            {s.rate_limits.seven_day && <RateLimitRow label="7-day window" w={s.rate_limits.seven_day} />}
          </div>
          <div className="mt-2 text-[11px] text-fg-faint">
            Live from Claude Code's status line (Pro/Max). The percentage is your usage of the window; a
            forecast is shown only when your measured pace would reach the limit before the window resets.
          </div>
        </Panel>
      )}
      <div className="text-[11px] text-fg-faint">
        {s && s.throttles > 0
          ? `${s.throttles} rate-limit / overloaded event${s.throttles === 1 ? "" : "s"} observed in this range (from Claude Code's StopFailure hook).`
          : "No rate-limit events observed in this range."}{" "}
        Everything here is measured — no invented numbers.
      </div>
    </div>
  )
}

function RateLimitRow({ label, w }: { label: string; w: RateWindow }) {
  const pct = Math.round(w.used_percentage)
  const color = pct > 85 ? 'text-danger' : pct >= 60 ? 'text-warn' : 'text-fg'
  const resetsAt = w.resets_at ? new Date(w.resets_at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-fg-muted">{label}</span>
      <span className="flex items-baseline gap-3">
        <span className={`font-mono tabular-nums ${color}`}>{pct}%</span>
        {resetsAt && <span className="text-fg-faint">resets {resetsAt}</span>}
        {w.forecast && <span className="text-warn">{w.forecast}</span>}
      </span>
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
