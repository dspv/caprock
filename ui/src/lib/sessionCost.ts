import type { Event, Stats } from './api'
import { fmtUSD } from './format'

/**
 * What a session's Cost figure says once turns the pricing table could not
 * price are taken into account. A model with no published price (Claude Code
 * on Kimi, `kimi-k3`) leaves its turns' cost unknown, and the stored total
 * sums only what was priced: printing that sum alone said "$0.00" — that the
 * work was free — when the truth is that nobody knows (rule 6).
 *
 * - `state` is `priced` (nothing unknown), `partial` (a priced sum plus turns
 *   left out of it) or `unknown` (no turn priced at all).
 * - `value` is the figure: the priced sum, or "—" when nothing was priced.
 * - `note` is the short caption beside the model: "price unknown" or
 *   "+ N unpriced turns"; absent when everything was priced.
 * - `title` explains the note on hover.
 */
export interface SessionCost {
  state: 'priced' | 'partial' | 'unknown'
  value: string
  note?: string
  title?: string
}

export function sessionCost(stats: Pick<Stats, 'cost_usd' | 'unpriced_turns'>, model?: string): SessionCost {
  const n = stats.unpriced_turns ?? 0
  if (n <= 0) return { state: 'priced', value: fmtUSD(stats.cost_usd) }
  const who = model || 'This model'
  if (!(stats.cost_usd > 0)) {
    return {
      state: 'unknown',
      value: '—',
      note: 'price unknown',
      title: `${who} has no published price in Caprock's pricing table, so this session's cost is unknown — not $0.00.`,
    }
  }
  const turns = `${n} unpriced turn${n === 1 ? '' : 's'}`
  return {
    state: 'partial',
    value: fmtUSD(stats.cost_usd),
    note: `+ ${turns}`,
    title: `${fmtUSD(stats.cost_usd)} is what could be priced. ${turns} ran on a model with no published price in Caprock's pricing table and are not in it.`,
  }
}

function hasTokens(e: Pick<Event, 'tokens'>): boolean {
  const t = e.tokens
  return !!t && t.in + t.out + t.cache_read + t.cache_write > 0
}

/** An assistant turn with tokens and no cost: its model is not in the pricing table. */
export function isUnpricedTurn(e: Pick<Event, 'kind' | 'cost_usd' | 'tokens'>): boolean {
  return e.kind === 'turn.assistant' && typeof e.cost_usd !== 'number' && hasTokens(e)
}

/**
 * The caption under the cumulative cost line, over the turns loaded: the
 * priced ones and their sum, and the unpriced ones beside it, never folded
 * into a $0.00.
 */
export function cumulativeCaption(events: Pick<Event, 'kind' | 'cost_usd' | 'tokens'>[]): string {
  let priced = 0, unpriced = 0, sum = 0
  for (const e of events) {
    if (e.kind !== 'turn.assistant') continue
    // A turn with no tokens and no cost (the replayed history a resumed
    // session starts with) was neither priced nor unpriced: it is not counted.
    if (typeof e.cost_usd === 'number' && (e.cost_usd > 0 || hasTokens(e))) { priced++; sum += e.cost_usd } else if (isUnpricedTurn(e)) unpriced++
  }
  if (unpriced > 0 && priced === 0) return `${unpriced} turn${unpriced === 1 ? '' : 's'} · price unknown`
  const head = `${priced} priced turn${priced === 1 ? '' : 's'} · ${fmtUSD(sum)}`
  return unpriced > 0 ? `${head} · + ${unpriced} unpriced` : head
}
