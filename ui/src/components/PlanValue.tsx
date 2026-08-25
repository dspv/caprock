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
      {/* The same row of tiles every other panel on this screen uses.
        *
        * It was a two-column grid whose right column held one 46-character
        * sentence, so on a full-width panel two thirds of the row was empty —
        * and the multiple, the figure the whole panel exists to deliver, was
        * set as a word inside that sentence. Three equal tiles fix both: the
        * comparison reads left to right as a sentence of its own — you pay
        * this, the same work costs that, which is this many times over — and
        * the width is spent on the numbers rather than on air. */}
      <div className="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-border">
        <Stat
          label={`you pay · ${days}d`}
          value={fmtUSD(fee)}
          sub={plan.plan_label}
        />
        <Stat
          label="same usage at API list"
          value={fmtUSD(usage)}
          sub={`at list prices ${summary.pricing_version}`}
          tone="ok"
        />
        {/* Hero, and last: it is what the two figures beside it add up to, and
          * the reason anyone reads the panel. */}
        <Stat
          label="which is"
          value={multiple > 0 ? `${multiple.toFixed(1)}×` : '—'}
          sub={multiple > 0 ? `what ${days} ${dayWord(days)} would cost through the API` : 'not enough measured usage yet'}
          tone={multiple > 0 ? 'ok' : undefined}
          size="hero"
        />
      </div>
      {/* Its own rule: the caveat qualifies all three tiles, and sitting flush
        * under the first one it read as that tile's footnote. */}
      <p className="border-t border-border px-3 py-2 text-[11px] text-fg-faint leading-relaxed">
        Not a discount you received, and not money back — without the plan you
        would not have run this much.
      </p>
    </Panel>
  )
}
