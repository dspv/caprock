/**
 * Lifetime: everything ever run through Caprock, in the site's reading style.
 *
 * Money first and largest, then what it was per active day and per session
 * (both exact divisions of two measured totals), then the cache, then the
 * counts. Top projects lead the breakdowns, as a donut beside the exact
 * table. Tool usage and the model mix are donuts with the tail grouped as
 * "other", or tables, by a Charts | Numbers switch remembered per browser.
 */
import { useState, type ReactNode } from 'react'
import { api, isPairedDevice, type History } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { fmtDuration, fmtPct, fmtTokens, fmtUSD, fmtUSDk, fmtUSDShort, fmtTool } from '@/lib/format'
import { Empty, Panel, Skeleton, Stat } from '@/components/ui'
import { groupDays } from './Cost'
import { BarChart, BarReadout } from '@/components/BarChart'
import { costBasis, costBasisLong, costLabel } from '@/components/CostBasis'
import { usePlan } from '@/components/PlanPicker'
import { PremiumBanner } from '@/components/PremiumBanner'
import { TeamsBanner } from '@/components/TeamsBanner'
import { Locked } from '@/components/Locked'
import { WeeklyReport } from '@/components/WeeklyReport'
import { UnpricedNote } from '@/components/Unpriced'
import { Donut, ShareBar, sharePct, sliceColors, topN, type Segment } from '@/components/Donut'
import { cacheLevel } from '@/lib/cachelevel'
import { ToolDrill } from '@/components/ToolDrill'

type Range = 'today' | '7d' | '30d' | 'all'
type View = 'charts' | 'numbers'

const VIEW_KEY = 'caprock-lifetime-view'

function savedView(): View {
  try { return localStorage.getItem(VIEW_KEY) === 'numbers' ? 'numbers' : 'charts' } catch { return 'charts' }
}

export interface LifetimeFigures {
  cost: number
  /** Cost ÷ active days and cost ÷ sessions: both exact, both absent at zero. */
  perDay?: number
  perSession?: number
  projects: Segment[]
  projectTotal: number
  models: Segment[]
  modelTotal: number
  tools: Segment[]
  toolTotal: number
}

/**
 * What the screen draws, from one history response. Pure, so it is tested.
 *
 * Both derived figures divide two measured totals of the same range and say
 * so: cost per active day is cost over the days that had any activity, cost
 * per session is cost over the sessions. Neither is a forecast.
 */
export function lifetimeFigures(d: History | undefined): LifetimeFigures {
  const t = d?.totals
  const cost = t?.cost_usd ?? 0
  const projectsAll = (d?.summary.projects ?? []).filter((p) => p.cost_usd > 0)
  const projects = topN(projectsAll.map((p) => ({ key: p.project || 'unknown', label: p.project || 'unknown', value: p.cost_usd, display: fmtUSD(p.cost_usd) })), 5, fmtUSD)
  const models = topN((d?.summary.models ?? []).filter((m) => m.cost_usd > 0)
    .map((m) => ({ key: m.model || 'unknown', label: m.model || 'unknown', value: m.cost_usd, display: fmtUSD(m.cost_usd) })), 5, fmtUSD)
  const calls = (v: number) => v.toLocaleString('en-US')
  const tools = topN((d?.tools ?? []).map((x) => ({ key: x.tool, label: fmtTool(x.tool), value: x.count, display: calls(x.count) })), 6, calls)
  const sum = (xs: Segment[]) => xs.reduce((a, s) => a + s.value, 0)
  return {
    cost,
    perDay: t && t.days > 0 && cost > 0 ? cost / t.days : undefined,
    perSession: t && t.sessions > 0 && cost > 0 ? cost / t.sessions : undefined,
    projects, projectTotal: sum(projects),
    models, modelTotal: sum(models),
    tools, toolTotal: sum(tools),
  }
}

/**
 * A big figure in the site's reading style: the number large and bold, its
 * label above at caption size, a line under it saying what it is. The money
 * is the hero; the rest step down one size.
 */
const DAILY_SPANS = ['30d', '90d', '180d', 'all'] as const
type DailySpan = (typeof DAILY_SPANS)[number]
const DAILY_SPAN_KEY = 'caprock-daily-span'
const DAILY_TALL_KEY = 'caprock-daily-tall'

