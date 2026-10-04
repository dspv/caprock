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
import { AgentCharacter, agentName, characterFor, type Character } from '@/components/Characters'
import { Donut, Ring, sharePct, topN, type Segment } from '@/components/Donut'

const OPEN_KEY = 'caprock-glance-open'
const VIEW_KEY = 'caprock-glance-view'

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
        { key: 'cache_read', label: 'cache read · re-reading context', value: b.cache_read_usd, display: fmtUSD(b.cache_read_usd) },
        { key: 'cache_write', label: 'cache write', value: b.cache_write_usd, display: fmtUSD(b.cache_write_usd) },
        { key: 'output', label: 'output', value: b.output_usd, display: fmtUSD(b.output_usd) },
        { key: 'input', label: 'uncached input', value: b.input_usd, display: fmtUSD(b.input_usd) },
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
  const h = useApi(() => api.history('all'), [], { intervalMs: 60000 })
  const g = useApi(() => api.glance(), [], { intervalMs: 60000 })
  const c = glanceCharts(h.data, g.data)
  const rows = agentRows(g.data?.agents ?? [])
  const agentTotal = rows.reduce((a, r) => a + r.cost, 0)
  if (c.models.length === 0 && c.tools.length === 0) return null

  const toggle = () => { const v = !open; setOpen(v); write(OPEN_KEY, v ? '1' : '0') }
  const pick = (v: 'charts' | 'numbers') => { setView(v); write(VIEW_KEY, v) }
  const lead = (segs: Segment[], total: number) => (segs[0] ? sharePct(segs[0].value, total) : '—')
  const readRe = c.bill.find((s) => s.key === 'cache_read')

  return (
    <Panel
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
          <div className="grid gap-x-8 gap-y-5 px-3 py-3 md:grid-cols-3">
            <Donut title="Where the money went" segments={c.models} center={lead(c.models, c.modelTotal)} centerLabel={c.models[0]?.label ?? ''}
              ariaLabel={`Cost by model: ${c.models.map((s) => `${s.label} ${s.display}, ${sharePct(s.value, c.modelTotal)}`).join('; ')}`} />
            {c.bill.length > 0 && (
              <Donut title="The bill by token type" segments={c.bill} center={readRe ? sharePct(readRe.value, c.billTotal) : '—'} centerLabel="re-reading context"
                ariaLabel={`Cost by token type at current list prices: ${c.bill.map((s) => `${s.label} ${s.display}, ${sharePct(s.value, c.billTotal)}`).join('; ')}`} />
            )}
            <Donut title="Most-used tools" segments={c.tools} center={lead(c.tools, c.toolTotal)} centerLabel={c.tools[0]?.label ?? ''}
              ariaLabel={`Tool calls by tool: ${c.tools.map((s) => `${s.label} ${s.display}, ${sharePct(s.value, c.toolTotal)}`).join('; ')}`} />
          </div>
          {rows.length > 0 && (
            <div className="flex flex-wrap gap-2.5 border-t border-border px-3 py-3">
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
        <div className="grid gap-x-8 gap-y-4 px-3 py-3 md:grid-cols-2 xl:grid-cols-4">
          <NumTable title="Where the money went" head={['model', 'cost', 'share']} rows={c.models.map((s) => [s.label, s.display, sharePct(s.value, c.modelTotal)])} />
          {c.bill.length > 0 && <NumTable title="The bill by token type" head={['type', 'cost', 'share']} rows={c.bill.map((s) => [s.label, s.display, sharePct(s.value, c.billTotal)])} />}
          <NumTable title="Most-used tools" head={['tool', 'calls', 'share']} rows={c.tools.map((s) => [s.label, s.display, sharePct(s.value, c.toolTotal)])} />
          {rows.length > 0 && <NumTable title="Agents" head={['agent', 'turns', 'cost', 'share']} rows={rows.map((r) => [r.name, r.turns.toLocaleString('en-US'), fmtUSD(r.cost), sharePct(r.cost, agentTotal)])} />}
        </div>
      )}
    </Panel>
  )
}

function NumTable({ title, head, rows }: { title: string; head: string[]; rows: string[][] }) {
  return (
    <table className="w-full text-[11px] border-collapse">
      <caption className="text-left text-[10px] uppercase tracking-[0.12em] text-fg-faint pb-1.5">{title}</caption>
      <thead>
        <tr className="text-fg-faint">
          {head.map((h, i) => <th key={h} scope="col" className={`font-normal pb-1 ${i === 0 ? 'text-left' : 'text-right'}`}>{h}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r[0]} className="border-t border-border">
            {r.map((cell, i) => (
              i === 0
                ? <th key={i} scope="row" className="text-left font-normal text-fg-muted py-0.5 pr-2 truncate max-w-[160px]">{cell}</th>
                : <td key={i} className="num text-right text-fg py-0.5 pl-2">{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
