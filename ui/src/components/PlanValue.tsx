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
 *  - with no plan stated, nothing is claimed at all.
 */
import type { Settings, Summary } from '@/lib/api'
import { fmtUSD } from '@/lib/format'
import { Panel, Stat } from '@/components/ui'

const dayWord = (n: number) => (n === 1 ? 'day' : 'days')

export function PlanValue({ summary, plan, days }: { summary?: Summary; plan?: Settings; days: number }) {
  if (!summary) return null
  const usage = summary.cost_usd

  // Nothing stated: invite the user to say, and claim nothing.
  if (!plan?.plan_kind) {
    return (
      <Panel title="Plan value">
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
      <Panel title="Spend" right={<span className="num text-[12px] text-fg-muted">{plan.plan_label || 'API'} · billed per token</span>}>
        <div className="px-3 py-3">
          <div className="flex items-baseline gap-2">
            <span className="num text-3xl text-fg">{fmtUSD(usage)}</span>
            <span className="text-[12px] text-fg-muted">over the last {days} {dayWord(days)}</span>
          </div>
          <p className="text-[11px] text-fg-faint mt-2 max-w-[60ch]">
            You are billed per token, so this is approximately your actual cost —
            at Anthropic list prices ({summary.pricing_version}). Not a saving.
          </p>
        </div>
      </Panel>
    )
  }

  // Flat plan: compare against what the seat costs for the same window.
  const fee = (plan.plan_usd_per_month * days) / 30
  const multiple = fee > 0 ? usage / fee : 0
  return (
    <Panel
      title="Plan value"
      right={<span className="num text-[12px] text-fg-muted">{plan.plan_label} · {fmtUSD(plan.plan_usd_per_month)}/mo</span>}
    >
      {/* The same divided row of stats the Today panel uses, for the same
        * reason: three figures of different weight read as a hierarchy when
        * they share one grid and as a list when each carries its own layout.
        *
        * The multiple leads at hero size because it is what the panel is
        * about; the two figures it is derived from sit beside it, comparable
        * at a glance. Previously the multiple was alone on the left at 4xl
        * while the actual money sat right-aligned at 18px with a column of
        * empty panel between — the derived number louder than the real ones,
        * and most of the width spent on nothing. */}
      <div className="grid grid-cols-2 lg:grid-cols-[1.1fr_1fr_1fr] divide-x divide-border">
        <Stat
          label={`worth · ${days}d`}
          value={multiple > 0 ? `${multiple.toFixed(1)}×` : '—'}
          tone="ok"
          size="hero"
          sub="what the same usage would have cost"
        />
        <Stat label={`you pay (${days}d)`} value={fmtUSD(fee)} sub={plan.plan_label} />
        <Stat
          label="same usage at API list"
          value={fmtUSD(usage)}
          tone="ok"
          sub={`at list prices ${summary.pricing_version}`}
        />
      </div>
      {/* The caveat stays, below the figures rather than beside them: it
        * qualifies all three, and a reader who quotes the multiple should
        * find it. */}
      <p className="px-3 pb-3 text-[11px] text-fg-faint max-w-[72ch] leading-relaxed">
        Measured from your own sessions at Anthropic list prices — not a discount
        you received, and not money back. Without the plan you would not have run
        this much.
      </p>
    </Panel>
  )
}
