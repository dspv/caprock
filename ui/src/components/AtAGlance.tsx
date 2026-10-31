/**
 * AT A GLANCE: the all-time figures as pictures you read across the room.
 *
 * The ALL TIME panel above it has the exact tables; this is the same money,
 * models and tools as three donuts with the share printed big in the middle,
 * and the agents drawn as the characters from the Week card. A **Numbers**
 * view shows the same figures as a compact table, which is also the text
 * alternative to the charts.
 *
 * Same period as ALL TIME (everything) and, like it, every agent: the agent
 * switch on Today governs Today. Collapsed or open, and charts or numbers, are
 * remembered in this browser.
 *
 * It shares like the other figure panels (.ai/04-ui.md § Share, "Any
 * panel"): the picture leaves out the fold chevron, the Charts/Numbers
 * switch and the agents' fold toggle; the text is the Numbers view's tables.
 * It names models, tools and agents, never a project, so Hide project names
 * has nothing to replace.
 */
import { useState } from 'react'
import { api, type Glance, type GlanceWindow, type History, type WeekAgent } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { fmtTool, fmtUSD } from '@/lib/format'
import { Panel } from '@/components/ui'
import { ShareWith } from '@/components/PanelShare'
import { mdTable } from '@/lib/panelShare'
import { SLOW_LIVE_MS, useOnScreen } from '@/lib/refresh'
import { AgentCharacter, agentName, characterFor, type Character } from '@/components/Characters'
import { colorOf, Donut, pointPct, Ring, sharePct, topN, TrendMark, trendDelta, type Segment, type TrendCell } from '@/components/Donut'

const OPEN_KEY = 'caprock-glance-open'
const VIEW_KEY = 'caprock-glance-view'
/** The agents row folded to one line of characters with their shares. */
const AGENTS_KEY = 'caprock-glance-agents'

function read(key: string, fallback: string): string {
  try { return localStorage.getItem(key) ?? fallback } catch { return fallback }
}
function write(key: string, v: string) {
  try { localStorage.setItem(key, v) } catch { /* a remembered layout is a convenience */ }
}

export interface AgentRow { key: string; who: Character; name: string; turns: number; cost: number }

/**
 * One row per agent, with each agent's own sub-agents folded in — except
 * Claude Code's subagents, which are numerous enough to be their own row (the
 * same split as the Week card).
 */
export function agentRows(agents: WeekAgent[]): AgentRow[] {
  const by = new Map<string, AgentRow>()
  for (const a of agents) {
    const sub = a.agent === 'claude' && a.subagent
    const key = sub ? 'claude-sub' : a.agent
    const cur = by.get(key)
    if (cur) { cur.turns += a.turns; cur.cost += a.cost_usd; continue }
    by.set(key, {
      key,
      who: characterFor(a.agent, sub),
      name: sub ? (a.threads ? `${a.threads.toLocaleString('en-US')} subagents` : 'Subagents') : agentName(a.agent),
      turns: a.turns,
      cost: a.cost_usd,
    })
  }
  const order = ['claude', 'claude-sub', 'codex', 'opencode', 'gemini', 'deepseek', 'hermes']
  const rank = (k: string) => (order.indexOf(k) < 0 ? 99 : order.indexOf(k))
  return [...by.values()].filter((r) => r.turns > 0).sort((a, b) => rank(a.key) - rank(b.key))
}

export interface GlanceCharts {
  models: Segment[]
  bill: Segment[]
  tools: Segment[]
  modelTotal: number
  billTotal: number
  toolTotal: number
}

