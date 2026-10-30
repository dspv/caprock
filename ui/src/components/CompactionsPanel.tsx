/**
 * Compactions for a period (ADR-085 as amended 2026-10-30; .ai/04-ui.md §
 * Cost, § Week): how many times the context was compacted, what that cost
 * and what it has saved since, and the net — every figure an estimate from
 * the pricing table, marked ≈ (rule 6). Read from GET /v1/stats/compactions,
 * a range on Cost and the week's own window on Week. Nothing drawn when the
 * period had no compaction.
 */
import { api, type CompactionPeriod } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { approxUSD } from '@/lib/compact'
import { Panel, Stat } from './ui'

/** What the ≈ figures assume, on the panel's hint. */
export const COMPACTIONS_HOW =
  "Estimates. Claude Code records no usage for a compaction's summary call: its cost is the context before, read from the cache when the last call was within the cache's life and sent again in full when not, plus the summary as output, at the session model's list prices. The saving is the dropped context, priced as a cache read, for every call after each compaction until the next. A compaction counts in the period it happened, with everything it has saved since."

export function CompactionsFigures({ p }: { p: CompactionPeriod }) {
  const net = p.net_usd
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-border" data-compactions="figures">
      <Stat label="Compactions" value={<span className="num">{p.count}</span>}
        sub={p.priced < p.count ? `${p.count - p.priced} without a price` : `${p.turns_after.toLocaleString('en-US')} calls after`} size="compact" />
      <Stat label="Cost" value={<span className="num">{approxUSD(p.est_cost_usd)}</span>} sub={`median ${approxUSD(p.median_cost_usd)} each`} size="compact" />
      <Stat label="Saved" value={<span className="num">{approxUSD(p.est_saved_usd)}</span>} sub={`median ${approxUSD(p.median_saved_usd)} each`} tone="ok" size="compact" />
      <Stat label="Net" value={<span className="num">{approxUSD(net)}</span>} sub={net >= 0 ? 'saved, less what compacting cost' : 'compacting cost more than it saved'}
        tone={net >= 0 ? 'ok' : 'warn'} size="compact" hint={COMPACTIONS_HOW} wideHint />
    </div>
  )
}

/** The panel: a range as Cost picks it, or a window in unix ms (Week). */
export function CompactionsPanel({ window: w, title = 'Compactions', fold }: { window: { range: string } | { from: number; to: number }; title?: string; fold?: string }) {
  const key = 'range' in w ? w.range : `${w.from}-${w.to}`
  const r = useApi(() => api.compactionPeriod(w), [key], { intervalMs: 60_000 })
  const p = r.data
  if (!p || p.count === 0) return null
  return (
    <Panel fold={fold} title={title} right={<span title={COMPACTIONS_HOW}>≈ estimates from list prices</span>}>
      <CompactionsFigures p={p} />
    </Panel>
  )
}
