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
 */
import { useState } from 'react'
import { api, type Glance, type History, type WeekAgent } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { fmtTool, fmtUSD } from '@/lib/format'
import { Panel } from '@/components/ui'
import { SLOW_LIVE_MS, useOnScreen } from '@/lib/refresh'
import { AgentCharacter, agentName, characterFor, type Character } from '@/components/Characters'
import { colorOf, Donut, Ring, sharePct, topN, type Segment } from '@/components/Donut'

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
  const order = ['claude', 'claude-sub', 'codex', 'opencode', 'gemini', 'deepseek']
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
  if (c.models.length === 0 && c.tools.length === 0) return null

  const toggle = () => { const v = !open; setOpen(v); write(OPEN_KEY, v ? '1' : '0') }
  const pick = (v: 'charts' | 'numbers') => { setView(v); write(VIEW_KEY, v) }
  const foldAgents = () => { const v = !agentsSmall; setAgentsSmall(v); write(AGENTS_KEY, v ? 'icons' : 'cards') }
  const lead = (segs: Segment[], total: number) => (segs[0] ? sharePct(segs[0].value, total) : '—')
  const readRe = c.bill.find((s) => s.key === 'cache_read')

  return (
    <Panel
      sectionRef={seen}
      title={
        <button type="button" onClick={toggle} aria-expanded={open} className="inline-flex items-center gap-1.5 uppercase tracking-[0.12em] hover:text-fg">
          <span aria-hidden className={`inline-block transition-transform ${open ? 'rotate-90' : ''}`}>›</span>
          At a glance
        </button>
      }
      right={
        open ? (
          <span className="inline-flex items-center gap-0.5 rounded-md bg-panel-2 p-0.5" role="group" aria-label="View">
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
      {open && view === 'charts' && (
        <>
          {/* Three across only when the panel itself has room for three
            * donuts with their legends under them; a narrower panel (the app
            * with the sidebar and inspector open) stacks them, each with the
            * legend beside it. The panel's width decides, not the window's. */}
          <div className="@container">
          <div className="grid gap-x-8 gap-y-5 px-3 py-3 @[720px]:grid-cols-3">
            <Donut title="Where the money went" segments={c.models} center={lead(c.models, c.modelTotal)} centerLabel={c.models[0]?.label ?? ''}
              ariaLabel={`Cost by model: ${c.models.map((s) => `${s.label} ${s.display}, ${sharePct(s.value, c.modelTotal)}`).join('; ')}`} />
            {c.bill.length > 0 && (
              <Donut title="The bill by token type" segments={c.bill} center={readRe ? sharePct(readRe.value, c.billTotal) : '—'} centerLabel="re-reading context"
                ariaLabel={`Cost by token type at current list prices: ${c.bill.map((s) => `${s.label} ${s.display}, ${sharePct(s.value, c.billTotal)}`).join('; ')}`} />
            )}
            <Donut title="Most-used tools" segments={c.tools} center={lead(c.tools, c.toolTotal)} centerLabel={c.tools[0]?.label ?? ''}
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
              <button type="button" onClick={foldAgents} className="ml-auto text-[12px] text-fg-faint hover:text-accent">show cards</button>
            </div>
          )}
          {rows.length > 0 && !agentsSmall && (
            <div className="relative flex flex-wrap gap-2.5 border-t border-border px-3 py-3">
              <button type="button" onClick={foldAgents} title="Fold the agents to icons" className="absolute right-3 top-1.5 text-[11px] text-fg-faint hover:text-accent">fold to icons</button>
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
          <ShareBlock title="Where the money went" head={['model', 'cost']} of="of the cost" segments={c.models} total={c.modelTotal} />
          {c.bill.length > 0 && <ShareBlock title="The bill by token type" head={['type', 'cost']} of="of the bill" segments={c.bill} total={c.billTotal} />}
          <ShareBlock title="Most-used tools" head={['tool', 'calls']} of="of tool calls" segments={c.tools} total={c.toolTotal} />
          {rows.length > 0 && (
            <ShareBlock
              title="Agents"
              head={['agent', 'turns', 'cost']}
              of="of the spend"
              segments={rows.map((r) => ({ key: r.key, label: r.name, value: r.cost, display: fmtUSD(r.cost) }))}
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
function ShareBlock({ title, head, of, segments, total, extra }: {
  title: string
  head: string[]
  of: string
  segments: Segment[]
  total: number
  extra?: string[]
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
      </div>
      <table className="mt-3 w-full border-collapse text-[13px]">
        <caption className="sr-only">{title}</caption>
        <thead>
          <tr className="text-[11px] text-fg-faint">
            {[...head, 'share'].map((h, i) => <th key={h} scope="col" className={`pb-1 font-normal ${i === 0 ? 'text-left' : 'text-right'}`}>{h}</th>)}
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
            </tr>,
            // The row's share as a bar the width of the whole row, so the
            // rows compare against each other at a glance.
            <tr key={`${sg.key}-bar`} aria-hidden>
              <td colSpan={head.length + 1} className="pb-1.5 pl-[18px]">
                <span className="block h-1 rounded-full bg-panel-2">
                  <span className="block h-full rounded-full" style={{ width: `${Math.max(pct(sg.value), 0.8)}%`, background: colorOf(sg, i) }} />
                </span>
              </td>
            </tr>,
          ])}
        </tbody>
      </table>
    </div>
  )
}