/** The three donuts' segments, from history and glance. Pure, so it is tested. */
export function glanceCharts(h: History | undefined, g: Glance | undefined): GlanceCharts {
  const display = (id: string) => (g?.display[id] ?? id).replace(/^Claude /, '') || 'unknown'
  const models = topN(
    (h?.summary?.models ?? []).map((m) => ({ key: m.model, label: display(m.model), value: m.cost_usd, display: fmtUSD(m.cost_usd) })),
    4, fmtUSD,
  )
  const b = g?.bill
  const bill: Segment[] = b
    ? [
        // Short labels, the names the rest of the app uses: they never fit
        // truncated into a third of a 14-inch screen (owner, 2026-10-12).
        { key: 'cache_read', label: 'cache read', detail: 're-reading context', value: b.cache_read_usd, display: fmtUSD(b.cache_read_usd) },
        { key: 'cache_write', label: 'cache write', value: b.cache_write_usd, display: fmtUSD(b.cache_write_usd) },
        { key: 'output', label: 'output', value: b.output_usd, display: fmtUSD(b.output_usd) },
        { key: 'input', label: 'input', detail: 'uncached', value: b.input_usd, display: fmtUSD(b.input_usd) },
      ].filter((s) => s.value > 0)
    : []
  const fmtCalls = (v: number) => v.toLocaleString('en-US')
  const tools = topN((h?.tools ?? []).map((t) => ({ key: t.tool, label: fmtTool(t.tool), value: t.count, display: fmtCalls(t.count) })), 5, fmtCalls)
  const sum = (xs: Segment[]) => xs.reduce((a, s) => a + s.value, 0)
  return { models, bill, tools, modelTotal: sum(models), billTotal: sum(bill), toolTotal: sum(tools) }
}

/**
 * Each segment's share in the trend's two windows, keyed like the segments,
 * so a legend row can say how its share moved (owner, 2026-10-17, translated:
 * "I only need the rough dynamics, no graphs"). "other" is everything the
 * named rows are not, in each window. Undefined when either window holds
 * nothing: a share of nothing is no trend.
 */
export function segmentTrends(segs: Segment[], prior: Record<string, number>, recent: Record<string, number>, what: string, days: number): Map<string, TrendCell> | undefined {
  const sum = (m: Record<string, number>) => Object.values(m).reduce((a, v) => a + (v > 0 ? v : 0), 0)
  const pt = sum(prior)
  const rt = sum(recent)
  if (pt <= 0 || rt <= 0 || segs.length === 0) return undefined
  const named = segs.filter((s) => s.key !== '__other').map((s) => s.key)
  const valueOf = (m: Record<string, number>, total: number, key: string) =>
    key === '__other' ? Math.max(0, total - named.reduce((a, k) => a + (m[k] ?? 0), 0)) : (m[key] ?? 0)
  const out = new Map<string, TrendCell>()
  for (const s of segs) {
    const r = (100 * valueOf(recent, rt, s.key)) / rt
    const p = (100 * valueOf(prior, pt, s.key)) / pt
    out.set(s.key, { recent: r, prior: p, title: `${s.label}: ${pointPct(r)} of ${what} in the last ${days} days, ${pointPct(p)} in the ${days} days before` })
  }
  return out
}

/** The shift worth a sentence: five points or more. */
const STORY_POINTS = 5

/**
 * The one sentence under Where the money went, only when the data says it:
 * the model whose share of spend rose most, by at least five points, and the
 * one that fell most, by as much. Measured shares, no projection.
 */
export function moneyStory(segs: Segment[], trends: Map<string, TrendCell> | undefined, days: number): string | undefined {
  if (!trends) return undefined
  const rows = segs.flatMap((s) => {
    const t = s.key === '__other' ? undefined : trends.get(s.key)
    return t ? [{ s, t }] : []
  })
  const up = rows.filter((x) => trendDelta(x.t) >= STORY_POINTS).sort((a, b) => trendDelta(b.t) - trendDelta(a.t))[0]
  const down = rows.filter((x) => trendDelta(x.t) <= -STORY_POINTS).sort((a, b) => trendDelta(a.t) - trendDelta(b.t))[0]
  if (up) {
    const head = `${up.s.label} is gaining: ${pointPct(up.t.recent)} of the last ${days} days' spend vs ${pointPct(up.t.prior)} the ${days} before`
    return down ? `${head}; ${down.s.label} fell to ${pointPct(down.t.recent)} from ${pointPct(down.t.prior)}.` : `${head}.`
  }
  if (down) return `${down.s.label} is falling: ${pointPct(down.t.recent)} of the last ${days} days' spend vs ${pointPct(down.t.prior)} the ${days} before.`
  return undefined
}

export interface GlanceTrends {
  days: number
  models?: Map<string, TrendCell>
  bill?: Map<string, TrendCell>
  tools?: Map<string, TrendCell>
  agents?: Map<string, TrendCell>
  story?: string
}

