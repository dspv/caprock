import { describe, expect, it } from 'vitest'
import type { RateSpan, RepoAgents, TeamDay } from './api'
import { perHour, perWallHour, rateCompare, rateWord, teamDayTitle, teamUsual, teamWord, tokensPerHour } from './repoagents'

const span = (p: Partial<RateSpan> = {}): RateSpan => ({ cost_usd: 0, active_hours: 0, active_cost_usd: 0, tokens: 0, active_tokens: 0, wall_hours: 0, ...p })
const agents = (last24: RateSpan, usual?: RateSpan): RepoAgents => ({
  days: 14, rate: { last24, usual, series: [] }, team: { now: { sessions: 0, subagents: 0 }, peak_today: 0, series: [] },
})
const day = (d: string, sessions: number, subagents: number, by_kind?: TeamDay['by_kind']): TeamDay => ({ day: d, sessions, subagents, peak: sessions + subagents, by_kind })

describe('cost per agent-hour', () => {
  it('is the active hours’ cost over their count, never the passing spend', () => {
    const s = span({ cost_usd: 11, active_hours: 2, active_cost_usd: 10, tokens: 11000, active_tokens: 10000, wall_hours: 1 })
    expect(perHour(s)).toBe(5)
    expect(tokensPerHour(s)).toBe(5000)
    expect(perWallHour(s)).toBe(11)
    expect(perHour(span({ cost_usd: 3 }))).toBeUndefined()
  })
  it('sets the last 24 hours against the usual, with an arrow and a percentage', () => {
    const c = rateCompare(agents(span({ active_hours: 1, active_cost_usd: 6.75 }), span({ active_hours: 20, active_cost_usd: 100, days: 5 })))
    expect(c.kind).toBe('above')
    expect(rateWord(c, 14)).toBe('▲ 35% vs 14-day avg')
    expect(rateWord(rateCompare(agents(span({ active_hours: 1, active_cost_usd: 2.5 }), span({ active_hours: 2, active_cost_usd: 10, days: 3 }))), 14)).toBe('▼ 50% vs 14-day avg')
    expect(rateWord(rateCompare(agents(span({ active_hours: 1, active_cost_usd: 5.2 }), span({ active_hours: 2, active_cost_usd: 10, days: 3 }))), 14)).toBe('≈ 14-day avg')
  })
  it('says not enough history below three days of work, and says a quiet day', () => {
    expect(rateWord(rateCompare(agents(span({ active_hours: 1, active_cost_usd: 5 }), span({ active_hours: 9, active_cost_usd: 10, days: 2 }))), 14)).toBe('not enough history')
    expect(rateWord(rateCompare(agents(span({ active_hours: 1, active_cost_usd: 5 }))), 14)).toBe('not enough history')
    expect(rateWord(rateCompare(agents(span(), span({ active_hours: 9, active_cost_usd: 10, days: 4 }))), 14)).toBe('no hour of work in 24h')
  })
})

describe('agent team', () => {
  it('averages over the days anyone worked, today excluded, with the busiest day', () => {
    const s = [day('2026-10-10', 0, 0), day('2026-10-11', 1, 3), day('2026-10-12', 2, 8), day('2026-10-13', 1, 1), day('2026-10-14', 9, 90)]
    const u = teamUsual(s, 14)
    expect(u).toEqual({ days: 3, avg: 16 / 3, peak: 10, peakDay: '2026-10-12' })
    expect(teamWord(u)).toBe('avg 5.3 · peak 10')
  })
  it('says not enough history below three working days', () => {
    expect(teamWord(teamUsual([day('a', 1, 0), day('b', 1, 0), day('c', 5, 5)], 14))).toBe('not enough history')
  })
  it('names each agent kind in a day’s hover', () => {
    const t = teamDayTitle(day('2026-10-13', 2, 3, { claude: { sessions: 1, subagents: 3 }, codex: { sessions: 1, subagents: 0 } }), true)
    expect(t).toBe('Today · 5 agents: 2 sessions, 3 subagents · at most 5 at once\nClaude Code 1 + 3 sub · Codex 1')
  })
})
