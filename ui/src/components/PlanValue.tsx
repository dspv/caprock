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
      {/* The comparison first, the conclusion after it.
        *
        * Three equal cells made the multiple look like the subject and left a
        * reader working out which two numbers it came from. It is the other
        * way round: the money is the fact — what you pay against what the same
        * work costs billed per token — and the multiple is what that
        * comparison amounts to. So the two figures sit together as a pair with
        * "vs" between them, and the multiple follows as the sentence they add
        * up to. */}
      <div className="px-3 py-3 grid gap-4 md:grid-cols-[auto_1fr] md:gap-8 md:items-center">
        <div className="flex items-end gap-4 sm:gap-6">
          <div>
            <div className="text-[10px] uppercase tracking-[0.12em] text-fg-faint">
              you pay · {days}d
            </div>
            <div className="num font-semibold tracking-[-0.01em] text-[30px] leading-[1.05] text-fg">
              {fmtUSD(fee)}
            </div>
            <div className="text-[11px] text-fg-muted num">{plan.plan_label}</div>
          </div>

          <div className="pb-2 text-[13px] text-fg-faint">vs</div>

          <div>
            <div className="text-[10px] uppercase tracking-[0.12em] text-fg-faint">
              same usage at API list
            </div>
            <div className="num font-semibold tracking-[-0.01em] text-[30px] leading-[1.05] text-ok">
              {fmtUSD(usage)}
            </div>
            <div className="text-[11px] text-fg-muted num">
              at list prices {summary.pricing_version}
            </div>
          </div>
        </div>

        {/* The conclusion, set apart by a rule rather than by size: it is a
          * derived figure and should not outshout the money it derives from. */}
        <div className="md:border-l md:border-border md:pl-8">
          <p className="text-[15px] leading-snug text-fg-muted max-w-[46ch]">
            {multiple > 0 ? (
              <>
                <span className="num text-ok font-semibold">{multiple.toFixed(1)}×</span> what
                the same {days} {dayWord(days)} would have cost through the API.
              </>
            ) : (
              <>Not enough measured usage yet to compare.</>
            )}
          </p>
          <p className="mt-2 text-[11px] text-fg-faint max-w-[56ch] leading-relaxed">
            Not a discount you received, and not money back — without the plan
            you would not have run this much.
          </p>
        </div>
      </div>
    </Panel>
  )
}
