/**
 * The Pipeline's two agent figures (.ai/04-ui.md § Pipeline; owner,
 * 2026-10-15, translated: "In Pipeline I'm missing the cost of an hour of
 * work … I'd also like to see roughly the size of this agent team on a
 * chart: how many there are and were"), from GET /v1/pipeline/agents. Pure.
 *
 * **Cost per hour** is what an active agent-hour costs, at API list price:
 * a session's clock hour with five or more priced calls is an hour of work
 * (the burn's own rule, store.UsualMinCalls), and the rate is what those
 * hours cost over how many there were. The big figure is the last 24
 * hours, set against the 14×24 hours before them, pooled — a mean against
 * a mean, as the cockpit's chart sets its bars against the usual's mean.
 * Per agent-hour rather than per wall-clock hour: four agents at once are
 * four hours of work, not one hour four times as dear; how many ran at
 * once is the team figure's to say. The wall-clock rate is in the hint.
 *
 * **Agent team** is every main session and subagent with a turn, counted
 * once a day, like contributors; "now" is the last ten minutes.
 *
 * Measured only (rule 6): with fewer than FLOW_MIN_DAYS days of work in
 * the window there is no comparison, "not enough history".
 */
import type { RateSpan, RepoAgents, TeamDay } from './api'
import { FLOW_MIN_DAYS } from './flowtrend'
import { NEAR } from './trend'
import { fmtTokens, fmtUSD } from './format'

/** $/h over a span's active agent-hours; undefined with none. */
export function perHour(s: RateSpan | undefined): number | undefined {
  return s && s.active_hours > 0 ? s.active_cost_usd / s.active_hours : undefined
}

/** Tokens per active agent-hour; undefined with none. */
export function tokensPerHour(s: RateSpan | undefined): number | undefined {
  return s && s.active_hours > 0 ? s.active_tokens / s.active_hours : undefined
}

/** $ per wall-clock hour with any agent at work; undefined with none. */
export function perWallHour(s: RateSpan | undefined): number | undefined {
  return s && s.wall_hours > 0 ? s.cost_usd / s.wall_hours : undefined
}

export type RateCompare =
  | { kind: 'thin'; days: number }
  | { kind: 'quiet'; usual: number }
  | { kind: 'usual' | 'above' | 'below'; now: number; usual: number; ratio: number }

/** The last 24 hours against the usual before them. */
export function rateCompare(a: RepoAgents): RateCompare {
  const u = a.rate.usual
  const days = u?.days ?? 0
  const usual = perHour(u)
  if (usual === undefined || days < FLOW_MIN_DAYS) return { kind: 'thin', days }
  const now = perHour(a.rate.last24)
  if (now === undefined) return { kind: 'quiet', usual }
  const ratio = now / usual
  return { kind: Math.abs(ratio - 1) < NEAR ? 'usual' : ratio > 1 ? 'above' : 'below', now, usual, ratio }
}

/** "35%", "2.4×": the size of a difference. */
function sizeText(ratio: number): string {
  if (ratio >= 2) return `${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}×`
  return `${Math.round(Math.abs(ratio - 1) * 100)}%`
}

/** The caption under the line: "▲ 35% vs 14-day avg". */
export function rateWord(c: RateCompare, days: number): string {
  switch (c.kind) {
    case 'thin': return 'not enough history'
    case 'quiet': return 'no hour of work in 24h'
    case 'usual': return `≈ ${days}-day avg`
    case 'above': return `▲ ${sizeText(c.ratio)} vs ${days}-day avg`
    case 'below': return `▼ ${sizeText(c.ratio)} vs ${days}-day avg`
  }
}

