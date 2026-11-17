import { fmtUSD } from './format'

/**
 * A model's or an agent's volume in the unit its cost was counted in.
 *
 * Cursor keeps its cost per chat and model, with how many requests it
 * counted (`usageData.amount`), and the importer stores that money on a
 * record of its own that is not a turn. Read per turn it was "$89 per turn"
 * for a model of 2,153 requests (2026-11-17). Where the agent counted
 * requests, the figure is per request; elsewhere it stays per turn.
 */
export interface Volume {
  cost_usd: number
  turns: number
  /** Requests the agent counted, where it counts them (Cursor). */
  requests?: number
  /** The part of cost_usd those requests cost; the whole cost when absent. */
  requests_cost_usd?: number
}

const n = (v: number) => v.toLocaleString('en-US')

/** "2,153 requests" where the agent counted requests, else "41 turns". */
export function volumeCount(v: Volume): string {
  if (v.requests && v.requests > 0) return `${n(v.requests)} ${v.requests === 1 ? 'request' : 'requests'}`
  return `${n(v.turns)} ${v.turns === 1 ? 'turn' : 'turns'}`
}

/** "$0.29/request", "$1.20/turn", or '' when there is nothing to divide by. */
export function volumeRate(v: Volume): string {
  if (v.requests && v.requests > 0) return `${fmtUSD((v.requests_cost_usd ?? v.cost_usd) / v.requests)}/request`
  if (v.turns > 0) return `${fmtUSD(v.cost_usd / v.turns)}/turn`
  return ''
}

/** "2,153 requests · $0.29/request" — the count and the rate in one line. */
export function volumeLine(v: Volume): string {
  const rate = volumeRate(v)
  return rate ? `${volumeCount(v)} · ${rate}` : volumeCount(v)
}
