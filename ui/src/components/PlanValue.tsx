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
import { Panel } from '@/components/ui'

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
      <div className="px-3 py-3">
        <div className="flex items-baseline gap-3 flex-wrap">
          {multiple > 0 && (
            <span className="num text-4xl text-ok leading-none">{multiple.toFixed(1)}×</span>
          )}
          <span className="text-[13px] text-fg-muted max-w-[52ch]">
            what the same usage would have cost at API list price, against what
            your plan costs for the same {days} {dayWord(days)}.
          </span>
        </div>
        <div className="mt-3 grid grid-cols-2 max-w-[420px] border-t border-border">
          <Line label={`you pay (${days}d)`} value={fmtUSD(fee)} />
          <Line label="same usage at API list" value={fmtUSD(usage)} tone="ok" />
        </div>
        <p className="text-[11px] text-fg-faint mt-2 max-w-[64ch]">
          Measured from your own sessions at Anthropic list prices
          ({summary.pricing_version}) — not a discount you received, and not
          money back. Without the plan you would not have run this much.
        </p>
      </div>
    </Panel>
  )
}

function Line({ label, value, tone }: { label: string; value: string; tone?: 'ok' }) {
  return (
    <div className="py-1.5">
      <div className="text-[10px] uppercase tracking-[0.08em] text-fg-faint">{label}</div>
      <div className={`num text-[18px] ${tone === 'ok' ? 'text-ok' : 'text-fg'}`}>{value}</div>
    </div>
  )
}
