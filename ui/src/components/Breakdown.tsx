/**
 * What the tools and the models add up to, over everything Caprock has seen.
 *
 * It first lived inside the all-time line, behind a toggle: hidden it went
 * unfound, open it pushed Today and the live pulse below the fold. Both were
 * the wrong place rather than the wrong default — the figures are a lifetime
 * summary, not something to check between glances at the pulse, so they belong
 * below the live panels and above the session rows, where the screen has room
 * and nothing is competing for attention.
 *
 * **Each row carries its absolute figure, not only its share.** A percentage
 * says how the spend divides and nothing about its size: "opus-5, 54%" is the
 * same line whether the month cost forty dollars or four thousand. The
 * dollars and the token count were a screen away on Cost, which is one screen
 * too far for the number people actually quote.
 */
import { api } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { fmtTokens, fmtTool, fmtUSD } from '@/lib/format'
import { Panel } from '@/components/ui'
import { ShareCard } from '@/components/Share'
import { ShareNudge } from '@/components/ShareNudge'

export function BreakdownPanel() {
  // Lifetime figures move slowly; a minute is far more often than they change,
  // and this must not compete with the live panels above it for the socket.
  const h = useApi(() => api.history('all'), [], { intervalMs: 60000 })
  const tools = (h.data?.tools ?? []).slice(0, 6)
  const models = (h.data?.summary?.models ?? []).slice(0, 5)
  if (tools.length === 0 && models.length === 0) return null

  const topCalls = tools[0]?.count ?? 0
  const topCost = models[0]?.cost_usd ?? 0
  // Percentages are of everything, not of the six rows shown — a share that
  // silently renormalises to the visible slice reads as "Bash is 58% of your
  // tool calls" when it is 50% of them.
  const allCalls = (h.data?.tools ?? []).reduce((n, t) => n + t.count, 0)
  const allCost = (h.data?.summary?.models ?? []).reduce((n, m) => n + m.cost_usd, 0)

  // Absent rather than zeroed when the daemon sends no token counts: four
  // zeroes read as "you used nothing", which is a different claim from "this
  // build does not report it".
  const sum = h.data?.summary
  const tok =
    sum && (sum.tokens_in || sum.tokens_out || sum.cache_read || sum.cache_write)
      ? { in: sum.tokens_in, out: sum.tokens_out, cacheRead: sum.cache_read, cacheWrite: sum.cache_write }
      : null

  return (
    <Panel
      title="All time"
      right={
        <span className="inline-flex items-center gap-3">
          {/* The one thing here that travels: these figures are the most
            * persuasive part of the product and they are stuck on one
            * machine. */}
          {/* Always here, whatever the figures say: whether they are worth
            * posting is the reader's call, not ours. The nudge beside it is
            * the part that waits for an occasion. */}
          <ShareNudge now={Date.now()} />
          <ShareCard />
          <a href="#/history" className="text-fg-faint hover:text-accent no-underline">
            every tool, model and project →
          </a>
        </span>
      }
    >
      <div className="grid gap-x-8 gap-y-5 px-3 py-3 md:grid-cols-2">
        <Bars
          title="Most-used tools"
          note="by calls"
          rows={tools.map((t) => ({
            key: t.tool,
            label: fmtTool(t.tool),
            value: t.count.toLocaleString('en-US'),
            share: allCalls > 0 ? (100 * t.count) / allCalls : null,
            frac: topCalls > 0 ? t.count / topCalls : 0,
          }))}
        />
        <Bars
          title="Where the money went"
          note="by cost"
          rows={models.map((m) => ({
            key: m.model,
            label: m.model || 'unknown',
            value: fmtUSD(m.cost_usd),
            sub: fmtTokens(m.tokens),
            share: allCost > 0 ? (100 * m.cost_usd) / allCost : null,
            frac: topCost > 0 ? m.cost_usd / topCost : 0,
          }))}
        />
      </div>

      {/* The in/out split, which the per-model rows cannot show: a model row
        * has one token total, and input against output is the ratio that
        * explains the bill. Output costs five times input, so a small output
        * number beside a large input one is the whole story of why a month
        * cost what it did. Cache read is stated beside them because on this
        * workload it dwarfs both and would otherwise make the two look like
        * they should add up to the total. */}
      {tok && (
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 border-t border-border px-3 py-2 text-[11px]">
          <span className="text-[10px] uppercase tracking-[0.12em] text-fg-faint">Tokens</span>
          <span className="text-fg-muted">
            input <span className="num text-fg">{fmtTokens(tok.in)}</span>
          </span>
          <span className="text-fg-muted">
            output <span className="num text-fg">{fmtTokens(tok.out)}</span>
          </span>
          <span className="text-fg-muted">
            cache read <span className="num text-fg">{fmtTokens(tok.cacheRead)}</span>
          </span>
          <span className="text-fg-muted">
            cache write <span className="num text-fg">{fmtTokens(tok.cacheWrite)}</span>
          </span>
          <span className="ml-auto text-fg-faint">fresh input is billed at full price</span>
        </div>
      )}
    </Panel>
  )
}

/** A short ranked list — label, bar, figure — used for both breakdowns. */
function Bars({
  title,
  note,
  rows,
}: {
  title: string
  note: string
  rows: {
    key: string
    label: string
    value: string
    /** A second figure for the same row — tokens beside a cost. Optional
     *  because a tool call has no meaningful token count of its own. */
    sub?: string
    share: number | null
    frac: number
  }[]
}) {
  if (rows.length === 0) return null
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-[0.12em] text-fg-faint">{title}</span>
        <span className="text-[10px] text-fg-faint">{note}</span>
      </div>
      <div className="grid gap-1.5">
        {rows.map((r) => (
          <div key={r.key} className="flex items-center gap-2 text-[11px]">
            <span className="mono w-36 shrink-0 truncate text-fg-muted" title={r.label}>
              {r.label}
            </span>
            <span className="h-1.5 flex-1 rounded-full bg-panel-2">
              <span
                className="block h-full rounded-full bg-accent/70"
                style={{ width: `${Math.max(2, Math.round(r.frac * 100))}%` }}
              />
            </span>
            <span className="num w-20 shrink-0 text-right text-fg">{r.value}</span>
            {/* Tokens sit between the figure and the share: the volume that
              * produced the cost, in the same units the vendor bills in. */}
            <span className="num w-16 shrink-0 text-right text-fg-faint">{r.sub ?? ''}</span>
            {/* The share is what makes the count mean something: 40,961 calls
              * is a number, half of everything is a finding. Floored, so a
              * row never rounds up into looking bigger than it is. */}
            <span className="num w-9 shrink-0 text-right text-fg-faint">
              {r.share === null ? '' : r.share < 1 ? '<1%' : `${Math.floor(r.share)}%`}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
