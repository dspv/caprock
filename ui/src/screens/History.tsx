import { useState } from 'react'
import { api } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { fmtDuration, fmtTokens, fmtUSD, fmtTool } from '@/lib/format'
import { CacheStat } from '@/components/CacheStat'
import { Empty, Panel, Skeleton, Stat } from '@/components/ui'
import { groupDays } from './Cost'
import { BarChart, BarReadout } from '@/components/BarChart'
import { costBasis, costBasisLong } from '@/components/CostBasis'
import { usePlan } from '@/components/PlanPicker'
import { PremiumBanner } from '@/components/PremiumBanner'
import { Locked } from '@/components/Locked'
import { UnpricedNote } from '@/components/Unpriced'

type Range = 'today' | '7d' | '30d' | 'all'

// Shown only when this machine has no week to draw on — a brand-new install
// would otherwise preview an empty report, which sells nothing. Named so it can
// never be mistaken on screen for the reader's own repositories.
const PLACEHOLDER_WEEK = ['your-api', 'your-web']

export function HistoryScreen() {
  const [range, setRange] = useState<Range>('all')
  const [activeDay, setActiveDay] = useState<string | null>(null)
  const h = useApi(() => api.history(range), [range], { intervalMs: 15000 })
  const [plan] = usePlan()
  const d = h.data
  // "Measured, not estimated" sat above an all-zero board on a fresh install.
  const measured = !!d && d.totals.turns > 0
  const days = groupDays(d?.daily ?? [])
  // The weekly report's preview shows the SHAPE of the message, using this
  // machine's own repository names — and no figures.
  //
  // Filling it with real costs was the obvious thing to do and it is exactly
  // the move `Paywall.test.tsx` forbids: those numbers are already free on
  // this screen, two panels down. Putting them behind glass would take
  // something away rather than preview something new, which turns the free
  // tier into a hostage. What is genuinely paid here is the *delivery* —
  // Monday morning, in Telegram, without opening this page — so that is what
  // the preview sells.
  const wk = useApi(() => api.summary('7d'), [], { intervalMs: 60000 })
  const weekProjects = (wk.data?.projects ?? []).slice(0, 4).map((p) => p.project)
  const maxTool = Math.max(...(d?.tools ?? []).map((t) => t.count), 1)
  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-1">
        {(['today', '7d', '30d', 'all'] as Range[]).map((r) => (
          <button key={r} onClick={() => setRange(r)} className={`px-2 py-1 text-[12px] rounded-sm ${range === r ? 'bg-panel-2 text-fg' : 'text-fg-muted hover:text-fg'}`}>{r}</button>
        ))}
        <span className="ml-auto text-[11px] text-fg-faint">Everything you ever ran through Caprock. Measured, not estimated.</span>
      </div>

      {/* Below the range row, above the figures: this screen is where someone
        * came to think about what all of this has cost, which is the one
        * moment a paid spend control is a relevant thing to mention. */}
      {measured && d && (
        <PremiumBanner costUSD={d.totals.cost_usd} days={d.totals.days} now={Date.now()} />
      )}
      {h.error && !d && <Empty title="Cannot reach the daemon">{h.error.message}</Empty>}
      <Panel title={`Lifetime · ${range}`}>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 divide-x divide-border">
          <Stat size="compact" label="Sessions" value={measured ? d!.totals.sessions : '—'} sub={measured ? `${d!.totals.owned_sessions} spawned by caprock` : undefined} />
          <Stat size="compact" label="Active days" value={measured ? d!.totals.days : '—'} />
          <Stat size="compact" label="Turns" value={measured ? fmtTokens(d!.totals.turns) : '—'} sub={measured ? `${fmtTokens(d!.totals.tool_calls)} tool calls` : undefined} />
          {/* Summed per session, so a file edited in three sessions counts three
              times. "Files touched" alone reads as a count of distinct files —
              on the author's database that is 1,502 against the 1,703 shown. */}
          <Stat size="compact" label="Files touched" value={measured ? fmtTokens(d!.totals.files_touched) : '—'} sub="summed per session" />
          {/* This is first-event-to-last-event elapsed time, so a session left open
            overnight counts its sleeping hours — hence the honest label. */}
          <Stat size="compact" label="Avg session span" value={measured ? fmtDuration(Math.round(d!.totals.avg_session_sec * 1000)) : '—'} sub="first to last event" />
          {/* A never-used cache is 0%, which tripped the < 90% warn tone and
            * painted a fault light onto an empty install. */}
          <CacheStat hitRate={d?.savings.hit_rate} cutPct={d?.savings.cut_pct} measured={measured} />
          {/* "API-equivalent" was our jargon on the largest number in the
              product; it explained nothing to someone meeting it for the
              first time, and three of five readers took it for a bill. */}
          <Stat label="Cost" value={measured ? fmtUSD(d!.totals.cost_usd) : '—'} sub={<span title={costBasisLong(plan)}>{measured ? costBasis(plan) : 'nothing measured yet'}</span>} tone="info" size="hero" />
        </div>
        {/* Not locked any more. Third-party pricing was going to be the paid
          * feature until the prices were simply added — DeepSeek, MiniMax and
          * the rest now cost out for everyone, and charging for something the
          * free version already does is how a paid tier becomes a hostage.
          * What is left here is the honest warning for a model we do not know
          * yet, which is not a feature and not for sale. */}
        <UnpricedNote u={d?.totals.unpriced} className="mx-3 mb-2.5" />
      </Panel>
      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title="Tool usage" right={<span>by calls</span>}>
          {!d ? <Skeleton rows={5} /> : d.tools.length === 0 && <Empty title="No tool calls yet" />}
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
          {/* Locked around the note, not the panel: the model mix itself is
            * free and stays free — Caprock sees every provider. What is paid is
            * being able to PRICE the ones it cannot, which is exactly what this
            * note is complaining about. */}
          <Panel title="Model mix" right={<span>by cost</span>}>
            {!d ? <Skeleton rows={3} /> : d.summary.models.length === 0 && <Empty title="No priced turns" />}
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
          {/* The weekly report belongs beside the figures it would contain: this
          * screen already answers "where did it go", and the paid half is
          * having that answer arrive without coming here to look. */}
        <Locked feature="report" title="Get this every Monday, without opening the dashboard">
          {/* The preview is the report itself, filled with this machine's own
            * figures — not a list of its properties.
            *
            * It used to be three rows reading "Sent: Mondays 09:00 / To: your
            * Telegram bot / Contains: the week by repository and model", which
            * describes an email without showing one. Behind glass that is a
            * blurred settings screen, and nobody buys a settings screen. What
            * sells this is seeing the message that would have arrived, with
            * real repository names and real dollars in it. */}
          <Panel title="Weekly report" right={<span>Mondays, 09:00</span>}>
            <div className="px-3 py-3 text-[13px]">
              <p className="text-fg-muted">
                <span className="text-fg-faint">To:</span> your Telegram bot or webhook
              </p>
              <p className="mt-2 text-fg">Last week, by repository:</p>
              <div className="mt-1.5 grid gap-1">
                {(weekProjects.length ? weekProjects : PLACEHOLDER_WEEK).map((name) => (
                  <div key={name} className="flex items-baseline justify-between gap-3">
                    <span className="truncate text-fg-muted">{name || 'unknown'}</span>
                    {/* Deliberately not a figure — see the note above the
                      * data. The bar is a shape, not a number. */}
                    <span aria-hidden className="h-1.5 w-24 shrink-0 rounded-full bg-fg-faint/25" />
                  </div>
                ))}
              </div>
              <p className="mt-2.5 border-t border-border pt-2 text-[12px] text-fg-faint">
                …and the same by model, in your inbox before you open a terminal.
              </p>
            </div>
          </Panel>
        </Locked>

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
        {!h.data ? <Skeleton rows={2} /> : days.length === 0 && <Empty title="No history yet" />}
        {days.length > 0 && (
          <BarChart bars={days} active={activeDay} onActive={setActiveDay} height={96} showDayLabels={false} />
        )}
      </Panel>
    </div>
  )
}
