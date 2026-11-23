import type { CostSeries, Event, Stats } from './api'
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

export function sessionCost(stats: Pick<Stats, 'cost_usd' | 'unpriced_turns'>, model?: string, gap?: string): SessionCost {
  // The agent keeps no cost for this session and Caprock does not price it
  // from its own table (Cursor, ADR-095): that, not the table, is why. A
  // cursor-agent chat seen through hooks has no unpriced turn either (no
  // turn carries tokens), so this comes before the count.
  if (gap && !(stats.cost_usd > 0)) return { state: 'unknown', value: '—', note: gap, title: gap }
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

/**
 * The sentence a session's cost figure is replaced by when its agent keeps
 * no cost and nothing was priced (a cursor-agent chat: `gaps.cost`, "Cursor
 * doesn't record a cost for this chat"); undefined when there is a figure.
 * A row that would print "$0.00" prints "—" with this as its title.
 */
export function costGap(s: { stats?: Pick<Stats, 'cost_usd'>; gaps?: { cost?: string } }): string | undefined {
  const gap = s.gaps?.cost
  return gap && !((s.stats?.cost_usd ?? 0) > 0) ? gap : undefined
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

/**
 * The "Cost, cumulative" line and its caption. From the daemon's series when
 * it sends one: that runs over the whole session and ends at the Cost tile's
 * figure. Drawn from the events loaded instead it read $0.00 flat on a Cursor
 * chat, whose whole cost sits on one reconciled row (ADR-095) that later
 * work had pushed out of the window. An older daemon sends no series, and
 * the loaded turns stand in, as before.
 */
export function costLine(
  series: CostSeries | undefined,
  events: Pick<Event, 'kind' | 'cost_usd' | 'tokens'>[],
  unpricedTurns = 0,
): { values: number[]; caption: string } {
  if (!series) {
    let acc = 0
    const values = events.filter((e) => e.kind === 'turn.assistant').map((e) => (acc += e.cost_usd ?? 0))
    return { values: values.length ? values : [0, 0], caption: cumulativeCaption(events) }
  }
  // The line starts from nothing, so a session priced once still rises.
  const values = [0, ...series.points.map((p) => p.usd)]
  const sum = series.points.length ? series.points[series.points.length - 1]!.usd : 0
  const priced = series.priced_turns
  const unpriced = Math.max(0, unpricedTurns)
  if (priced === 0 && !(sum > 0)) {
    const caption = unpriced > 0 ? `${unpriced} turn${unpriced === 1 ? '' : 's'} · price unknown` : '0 priced turns · $0.00'
    return { values: values.length > 1 ? values : [0, 0], caption }
  }
  // Cursor's and Hermes's usage records carry money and are nobody's turn.
  const head = priced > 0 ? `${priced} priced turn${priced === 1 ? '' : 's'} · ${fmtUSD(sum)}` : `${fmtUSD(sum)} · from the agent's usage totals`
  return { values, caption: unpriced > 0 ? `${head} · + ${unpriced} unpriced` : head }
}
