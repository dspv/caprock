/**
 * PlanMonth — this calendar month's Claude Code work at API prices beside
 * what a flat plan costs a month, on the Spend screen (owner-approved mockup,
 * 2026-11-22):
 *
 *   This month, at API prices   $87.40
 *   You pay                     $20 / month
 *   ▬▬▬▬▬▬▬▬▬▬▬▬|▬▬▬▬▬▬▬▬
 *   About 4.4 times what you pay.
 *
 * The month is the summary from the 1st at local midnight (range `Nd`, N the
 * day of the month), Claude Code only, because the plan stated is the Claude
 * plan; the price is the one the user stated. Both are known or the multiple
 * is not said (rule 6). Nothing is shown for a metered or unstated plan: on a
 * metered plan the figure is the bill, and with no plan there is nothing to
 * compare against. Not in the sidebar's Today line, which has no room.
 */
import { api, type Settings } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { fmtUSD } from '@/lib/format'
import { Panel } from '@/components/ui'

/** The summary range that starts on the 1st of `now`'s month. */
export function monthRange(now: Date): `${number}d` {
  return `${now.getDate()}d`
}

/** "About 4.4 times what you pay." — undefined unless both figures are known. */
export function timesWhatYouPay(spend: number | undefined, fee: number | undefined): string | undefined {
  if (!spend || !fee || spend <= 0 || fee <= 0) return undefined
  const k = spend / fee
  if (k < 1) return `About ${Math.round(k * 100)}% of what you pay.`
  return `About ${k >= 10 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')} times what you pay.`
}

export function PlanMonth({ plan, machines }: { plan?: Settings; machines?: 'all' }) {
  const flat = plan?.plan_kind === 'flat'
  const range = monthRange(new Date())
  const month = useApi(() => (flat ? api.summary(range, 'claude', machines) : Promise.resolve(undefined)), [flat, range, machines], { intervalMs: 30_000 })
  if (!flat) return null
  const spend = month.data?.cost_usd
  const fee = plan.plan_usd_per_month > 0 ? plan.plan_usd_per_month : undefined
  const times = timesWhatYouPay(spend, fee)
  // The track is the larger figure; the fill is the work, the tick the fee.
  const top = Math.max(spend ?? 0, fee ?? 0)
  const fill = top > 0 && spend !== undefined ? (spend / top) * 100 : 0
  const tick = top > 0 && fee !== undefined ? (fee / top) * 100 : undefined
  return (
    <Panel fold="cost.plan-month" title="This month" right={<span className="num text-[12px] text-fg-muted">{plan.plan_label || 'Flat plan'} · Claude Code sessions</span>}>
      <div data-plan-month className="px-3 py-2.5 text-[12px]">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-fg-muted">This month, at API prices</span>
          <span data-plan-month-spend className="num text-[18px] font-semibold text-fg">{spend === undefined ? '—' : fmtUSD(spend)}</span>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-fg-muted">You pay</span>
          <span data-plan-month-fee className="num text-fg">{fee === undefined ? '—' : `${fmtUSD(fee)} / month`}</span>
        </div>
        <div className="relative mt-2 h-[4px] rounded-full bg-panel-2" role="img"
          aria-label={spend !== undefined && fee !== undefined ? `This month ${fmtUSD(spend)} at API prices against ${fmtUSD(fee)} a month` : 'This month against your plan'}>
          <span className="block h-full rounded-full bg-ok" style={{ width: `${Math.min(100, fill)}%` }} />
          {tick !== undefined && (
            <span aria-hidden className="absolute top-[-3px] h-[10px] w-[2px] bg-fg-muted" style={{ left: `calc(${Math.min(100, tick)}% - 1px)` }} title="What you pay a month" />
          )}
        </div>
        {times && <div data-plan-month-times className="mt-1.5 text-fg">{times}</div>}
        <div className="mt-1 text-[11px] text-fg-faint">
          From the 1st: the Claude Code sessions Caprock saw, priced at API list.
        </div>
      </div>
    </Panel>
  )
}