/** The block's trend markers, from the glance's two windows. Pure, so it is tested. */
export function glanceTrends(c: GlanceCharts, rows: AgentRow[], g: Glance | undefined): GlanceTrends | undefined {
  const t = g?.trend
  if (!t) return undefined
  const bill = (w: GlanceWindow): Record<string, number> => (w.bill
    ? { cache_read: w.bill.cache_read_usd, cache_write: w.bill.cache_write_usd, output: w.bill.output_usd, input: w.bill.input_usd }
    : {})
  const agents = (w: GlanceWindow) => Object.fromEntries(agentRows(w.agents ?? []).map((r) => [r.key, r.cost]))
  const agentSegs: Segment[] = rows.map((r) => ({ key: r.key, label: r.name, value: r.cost, display: '' }))
  const models = segmentTrends(c.models, t.prior.models ?? {}, t.recent.models ?? {}, 'spend', t.days)
  return {
    days: t.days,
    models,
    bill: segmentTrends(c.bill, bill(t.prior), bill(t.recent), 'the bill', t.days),
    tools: segmentTrends(c.tools, t.prior.tools ?? {}, t.recent.tools ?? {}, 'tool calls', t.days),
    agents: segmentTrends(agentSegs, agents(t.prior), agents(t.recent), 'spend across every agent', t.days),
    story: moneyStory(c.models, models, t.days),
  }
}

/** The panel as Markdown, the Numbers view's tables: what Copy as text puts on the clipboard. */
export function glanceText(c: GlanceCharts, rows: AgentRow[]): string {
  const table = (title: string, head: string[], segs: Segment[], total: number) =>
    `${title}\n\n${mdTable([...head, 'Share'], segs.map((s) => [s.label, s.display, sharePct(s.value, total)]))}`
  const parts = [table('Where the money went', ['Model', 'Cost'], c.models, c.modelTotal)]
  if (c.bill.length > 0) parts.push(table('The bill by token type', ['Type', 'Cost'], c.bill, c.billTotal))
  parts.push(table('Most-used tools', ['Tool', 'Calls'], c.tools, c.toolTotal))
  if (rows.length > 0) {
    const total = rows.reduce((a, r) => a + r.cost, 0)
    parts.push(`Agents\n\n${mdTable(['Agent', 'Turns', 'Cost', 'Share'], rows.map((r) => [r.name, r.turns.toLocaleString('en-US'), fmtUSD(r.cost), sharePct(r.cost, total)]))}`)
  }
  return `All time, every agent.\n\n${parts.join('\n\n')}`
}