/** A per-viewer choice kept in localStorage; the default when storage is out of reach. */
function useStored<T>(key: string, fallback: T, ok: (x: unknown) => x is T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try { const x: unknown = JSON.parse(localStorage.getItem(key) ?? 'null'); return ok(x) ? x : fallback } catch { return fallback }
  })
  return [v, (next: T) => { setV(next); try { localStorage.setItem(key, JSON.stringify(next)) } catch { /* private window */ } }]
}

function Big({ label, value, sub, hero, tone }: { label: string; value: ReactNode; sub?: ReactNode; hero?: boolean; tone?: string }) {
  return (
    <div className="flex h-full min-w-0 flex-col px-4 py-3.5">
      <div className="text-[10.5px] uppercase tracking-[0.12em] text-fg-faint">{label}</div>
      <div className={`num font-bold tracking-[-0.025em] leading-[1.02] mt-1 ${hero ? 'text-[clamp(2.5rem,6vw,3.75rem)]' : 'text-[clamp(1.9rem,4vw,2.6rem)]'} ${tone ?? 'text-fg'}`}>
        {value}
      </div>
      {sub && <div className="mt-auto pt-1.5 text-[12.5px] text-fg-muted">{sub}</div>}
    </div>
  )
}

export function HistoryScreen() {
  const [range, setRange] = useState<Range>('all')
  const [activeDay, setActiveDay] = useState<string | null>(null)
  const [view, setViewState] = useState<View>(savedView)
  // The tool row opened in place, if any.
  const [drill, setDrill] = useState<string | null>(null)
  const h = useApi(() => api.history(range), [range], { intervalMs: 15000, cache: `history:${range}` })
  const [plan] = usePlan()
  const d = h.data
  // "Measured, not estimated" sat above an all-zero board on a fresh install.
  const measured = !!d && d.totals.turns > 0
  const days = groupDays(d?.daily ?? [])
  const [dailySpan, setDailySpan] = useStored<DailySpan>(DAILY_SPAN_KEY, 'all', (x): x is DailySpan => (DAILY_SPANS as readonly string[]).includes(x as string))
  const [dailyTall, setDailyTall] = useStored<boolean>(DAILY_TALL_KEY, false, (x): x is boolean => typeof x === 'boolean')
  // Calendar days back from today, not the last N rows: days with no spend
  // have no row.
  const since = dailySpan === 'all' ? '' : new Date(Date.now() - Number(dailySpan.replace('d', '')) * 86_400_000).toISOString().slice(0, 10)
  const shownDays = since ? days.filter((x) => x.day >= since) : days
  const f = lifetimeFigures(d)
  const projectColors = sliceColors(f.projects)
  const modelColors = sliceColors(f.models)
  const setView = (v: View) => {
    setViewState(v)
    try { localStorage.setItem(VIEW_KEY, v) } catch { /* a remembered view is a convenience */ }
  }
  const maxTool = Math.max(...(d?.tools ?? []).map((t) => t.count), 1)
  const hit = measured && d ? d.savings.hit_rate * 100 : undefined
  const level = cacheLevel(hit)

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-1">
        {(['today', '7d', '30d', 'all'] as Range[]).map((r) => (
          <button key={r} onClick={() => setRange(r)} aria-pressed={range === r} className={`px-2 py-1 text-[12px] rounded-sm ${range === r ? 'bg-panel-2 text-fg' : 'text-fg-muted hover:text-fg'}`}>{r}</button>
        ))}
        {/* Charts or exact numbers, each drawn: the owner missed this switch
          * at 11px (2026-10-11), so it is the size of the range buttons. */}
        <span className="ml-auto inline-flex items-center gap-0.5 rounded-md border border-border bg-panel-2 p-0.5" role="group" aria-label="View">
          {(['charts', 'numbers'] as const).map((v) => (
            <button key={v} type="button" onClick={() => setView(v)} aria-pressed={view === v}
              className={`px-3 py-1 rounded-[5px] text-[13px] capitalize ${view === v ? 'bg-accent text-panel font-medium' : 'text-fg-muted hover:text-fg'}`}>
              {v}
            </button>
          ))}
        </span>
      </div>

      {/* Below the range row, above the figures: this screen is where someone
        * came to think about what all of this has cost, which is the one
        * moment a paid spend control is a relevant thing to mention. */}
      {measured && d && (
        <PremiumBanner costUSD={d.totals.cost_usd} days={d.totals.days} now={Date.now()} />
      )}
      {/* The team card, when a second person commits to the same code; the
        * Premium banner above and this one share the single offer slot. */}
      {measured && d && (
        <TeamsBanner fact={{ costUSD: d.totals.cost_usd, projects: d.summary?.projects?.filter((p) => p.cost_usd > 0).length ?? 0, window: 'all time' }} now={Date.now()} />
      )}
      {h.error && !d && <Empty title="Cannot reach the daemon">{h.error.message}</Empty>}

      {/* Money first and largest, on the left: it is what this screen is
        * opened for. Then the two figures that say what it means per unit of
        * work, then the cache, then the counts at reading size below. */}
      <Panel fold="lifetime.totals" title={`Lifetime · ${range}`} right={<span>everything you ran through Caprock · measured, not estimated</span>}>
        <div className="grid sm:grid-cols-2 lg:grid-cols-[1.5fr_1fr_1fr_1fr] divide-y sm:divide-y-0 sm:divide-x divide-border">
          <Big hero label={costLabel(plan)} tone="text-accent" value={measured ? <span title={fmtUSD(f.cost)}>{fmtUSDShort(f.cost)}</span> : '—'}
            sub={<span title={costBasisLong(plan)}>{measured ? costBasis(plan) : 'nothing measured yet'}</span>} />
          <Big label="A day" value={f.perDay !== undefined ? <span title={fmtUSD(f.perDay)}>{fmtUSDShort(f.perDay)}</span> : '—'}
            sub={measured && d ? <span title="cost ÷ days with any activity">over {d.totals.days.toLocaleString('en-US')} active {d.totals.days === 1 ? 'day' : 'days'}</span> : undefined} />
          <Big label="A session" value={f.perSession !== undefined ? <span title={fmtUSD(f.perSession)}>{fmtUSDShort(f.perSession)}</span> : '—'}
            sub={measured && d ? <span title="cost ÷ sessions">over {d.totals.sessions.toLocaleString('en-US')} {d.totals.sessions === 1 ? 'session' : 'sessions'}</span> : undefined} />
          {/* A never-used cache is 0%, which tripped the < 90% warn tone and
            * painted a fault light onto an empty install. */}
          <Big label="Cache hit" value={<span className="inline-flex items-baseline gap-2">{hit === undefined ? '—' : fmtPct(hit)}
            {level && <span className={`text-[13px] font-medium tracking-normal ${level.color || 'text-fg-faint'}`}>{level.label}</span>}</span>}
            sub={measured && d ? `${fmtPct(d.savings.cut_pct)} input cost cut` : undefined} />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 divide-x divide-border border-t border-border">
          <Stat size="compact" label="Sessions" value={measured ? d!.totals.sessions.toLocaleString('en-US') : '—'} sub={measured ? `${d!.totals.owned_sessions} spawned by caprock` : undefined} />
          <Stat size="compact" label="Active days" value={measured ? d!.totals.days : '—'} />
          <Stat size="compact" label="Turns" value={measured ? fmtTokens(d!.totals.turns) : '—'} sub={measured ? `${fmtTokens(d!.totals.tool_calls)} tool calls` : undefined} />
          {/* Summed per session, so a file edited in three sessions counts three
              times. "Files touched" alone reads as a count of distinct files. */}
          <Stat size="compact" label="Files touched" value={measured ? fmtTokens(d!.totals.files_touched) : '—'} sub="summed per session" />
          {/* First event to last, so a session left open overnight counts its
            * sleeping hours — hence the honest label. */}
          <Stat size="compact" label="Avg session span" value={measured ? fmtDuration(Math.round(d!.totals.avg_session_sec * 1000)) : '—'} sub="first to last event" />
        </div>
        <UnpricedNote u={d?.totals.unpriced} background={d?.totals.background} className="mx-3 mb-2.5" />
      </Panel>

      {/* Right under the totals, low: the owner's favourite reading of the
        * whole history, "clear, beautiful, real activity" (2026-10-11,
        * translated), was at the bottom of the page. */}
      {/* Its own period and height, both kept (owner, 2026-10-11: "change the
        * period here easily", "a toggle that doubles the chart's height"). The
        * period cuts what the screen's range loaded; it never asks again. */}
      <Panel
        fold="lifetime.daily"
        title="Daily cost"
        right={
          <span className="flex items-center gap-3">
            <span role="group" aria-label="Daily cost period" className="flex items-center gap-0.5">
              {DAILY_SPANS.map((sp) => (
                <button key={sp} type="button" aria-pressed={dailySpan === sp} onClick={() => setDailySpan(sp)}
                  className={`rounded-[5px] px-1.5 py-0.5 text-[11.5px] ${dailySpan === sp ? 'bg-panel-2 text-fg' : 'text-fg-faint hover:text-fg'}`}>
                  {sp}
                </button>
              ))}
            </span>
            <button type="button" aria-pressed={dailyTall} onClick={() => setDailyTall(!dailyTall)} title={dailyTall ? 'Normal height' : 'Twice as tall'}
              className={`rounded-[5px] px-1.5 py-0.5 text-[11.5px] ${dailyTall ? 'bg-panel-2 text-fg' : 'text-fg-faint hover:text-fg'}`}>
              ×2
            </button>
            <BarReadout bars={shownDays} active={activeDay} total={shownDays.reduce((a, x) => a + x.cost, 0)} fmtTotal={fmtUSDk} />
          </span>
        }
      >
        {!h.data ? <Skeleton rows={2} /> : shownDays.length === 0 && <Empty title="No history yet" />}
        {shownDays.length > 0 && (
          <BarChart bars={shownDays} active={activeDay} onActive={setActiveDay} height={dailyTall ? 144 : 72} showDayLabels={false} axis />
        )}
      </Panel>

      {/* Top projects lead: "which repository did this go into" is the first
        * question after "how much". The donut gives the shape; the table
        * beside it the exact figures, every row with its share. */}
      <Panel fold="lifetime.projects" title="Top projects" right={<span>by cost</span>}>
        {!d ? <Skeleton rows={4} /> : f.projects.length === 0 ? <Empty title="No priced work in a project yet" /> : (
          <div className="grid gap-x-8 gap-y-4 px-3 py-3 md:grid-cols-[auto_1fr] items-center">
            <Donut title="" segments={f.projects} size={168} legend={false}
              center={sharePct(f.projects[0]!.value, f.projectTotal)} centerLabel={f.projects[0]!.label}
              ariaLabel={`Cost by project: ${f.projects.map((s) => `${s.label} ${s.display}, ${sharePct(s.value, f.projectTotal)}`).join('; ')}`} />
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-[10px] uppercase tracking-[0.08em] text-fg-faint">
                    <th className="px-2 pb-1 text-left font-normal" colSpan={2}>share · project</th>
                    <th className="px-2 pb-1 text-right font-normal">tokens</th>
                    <th className="px-2 pb-1 text-right font-normal">cost</th>
                  </tr>
                </thead>
                <tbody>
                  {(d.summary.projects ?? []).filter((p) => p.cost_usd > 0).slice(0, 8).map((p) => (
                    <tr key={p.project} className="border-b border-border/60 last:border-0">
                      {/* The donut's colour and the share, large, first: the eye
                        * matches a row to its arc without crossing the table
                        * (owner, 2026-10-11). */}
                      <td className="w-[1%] whitespace-nowrap px-2 py-1.5" data-share>
                        <span className="inline-flex items-center gap-2">
                          <span aria-hidden className="h-3 w-3 shrink-0 rounded-[3px]" style={{ background: projectColors.get(p.project || 'unknown') ?? 'var(--color-fg-faint)' }} />
                          <span className="num w-[3.2ch] text-right text-[17px] font-semibold text-fg">{sharePct(p.cost_usd, f.cost || f.projectTotal)}</span>
                        </span>
                      </td>
                      <td className="px-2 py-1.5 font-medium truncate max-w-[16rem]">{p.project || 'unknown'}</td>
                      <td className="px-2 py-1.5 num text-right text-fg-muted">{fmtTokens(p.tokens)}</td>
                      <td className="px-2 py-1.5 num text-right">{fmtUSD(p.cost_usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Panel>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel fold="lifetime.tools" title="Tool usage" right={<span className="text-[10px] uppercase tracking-[0.08em]">calls · open a row for detail</span>}>
          {!d ? <Skeleton rows={5} /> : d.tools.length === 0 && <Empty title="No tool calls yet" />}
          {d && d.tools.length > 0 && view === 'charts' && (
            <div className="px-3 py-3">
              <Donut title="" segments={f.tools} size={168}
                center={sharePct(f.tools[0]!.value, f.toolTotal)} centerLabel={f.tools[0]!.label}
                ariaLabel={`Tool calls by tool: ${f.tools.map((s) => `${s.label} ${s.display}, ${sharePct(s.value, f.toolTotal)}`).join('; ')}`} />
            </div>
          )}
          {/* The full list under the chart: the donut shows the top six and
            * the rest as "other", which is exactly where a reader wants the
            * names. */}
          {d && d.tools.length > 0 && (
            <ul className={`py-1 ${view === 'charts' ? 'border-t border-border' : ''}`}>
              {d.tools.slice(0, view === 'charts' ? 8 : 18).map((t) => (
                <li key={t.tool}>
                  {/* The row opens in place into what that tool's calls were
                    * about (ToolDrill), for the range above. */}
                  <button type="button" onClick={() => setDrill(drill === t.tool ? null : t.tool)} aria-expanded={drill === t.tool}
                    className="flex w-full items-center gap-2 px-3 py-[3px] text-left hover:bg-panel-2">
                    <span aria-hidden className={`w-2 text-[10px] text-fg-faint transition-transform ${drill === t.tool ? 'rotate-90' : ''}`}>›</span>
                    <span className="mono text-[12px] w-44 shrink-0 truncate" title={t.tool}>{fmtTool(t.tool)}</span>
                    <div className="flex-1 h-2 bg-panel-2 rounded-sm overflow-hidden"><div className="h-full bg-accent/70" style={{ width: `${(100 * t.count) / maxTool}%` }} /></div>
                    <span className="num text-[11px] text-fg-muted w-12 text-right">{fmtTokens(t.count)}</span>
                  </button>
                  {drill === t.tool && <ToolDrill tool={t.tool} range={range} />}
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <div className="grid gap-3 content-start">
          <Panel fold="lifetime.models" title="Model mix" right={<span>by cost</span>}>
            {!d ? <Skeleton rows={3} /> : d.summary.models.length === 0 && <Empty title="No priced turns" />}
            {d && f.models.length > 0 && view === 'charts' && (
              <div className="px-3 py-3">
                <Donut title="" segments={f.models} size={168}
                  center={sharePct(f.models[0]!.value, f.modelTotal)} centerLabel={f.models[0]!.label}
                  ariaLabel={`Cost by model: ${f.models.map((s) => `${s.label} ${s.display}, ${sharePct(s.value, f.modelTotal)}`).join('; ')}`} />
              </div>
            )}
            {d && view === 'numbers' && (
              <div className="overflow-x-auto">
                {/* Scrolls inside itself on a narrow screen: the table is wide, and a
                * body that scrolls sideways takes every other panel with it. */}
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-[0.08em] text-fg-faint">
                      <th className="px-3 pb-1 text-left font-normal">model</th>
                      <th className="px-3 pb-1 text-right font-normal">tokens</th>
                      <th className="px-3 pb-1 text-right font-normal">cost</th>
                      <th className="px-3 pb-1 text-right font-normal">share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.summary.models.map((m) => (
                      <tr key={m.model} className="border-b border-border/60 last:border-0">
                        <td className="px-3 py-1 mono">{m.model || 'unknown'}</td>
                        <td className="px-3 py-1 num text-right text-fg-muted">{fmtTokens(m.tokens)}</td>
                        <td className="px-3 py-1 num text-right">{fmtUSD(m.cost_usd)}</td>
                        <td className="px-3 py-1 text-right text-fg-muted w-28"><ShareBar value={m.cost_usd} total={f.modelTotal} color={modelColors.get(m.model || 'unknown')} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
          {/* The weekly report belongs beside the figures it would contain: this
            * screen already answers "where did it go", and the paid half is
            * having that answer arrive without coming here to look. Its
            * preview shows the shape of the message and no figures — those
            * are free on this screen, and putting them behind glass would take
            * something away rather than preview something new. */}
          {!isPairedDevice() && <Locked feature="report" title="Get this every Monday, without opening the dashboard">
            <WeeklyReport />
          </Locked>}
        </div>
      </div>
    </div>
  )
}
