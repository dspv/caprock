/**
 * What the tools and the models add up to, over everything Caprock has seen.
 *
 * It first lived inside the all-time line, behind a toggle: hidden it went
 * unfound, open it pushed Today and the live pulse below the fold. Both were
 * the wrong place rather than the wrong default — the figures are a lifetime
 * summary, not something to check between glances at the pulse, so they belong
 * below the live panels and above the session rows, where the screen has room
 * and nothing is competing for attention.
 */
import { api } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { fmtTool, fmtUSD } from '@/lib/format'
import { Panel } from '@/components/ui'
import { ShareCard } from '@/components/ShareCard'

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

  return (
    <Panel
      title="All time"
      right={
        <span className="inline-flex items-center gap-3">
          {/* The one thing here that travels: these figures are the most
            * persuasive part of the product and they are stuck on one
            * machine. */}
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
            share: allCost > 0 ? (100 * m.cost_usd) / allCost : null,
            frac: topCost > 0 ? m.cost_usd / topCost : 0,
          }))}
        />
      </div>
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
  rows: { key: string; label: string; value: string; share: number | null; frac: number }[]
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
