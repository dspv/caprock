import { useState } from 'react'
import { api } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { fmtDuration, fmtPct, fmtTokens, fmtUSD, fmtTool } from '@/lib/format'
import { Empty, Panel, Stat } from '@/components/ui'
import { groupDays } from './Cost'
import { BarChart, BarReadout } from '@/components/BarChart'

type Range = 'today' | '7d' | '30d' | 'all'

export function HistoryScreen() {
  const [range, setRange] = useState<Range>('all')
  const [activeDay, setActiveDay] = useState<string | null>(null)
  const h = useApi(() => api.history(range), [range], { intervalMs: 15000 })
  const d = h.data
  const days = groupDays(d?.daily ?? [])
  const maxTool = Math.max(...(d?.tools ?? []).map((t) => t.count), 1)
  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-1">
        {(['today', '7d', '30d', 'all'] as Range[]).map((r) => (
          <button key={r} onClick={() => setRange(r)} className={`px-2 py-1 text-[12px] rounded-sm ${range === r ? 'bg-panel-2 text-fg' : 'text-fg-muted hover:text-fg'}`}>{r}</button>
        ))}
        <span className="ml-auto text-[11px] text-fg-faint">Everything you ever ran through Caprock. Measured, not estimated.</span>
      </div>
      {h.error && !d && <Empty title="Cannot reach the daemon">{h.error.message}</Empty>}
      <Panel title={`Lifetime · ${range}`}>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 divide-x divide-border">
          <Stat label="Sessions" value={d ? d.totals.sessions : '—'} sub={d ? `${d.totals.owned_sessions} spawned by caprock` : undefined} />
          <Stat label="Active days" value={d ? d.totals.days : '—'} />
          <Stat label="Turns" value={d ? fmtTokens(d.totals.turns) : '—'} sub={d ? `${fmtTokens(d.totals.tool_calls)} tool calls` : undefined} />
          <Stat label="Files touched" value={d ? fmtTokens(d.totals.files_touched) : '—'} />
          <Stat label="Avg session" value={d ? fmtDuration(Math.round(d.totals.avg_session_sec * 1000)) : '—'} />
          <Stat label="Cache hit" value={d ? fmtPct(d.savings.hit_rate * 100) : '—'} sub={d ? `${fmtPct(d.savings.cut_pct)} input cost cut` : undefined} tone={d && d.savings.hit_rate > 0.5 ? 'ok' : undefined} />
          <Stat label="Cost" value={fmtUSD(d?.totals.cost_usd)} sub="API-equivalent" />
        </div>
      </Panel>
      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title="Tool usage" right={<span>by calls</span>}>
          {d && d.tools.length === 0 && <Empty title="No tool calls yet" />}
          <ul className="py-1">
            {(d?.tools ?? []).slice(0, 18).map((t) => (
              <li key={t.tool} className="flex items-center gap-2 px-3 py-[3px]">
                <span className="mono text-[12px] w-44 shrink-0 truncate" title={t.tool}>{fmtTool(t.tool)}</span>
                <div className="flex-1 h-2 bg-panel-2 rounded-sm overflow-hidden"><div className="h-full bg-accent/70" style={{ width: `${(100 * t.count) / maxTool}%` }} /></div>
                <span className="num text-[11px] text-fg-muted w-12 text-right">{fmtTokens(t.count)}</span>
              </li>
            ))}
          </ul>
        </Panel>
        <div className="grid gap-3 content-start">
          <Panel title="Model mix" right={<span>by cost</span>}>
            {d && d.summary.models.length === 0 && <Empty title="No priced turns" />}
            <table className="w-full text-[12px]">
              <tbody>
                {(d?.summary.models ?? []).map((m) => (
                  <tr key={m.model} className="border-b border-border/60 last:border-0">
                    <td className="px-3 py-1 mono">{m.model || 'unknown'}</td>
                    <td className="px-3 py-1 num text-right text-fg-muted">{fmtTokens(m.tokens)}</td>
                    <td className="px-3 py-1 num text-right">{fmtUSD(m.cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
          <Panel title="Top projects" right={<span>by cost</span>}>
            <table className="w-full text-[12px]">
              <tbody>
                {(d?.summary.projects ?? []).slice(0, 8).map((p) => (
                  <tr key={p.project} className="border-b border-border/60 last:border-0">
                    <td className="px-3 py-1">{p.project || 'unknown'}</td>
                    <td className="px-3 py-1 num text-right text-fg-muted">{fmtTokens(p.tokens)}</td>
                    <td className="px-3 py-1 num text-right">{fmtUSD(p.cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </div>
      </div>
      <Panel
        title="Daily cost"
        right={<BarReadout bars={days} active={activeDay} total={days.reduce((a, x) => a + x.cost, 0)} />}
      >
        {days.length === 0 && <Empty title="No history yet" />}
        {days.length > 0 && (
          <BarChart bars={days} active={activeDay} onActive={setActiveDay} height={96} showDayLabels={false} />
        )}
      </Panel>
    </div>
  )
}
