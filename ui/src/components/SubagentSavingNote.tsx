import type { Week } from '@/lib/api'
import { fmtUSD } from '@/lib/format'

type Saving = NonNullable<Week['subagent_saving']>

/** "Opus 5.5", "Opus 5.5 and Sonnet 5.5", "Opus 5.5, Sonnet 5.5 and Haiku 4.5". */
function models(list: string[]): string {
  if (list.length <= 1) return list[0] ?? 'a pricier model'
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`
}

/**
 * The one hint beside the week's subagent spend. Computed by the daemon from
 * Caprock's own subagent token counts and the pricing table, and only sent
 * when the difference is a dollar or more; always worded as an estimate.
 */
export function SubagentSavingNote({ saving }: { saving: Saving }) {
  return (
    <p role="note" className="text-[12px] text-fg-muted max-w-[80ch]">
      Subagents this week cost {fmtUSD(saving.cost_usd)} on {models(saving.models)}; on {saving.haiku} about {fmtUSD(saving.haiku_usd)}{' '}
      <span className="text-fg-faint">(estimate at list prices: same tokens, and Haiku is not right for every task). New agent can start a session with its subagents on Haiku.</span>
    </p>
  )
}
