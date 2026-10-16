import type { HermesCost } from '@/lib/api'
import { fmtUSD } from '@/lib/format'
import { Panel, Stat } from '@/components/ui'
import { AgentGlyph } from './AgentMarks'

/** How a Hermes session source reads in a sentence. */
export function hermesSourceLabel(source: string): string {
  switch (source) {
    case 'cron': return 'cron jobs'
    case 'oneshot': return 'one-shot runs'
    case '': return 'unknown'
    default: return source
  }
}

/**
 * Hermes Agent on the Cost screen (ADR-069): the part of the total that came
 * from Hermes, said in Hermes's own terms. Two splits, because Hermes records
 * both and neither is visible anywhere else:
 *
 * - what kind of figure it is: the provider's billing, where Hermes recorded
 *   one, or Hermes's estimate from its own price list — never Caprock's
 *   table, so the panel says whose arithmetic it is;
 * - who was there: Hermes runs cron jobs and answers chats through its
 *   gateway with nobody watching, and that spend is easy to miss in a total.
 *
 * Rendered only when the range has Hermes turns.
 */
export function HermesSpendPanel({ h, range }: { h?: HermesCost; range: string }) {
  if (!h) return null
  const sources = (h.sources ?? []).filter((s) => s.cost_usd > 0)
  return (
    <Panel
      fold="cost.hermes"
      title={<span className="inline-flex items-center gap-1.5"><AgentGlyph agent="hermes" />Hermes Agent · {range}</span>}
      right={<span title="Hermes prices its own calls; Caprock shows its figures as recorded">Hermes's own figures</span>}
    >
      <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-border">
        <Stat label="Hermes total" value={fmtUSD(h.total_usd)} sub="inside the total above" />
        <Stat label="Provider-reported" value={fmtUSD(h.actual_usd)} sub="actual: what the provider billed" />
        <Stat label="Hermes estimate" value={fmtUSD(h.estimated_usd)} sub="estimated from Hermes's price list" />
        <Stat
          label="Background"
          value={fmtUSD(h.background_usd)}
          sub={sources.length ? sources.map((s) => `${hermesSourceLabel(s.source)} ${fmtUSD(s.cost_usd)}`).join(' · ') : 'cron, chats, one-shot runs'}
          hint="Runs nobody was watching as they happened: Hermes's cron jobs, chats through its gateway (Telegram, Slack…) and one-shot runs. Hermes's CLI, TUI, desktop app and editor sessions are the rest."
        />
      </div>
      {((h.unpriced_turns ?? 0) > 0 || (h.included_turns ?? 0) > 0) && (
        <p className="mx-3 mb-2.5 text-[12px] text-fg-muted">
          {(h.unpriced_turns ?? 0) > 0 && <span className="text-warn">{h.unpriced_turns!.toLocaleString('en-US')} {h.unpriced_turns === 1 ? 'turn' : 'turns'} Hermes could not price {h.unpriced_turns === 1 ? 'is' : 'are'} not in these figures. </span>}
          {(h.included_turns ?? 0) > 0 && <span>{h.included_turns!.toLocaleString('en-US')} on a subscription route, counted at $0.</span>}
        </p>
      )}
    </Panel>
  )
}
