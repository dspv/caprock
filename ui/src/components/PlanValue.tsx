/**
 * PlanValue — what a month of measured usage is worth against what you actually
 * pay. The one number most people have never seen, because nobody tells you
 * what the same work would have cost through the API.
 *
 * Honesty rules baked in here (rule 6 — no invented numbers):
 *  - the figure is the measured API-list-price equivalent of captured usage,
 *    never a model or an extrapolation;
 *  - on a flat plan we say what the same usage would cost at API list price —
 *    we do NOT say "you saved $X", because without the plan you would not have
 *    run this much;
 *  - on metered billing (API key, Bedrock, Vertex, Enterprise at API rates)
 *    that figure is approximately the actual bill, so no multiple is shown and
 *    the total is labelled as spend;
 *  - with no plan stated, nothing is claimed at all — and while the hero cost
 *    asks for the plan (components/PlanAsk), this panel does not ask too.
 *
 * On a flat plan the panel is the one place Cost compares spend with the
 * plan (owner, 2026-11-22): this calendar month's Claude Code work at API
 * prices beside the monthly fee, a bar, and "About K times what you pay."
 * (components/PlanMonth). It replaced three range-scaled tiles (you pay · Nd,
 * same usage at API list, which is N×) — a second multiple over another window
 * beside the month's would have read as two answers to one question. The
 * range's own figure is the Totals hero below.
 */
import type { Settings, Summary } from '@/lib/api'
import { fmtUSD } from '@/lib/format'
import { Panel } from '@/components/ui'
import { ShareWith } from '@/components/PanelShare'
import { usePlanAskShowing } from '@/components/PlanAsk'
import { MonthCompare, monthText, useMonthSpend } from '@/components/PlanMonth'

const dayWord = (n: number) => (n === 1 ? 'day' : 'days')

export function PlanValue({ summary, plan, days, machines }: { summary?: Summary; plan?: Settings; days: number; machines?: 'all' }) {
  const [asked] = usePlanAskShowing(plan)
  if (!summary) return null
  const usage = summary.cost_usd

  // Nothing stated: invite the user to say, and claim nothing — unless the
  // hero figure is already asking.
  if (!plan?.plan_kind) {
    if (asked) return null
    return (
      <Panel fold="cost.plan-value" title="Plan value">
        <div className="px-3 py-3 text-[12px] text-fg-muted">
          Set your plan in the header and Caprock will show what this usage is
          worth against what you actually pay. It can&apos;t detect your plan, so
          it won&apos;t guess.
        </div>
      </Panel>
    )
  }

  if (plan.plan_kind === 'metered') {
    return (
      <Panel fold="cost.plan-value" title="Spend" share="Spend" right={<span className="num text-[12px] text-fg-muted">{plan.plan_label || 'API'} · billed per token</span>}>
        <ShareWith toText={() => `${fmtUSD(usage)} over the last ${days} ${dayWord(days)}, billed per token (${plan.plan_label || 'API'}), at API list prices ${summary.pricing_version}.`} />
        <div className="px-3 py-3">
          <div className="flex items-baseline gap-2">
            <span className="num text-3xl text-fg">{fmtUSD(usage)}</span>
            <span className="text-[12px] text-fg-muted">over the last {days} {dayWord(days)}</span>
          </div>
          <p className="text-[11px] text-fg-faint mt-2 max-w-[60ch]">
            You are billed per token, so this is approximately your actual cost —
            at API list prices ({summary.pricing_version}). Not a saving.
          </p>
        </div>
      </Panel>
    )
  }

  return <FlatPlanValue plan={plan} machines={machines} />
}

/** A flat plan: the month against the fee, then the caveat. */
function FlatPlanValue({ plan, machines }: { plan: Settings; machines?: 'all' }) {
  const spend = useMonthSpend(machines)
  return (
    <Panel
      title="Plan value"
      share="Plan value"
      right={<span className="num text-[12px] text-fg-muted">{plan.plan_label} · {fmtUSD(plan.plan_usd_per_month)}/mo</span>}
    >
      <ShareWith toText={() => `${monthText(spend, plan)}\n\nNot a discount you received, and not money back — without the plan you would not have run this much.`} />
      <MonthCompare plan={plan} spend={spend} />
      {/* Its own rule: the caveat qualifies the whole comparison. */}
      <p className="border-t border-border px-3 py-2 text-[11px] text-fg-faint leading-relaxed">
        Not a discount you received, and not money back — without the plan you
        would not have run this much.
      </p>
    </Panel>
  )
}