/** Hovering the caption: what the last 24 hours are set against. */
export function rateCompareTitle(c: RateCompare, a: RepoAgents): string {
  const u = a.rate.usual
  if (c.kind === 'thin') return `Not enough history: ${c.days} of the previous ${a.days} days had an hour of agent work; a comparison needs ${FLOW_MIN_DAYS}`
  const base = `${fmtUSD(perHour(u))}/h over ${u?.active_hours ?? 0} agent-hours in the ${a.days} days before the last 24 hours`
  if (c.kind === 'quiet') return `No agent-hour in the last 24 hours. The ${a.days}-day average: ${base}`
  return `${fmtUSD(c.now)}/h over ${a.rate.last24.active_hours} agent-hours in the last 24 hours, against ${base}`
}

/** One day of the rate's line, on hover. */
export function rateDayTitle(d: RateSpan & { day: string }, isToday: boolean): string {
  const when = dayName(d.day, isToday)
  const r = perHour(d)
  if (r === undefined) return d.cost_usd > 0 ? `${when} · no full hour of work (${fmtUSD(d.cost_usd)} in passing)` : `${when} · no agent at work`
  return `${when} · ${fmtUSD(r)}/h over ${plural(d.active_hours, 'agent-hour')}, ${fmtUSD(d.cost_usd)} in all${isToday ? ' so far' : ''}`
}

/** The secondary line: tokens an agent-hour and in all, the last 24 hours. */
export function rateTokensText(a: RepoAgents): string {
  const l = a.rate.last24
  const t = tokensPerHour(l)
  return t === undefined ? `${fmtTokens(l.tokens)} tokens · 24h` : `${fmtTokens(t)} tok/h · ${fmtTokens(l.tokens)} in 24h`
}

// ---------------------------------------------------------------- the team

/** The agent kinds by their own names. */
export const KIND_NAME: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', gemini: 'Gemini', cursor: 'Cursor' }

export const teamOf = (d: TeamDay) => d.sessions + d.subagents

export interface TeamUsual {
  /** Days in the window with any agent at work. */
  days: number
  /** Mean distinct agents over those days. */
  avg: number
  /** The most distinct agents in one day, and the day. */
  peak: number
  peakDay?: string
}

/** The previous `days` days' team, today excluded; undefined when too few days had anyone. */
export function teamUsual(series: readonly TeamDay[], days: number): TeamUsual | { days: number; thin: true } {
  const prior = series.slice(0, -1).slice(-days)
  const worked = prior.filter((d) => teamOf(d) > 0)
  if (worked.length < FLOW_MIN_DAYS) return { days: worked.length, thin: true }
  let peak = worked[0]!
  for (const d of worked) if (teamOf(d) > teamOf(peak)) peak = d
  return { days: worked.length, avg: worked.reduce((s, d) => s + teamOf(d), 0) / worked.length, peak: teamOf(peak), peakDay: peak.day }
}

/** The team card's caption: "avg 24 · peak 66" (the tile is narrow; its hint and the caption's title say the window). */
export function teamWord(u: ReturnType<typeof teamUsual>): string {
  if ('thin' in u) return 'not enough history'
  return `avg ${u.avg < 10 ? u.avg.toFixed(1) : Math.round(u.avg)} · peak ${u.peak}`
}

/** One day of the team, on hover: the count and the split by agent kind. */
export function teamDayTitle(d: TeamDay, isToday: boolean): string {
  const when = dayName(d.day, isToday)
  if (teamOf(d) === 0) return `${when} · no agent at work`
  const kinds = Object.entries(d.by_kind ?? {})
    .sort((a, b) => b[1].sessions + b[1].subagents - (a[1].sessions + a[1].subagents))
    .map(([k, c]) => `${KIND_NAME[k] ?? k} ${c.sessions}${c.subagents ? ` + ${c.subagents} sub` : ''}`)
  return `${when} · ${plural(teamOf(d), 'agent')}: ${plural(d.sessions, 'session')}, ${plural(d.subagents, 'subagent')} · at most ${d.peak} at once${kinds.length ? `\n${kinds.join(' · ')}` : ''}`
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function dayName(day: string, isToday: boolean): string {
  if (isToday) return 'Today'
  const [y, mo, da] = day.split('-').map(Number)
  return new Date(y!, (mo ?? 1) - 1, da ?? 1).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
}