export function AtAGlancePanel() {
  const [open, setOpen] = useState(() => read(OPEN_KEY, '1') !== '0')
  const [view, setView] = useState<'charts' | 'numbers'>(() => (read(VIEW_KEY, 'charts') === 'numbers' ? 'numbers' : 'charts'))
  const [agentsSmall, setAgentsSmall] = useState(() => read(AGENTS_KEY, 'cards') === 'icons')
  // Folded or scrolled away it asks nothing (lib/refresh.ts); the history
  // is the same question the strip and All time ask, so it shares theirs.
  const [seen, onScreen] = useOnScreen()
  const active = open && onScreen
  const h = useApi(() => api.history('all'), [], { intervalMs: 60000, share: 'history:all', liveMs: SLOW_LIVE_MS, active })
  const g = useApi(() => api.glance(), [], { intervalMs: 60000, share: 'glance', liveMs: SLOW_LIVE_MS, active })
  const c = glanceCharts(h.data, g.data)
  const rows = agentRows(g.data?.agents ?? [])
  const agentTotal = rows.reduce((a, r) => a + r.cost, 0)
  const tr = glanceTrends(c, rows, g.data)
  if (c.models.length === 0 && c.tools.length === 0) return null

  const toggle = () => { const v = !open; setOpen(v); write(OPEN_KEY, v ? '1' : '0') }
  const pick = (v: 'charts' | 'numbers') => { setView(v); write(VIEW_KEY, v) }
  const foldAgents = () => { const v = !agentsSmall; setAgentsSmall(v); write(AGENTS_KEY, v ? 'icons' : 'cards') }
  const lead = (segs: Segment[], total: number) => (segs[0] ? sharePct(segs[0].value, total) : '—')
  const readRe = c.bill.find((s) => s.key === 'cache_read')

  return (
    <Panel
      sectionRef={seen}
      // Folded, it has nothing to share: the button goes with the body.
      share={open ? 'At a glance' : undefined}
      title={
        <button type="button" onClick={toggle} aria-expanded={open} className="inline-flex items-center gap-1.5 uppercase tracking-[0.12em] hover:text-fg">
          <span aria-hidden data-share-skip className={`inline-block transition-transform ${open ? 'rotate-90' : ''}`}>›</span>
          At a glance
        </button>
      }
      right={
        open ? (
          <span className="inline-flex items-center gap-0.5 rounded-md bg-panel-2 p-0.5" role="group" aria-label="View" data-share-skip>
            {(['charts', 'numbers'] as const).map((v) => (
              <button key={v} type="button" onClick={() => pick(v)} aria-pressed={view === v}
                className={`px-2 py-0.5 rounded-[5px] text-[11px] capitalize ${view === v ? 'bg-accent text-panel font-medium' : 'text-fg-muted hover:text-fg'}`}>
                {v}
              </button>
            ))}
          </span>
        ) : <span className="text-fg-faint">all time · every agent</span>
      }
    >
      {open && <ShareWith toText={() => glanceText(c, rows)} />}
      {open && view === 'charts' && (
        <>
          {/* Three across only when the panel itself has room for three
            * donuts with their legends under them; a narrower panel (the app
            * with the sidebar and inspector open) stacks them, each with the
            * legend beside it. The panel's width decides, not the window's. */}
          <div className="@container">
          <div className="grid gap-x-8 gap-y-5 px-3 py-3 @[720px]:grid-cols-3">
            <Donut title="Where the money went" segments={c.models} center={lead(c.models, c.modelTotal)} centerLabel={c.models[0]?.label ?? ''}
              trends={tr?.models} note={tr?.story}
              ariaLabel={`Cost by model:${c.models.map((s) => `${s.label} ${s.display}, ${sharePct(s.value, c.modelTotal)}`).join('; ')}`} />
            {c.bill.length > 0 && (
              <Donut title="The bill by token type" segments={c.bill} center={readRe ? sharePct(readRe.value, c.billTotal) : '—'} centerLabel="re-reading context" trends={tr?.bill}
                ariaLabel={`Cost by token type at current list prices: ${c.bill.map((s) => `${s.label} ${s.display}, ${sharePct(s.value, c.billTotal)}`).join('; ')}`} />
            )}
            <Donut title="Most-used tools" segments={c.tools} center={lead(c.tools, c.toolTotal)} centerLabel={c.tools[0]?.label ?? ''} trends={tr?.tools}
              ariaLabel={`Tool calls by tool: ${c.tools.map((s) => `${s.label} ${s.display}, ${sharePct(s.value, c.toolTotal)}`).join('; ')}`} />
          </div>
          </div>
          {rows.length > 0 && agentsSmall && (
            // Folded: each agent as its character and its share, one line
            // (owner, 2026-10-11, translated: "fold blocks like DeepSeek's
            // into an icon").
            // Twice the size since the same day, and fluid: one line that
            // shrinks the characters with the window down to a floor, then
            // wraps. The hint is a card, not the native tooltip, which the
            // owner found poor and unclear.
            <div className="flex flex-wrap items-center gap-x-[clamp(12px,2vw,28px)] gap-y-2 border-t border-border px-3 py-3" data-agents-folded>
              {rows.map((r) => {
                const share = sharePct(r.cost, agentTotal)
                return (
                  <span key={r.key} tabIndex={0} aria-label={`${r.name}: ${share} of all-time spend, ${fmtUSD(r.cost)}, ${r.turns.toLocaleString('en-US')} turns`}
                    className="group relative inline-flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 outline-none focus-visible:ring-2 focus-visible:ring-accent">
                    <AgentCharacter who={r.who} size={52} className="h-auto w-[clamp(32px,4vw,52px)]" />
                    <span className="num text-[clamp(13px,1.3vw,17px)] font-medium text-fg">{share}</span>
                    {tr?.agents?.get(r.key) && <TrendMark cell={tr.agents.get(r.key)!} className="-ml-1 text-[11px]" />}
                    <span role="tooltip" data-agent-hint
                      className="pointer-events-none invisible absolute bottom-full left-0 z-20 mb-2 w-max max-w-[280px] rounded-xl border border-border-strong bg-panel px-3.5 py-2.5 opacity-0 shadow-lg transition-opacity duration-100 group-hover:visible group-hover:opacity-100 group-focus-visible:visible group-focus-visible:opacity-100">
                      <span className="block text-[14px] font-semibold text-fg">{r.name}</span>
                      <span className="mt-1 flex items-baseline gap-1.5"><span className="num text-[22px] font-semibold text-accent">{share}</span><span className="text-[12px] text-fg-muted">of all the spend, all time</span></span>
                      <span className="mt-1.5 grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 text-[12.5px]">
                        <span className="text-fg-muted">spent</span><span className="num text-right text-fg">{fmtUSD(r.cost)}</span>
                        <span className="text-fg-muted">turns</span><span className="num text-right text-fg">{r.turns.toLocaleString('en-US')}</span>
                        <span className="text-fg-muted">per turn</span><span className="num text-right text-fg">{r.turns > 0 ? fmtUSD(r.cost / r.turns) : '—'}</span>
                      </span>
                    </span>
                  </span>
                )
              })}
              <button type="button" onClick={foldAgents} data-share-skip className="ml-auto text-[12px] text-fg-faint hover:text-accent">show cards</button>
            </div>
          )}
          {rows.length > 0 && !agentsSmall && (
            <div className="relative flex flex-wrap gap-2.5 border-t border-border px-3 py-3">
              <button type="button" onClick={foldAgents} title="Fold the agents to icons" data-share-skip className="absolute right-3 top-1.5 text-[11px] text-fg-faint hover:text-accent">fold to icons</button>
              {rows.map((r) => {
                // The ring is this agent's share of all-time spend across
                // every agent. The owner read "81%" and could not tell of
                // what, so it says so beside the ring and in the tooltip.
                const share = sharePct(r.cost, agentTotal)
                const tip = `${share} of all-time spend across every agent — ${fmtUSD(r.cost)} of ${fmtUSD(agentTotal)}`
                return (
                  <div key={r.key} title={tip} className="flex items-center gap-3 rounded-xl border border-border-strong bg-panel py-2 pl-2 pr-3.5 min-w-0">
                    <AgentCharacter who={r.who} size={48} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] font-semibold leading-tight truncate">{r.name}</div>
                      {/* Two pieces that wrap as wholes: on a phone the cost
                        * drops under the turns instead of running into the ring. */}
                      <div className="num text-[12.5px] text-fg-muted leading-snug flex flex-wrap gap-x-1.5">
                        <span className="whitespace-nowrap">{r.turns.toLocaleString('en-US')} turns ·</span>
                        <span className="whitespace-nowrap text-fg">{fmtUSD(r.cost)}</span>
                      </div>
                    </div>
                    <span className="flex items-center gap-1.5">
                      <Ring value={agentTotal > 0 ? r.cost / agentTotal : 0} size={40} width={5} ariaLabel={tip}>
                        <span className="num text-[10.5px] font-medium text-fg">{share}</span>
                      </Ring>
                      <span aria-hidden className="text-[10px] leading-[1.15] text-fg-faint">of<br />spend</span>
                      {tr?.agents?.get(r.key) && <TrendMark cell={tr.agents.get(r.key)!} className="text-[11px]" />}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
          {c.bill.length > 0 && (
            <div className="border-t border-border px-3 py-1.5 text-[10.5px] text-fg-faint">
              Token types are priced at each model's current list price, the way the context tax is.
              {g.data?.bill?.unpriced_tokens ? ' Models with no price are left out.' : ''}
            </div>
          )}
        </>
      )}
      {open && view === 'numbers' && (
        <div className="grid gap-x-10 gap-y-7 px-3 py-4 md:grid-cols-2 min-[1800px]:grid-cols-4">
          <ShareBlock title="Where the money went" head={['model', 'cost']} of="of the cost" segments={c.models} total={c.modelTotal} trends={tr?.models} days={tr?.days} note={tr?.story} />
          {c.bill.length > 0 && <ShareBlock title="The bill by token type" head={['type', 'cost']} of="of the bill" segments={c.bill} total={c.billTotal} trends={tr?.bill} days={tr?.days} />}
          <ShareBlock title="Most-used tools" head={['tool', 'calls']} of="of tool calls" segments={c.tools} total={c.toolTotal} trends={tr?.tools} days={tr?.days} />
          {rows.length > 0 && (
            <ShareBlock
              title="Agents"
              head={['agent', 'turns', 'cost']}
              of="of the spend"
              segments={rows.map((r) => ({ key: r.key, label: r.name, value: r.cost, display: fmtUSD(r.cost) }))}
              trends={tr?.agents}
              days={tr?.days}
              extra={rows.map((r) => r.turns.toLocaleString('en-US'))}
              total={agentTotal}
            />
          )}
        </div>
      )}
    </Panel>
  )
}

/**
 * One block of the Numbers view, the figures with their shares drawn
 * (owner, 2026-10-11: "show the percentages visually, beautifully and
 * effectively"): the leading share large, a 100% bar of the whole in the
 * donuts' colours, and under every row a bar of its share. Still a table, so
 * it stays the charts' text alternative.
 */
export function ShareBlock({ title, head, of, segments, total, extra, trends, days, note, rest }: {
  title: string
  head: string[]
  of: string
  segments: Segment[]
  total: number
  extra?: string[]
  /** A change column after the share; absent, the table is as it always was. */
  trends?: Map<string, TrendCell>
  days?: number
  note?: string
  /** What the rows shown leave of the total, drawn at the end of the whole
   *  bar in grey (no row of its own), so the bar reads as 100%. */
  rest?: { value: number; color: string }
}) {
  const lead = segments[0]
  const pct = (v: number) => (total > 0 ? (100 * v) / total : 0)
  return (
    <div className="min-w-0">
      <p className="text-[11px] uppercase tracking-[0.12em] text-fg-faint">{title}</p>
      {lead && (
        <p className="mt-1.5 flex items-baseline gap-2">
          <span className="num text-[28px] font-semibold leading-none text-accent">{sharePct(lead.value, total)}</span>
          <span className="min-w-0 text-[13px] text-fg-muted [overflow-wrap:anywhere]">
            <span className="text-fg">{lead.label}</span> {of}
          </span>
        </p>
      )}
      <div className="mt-2.5 flex h-2.5 w-full gap-px overflow-hidden rounded-full bg-panel-2" aria-hidden>
        {segments.map((sg, i) => (
          <span key={sg.key} style={{ width: `${pct(sg.value)}%`, background: colorOf(sg, i) }} className="h-full min-w-[2px] first:rounded-l-full last:rounded-r-full" />
        ))}
        {rest && rest.value > 0 && (
          <span style={{ width: `${pct(rest.value)}%`, background: rest.color }} className="h-full min-w-[2px] last:rounded-r-full" data-share-rest />
        )}
      </div>
      <table className="mt-3 w-full border-collapse text-[13px]">
        <caption className="sr-only">{title}</caption>
        <thead>
          <tr className="text-[11px] text-fg-faint">
            {[...head, 'share'].map((h, i) => <th key={h} scope="col" className={`pb-1 font-normal ${i === 0 ? 'text-left' : 'text-right'}`}>{h}</th>)}
            {trends && (
              <th scope="col" className="pb-1 pl-2 text-right font-normal" title={`Change in share, in points: the last ${days} days against the ${days} before`}>
                {days}d
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {segments.map((sg, i) => [
            <tr key={sg.key} className="align-top">
              <th scope="row" className="max-w-[220px] pt-1 pr-2 text-left font-normal text-fg">
                <span className="flex items-center gap-2">
                  <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: colorOf(sg, i) }} />
                  <span className="[overflow-wrap:anywhere]">{sg.label}{sg.detail && <span className="text-fg-faint"> · {sg.detail}</span>}</span>
                </span>
              </th>
              {extra && <td className="num pt-1 pl-2 text-right text-fg-muted">{extra[i]}</td>}
              <td className="num pt-1 pl-2 text-right text-fg">{sg.display}</td>
              <td className="num pt-1 pl-2 text-right font-semibold text-fg">{sharePct(sg.value, total)}</td>
              {trends && <td className="pt-1 pl-2 text-right text-[12px]">{trends.get(sg.key) && <TrendMark cell={trends.get(sg.key)!} />}</td>}
            </tr>,
            // The row's share as a bar the width of the whole row, so the
            // rows compare against each other at a glance.
            <tr key={`${sg.key}-bar`} aria-hidden>
              <td colSpan={head.length + (trends ? 2 : 1)} className="pb-1.5 pl-[18px]">
                <span className="block h-1 rounded-full bg-panel-2">
                  <span className="block h-full rounded-full" style={{ width: `${Math.max(pct(sg.value), 0.8)}%`, background: colorOf(sg, i) }} />
                </span>
              </td>
            </tr>,
          ])}
        </tbody>
      </table>
      {note && <p className="mb-0 mt-2 text-[12px] leading-snug text-fg-muted" data-glance-note>{note}</p>}
    </div>
  )
}
