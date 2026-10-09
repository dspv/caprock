import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import type { Week } from './api'
import { addDays, biggestSentence, compact, crew, dayBars, headline, loopSentence, money, periodWords, rangeLabel, sideStats, tally, weekWord } from './week'
import { WeekCard } from '@/components/WeekCard'

function week(over: Partial<Week> = {}): Week {
  return {
    start: '2026-09-27', end: '2026-10-03', partial: false, from_ms: 0, to_ms: 0,
    days: Array.from({ length: 7 }, (_, i) => ({ day: addDays('2026-09-27', i), prs_opened: 0, cost_usd: 0, active: false })),
    sessions: 0, active_days: 0, turns: 0, cost_usd: 0, models: [],
    prs_opened: 0, prs_merged: 0, merges_unresolved: 0, commits: 0, files_edited: 0, lines_added: 0, lines_removed: 0,
    ci_wait_ms: 0, tool_ms: 0, agents: [], estimates: [],
    ...over,
  }
}

const busy = week({
  sessions: 12, active_days: 6, turns: 7349, cost_usd: 474.4,
  prs_opened: 131, prs_merged: 126, commits: 235, files_edited: 161, lines_added: 13_800,
  ci_wait_ms: 8.2 * 3_600_000, cost_per_merged_pr: 3.765, tax: { tax_usd: 287.1, cost_usd: 474.4, share: 60.5 },
  agents: [
    { agent: 'claude', subagent: false, turns: 3490, cost_usd: 293.09, sessions: 4 },
    { agent: 'claude', subagent: true, turns: 3175, cost_usd: 138.21, sessions: 1, threads: 97 },
    { agent: 'codex', subagent: false, turns: 623, cost_usd: 36.87, sessions: 6 },
    { agent: 'codex', subagent: true, turns: 61, cost_usd: 6.22, sessions: 1, threads: 5 },
  ],
  loop: { agent: 'codex', tool: 'exec', kind: 'poll', calls: 10, first_ms: 0, last_ms: 72_000 },
  biggest: { agent: 'claude', cost_usd: 431.04, turns: 6659, active_days: 5 },
  estimates: ['lines_added', 'lines_removed', 'cost_per_merged_pr'],
})

describe('week card wording', () => {
  it('leads with merged PRs and marks every estimate', () => {
    const h = headline(busy, 'this week')
    expect(`${h.lead} ${h.figure} ${h.tail}`).toBe('My agents shipped 126 PRs this week.')
    expect(tally(busy, h.led).map((t) => `${t.approx ? '≈' : ''}${t.value} ${t.label}`))
      .toEqual(['131 opened', '235 commits', '161 files', '≈13.8k lines'])
    expect(sideStats(busy)).toEqual([
      { value: '$474', label: 'at API list price' },
      { value: '$3.77', label: 'per merged PR', approx: true },
      { value: '61%', label: 'of it re-reading context' },
    ])
  })

  it('never makes a zero the headline', () => {
    const noPRs = week({ sessions: 3, active_days: 2, turns: 400, cost_usd: 12, commits: 4, files_edited: 9, lines_added: 300 })
    expect(headline(noPRs, 'this week').figure).toBe('4 commits')
    const onlySessions = week({ sessions: 2, turns: 50, cost_usd: 1 })
    expect(headline(onlySessions, 'that week').figure).toBe('2 sessions')
    // Nothing merged: no cost per PR, and the free slot goes to a measured count.
    expect(sideStats(onlySessions).map((s) => s.label)).toEqual(['at API list price', 'turns'])
    expect(headline(week(), 'this week').led).toBe('none')
  })

  it('folds an agent’s own sub-agents into it, but keeps Claude Code’s as their own character', () => {
    const c = crew(busy)
    expect(c.map((m) => m.name)).toEqual(['Claude Code', '97 subagents', 'Codex'])
    expect(c[0]).toMatchObject({ who: 'lead', turns: 3490, bit: '8.2 h watching CI' })
    expect(c[2]).toMatchObject({ who: 'codex', turns: 684, bitLong: '6 sessions, 5 sub-agents of its own.' })
  })

  it('describes the loop and the biggest session without naming anything', () => {
    expect(loopSentence(busy.loop!)).toEqual({ what: 'Codex kept asking “done yet?”', count: '10× in 72 s' })
    expect(biggestSentence(busy)).toEqual({ lead: 'One Claude Code session, five days,', cost: '$431', share: '91% of the week.' })
  })

  it('formats for a card', () => {
    expect(compact(13_812)).toBe('13.8k')
    expect(compact(1_250)).toBe('1.3k')
    expect(money(474.4)).toBe('$474')
    expect(money(0.035)).toBe('4¢')
    expect(rangeLabel('2026-09-27', '2026-10-03')).toBe('Sep 27 – Oct 3, 2026')
    expect(weekWord(busy, '2026-10-04')).toBe('this week')
    expect(weekWord(busy, '2026-10-20')).toBe('that week')
  })

  it('renders both layouts with only measured figures', () => {
    for (const layout of ['land', 'port'] as const) {
      const { container, unmount } = render(<WeekCard week={busy} layout={layout} when="this week" />)
      const text = container.textContent ?? ''
      expect(text).toContain('126 PRs')
      expect(text).toContain('≈$3.77')
      expect(text).toContain('measured locally')
      expect(text).toContain('≈ = estimate · API list prices, not a bill')
      expect(text).toContain("caprock.dev · What's yours?")
      unmount()
    }
  })

  it('speaks about any period, and folds a long one into weeks or months', () => {
    expect(periodWords('today')).toEqual({ when: 'today', noun: 'day' })
    expect(periodWords('30d').when).toBe('this month')
    expect(headline(busy, periodWords('all').when, 'total').tail).toBe('— all time.')
    expect(headline(week(), 'today', 'day').lead).toBe('A quiet day:')
    expect(biggestSentence(busy, 'month')!.share).toBe('91% of the month.')

    // Thirty days fold into weeks counted back from the last day, so the
    // newest column is whole and the oldest is the two days left over.
    const month = week({
      start: '2026-09-05', end: '2026-10-04', prs_opened: 30,
      days: Array.from({ length: 30 }, (_, i) => ({ day: addDays('2026-09-05', i), prs_opened: 1, cost_usd: 1, active: true })),
    })
    const m = dayBars(month)
    expect(m.label).toBe('PRs opened per week')
    expect(m.values).toEqual([2, 7, 7, 7, 7])
    expect(m.values.reduce((a, b) => a + b, 0)).toBe(30)
    expect(m.ticks[0]).toBe('Sep 5')

    // Longer than five weeks: calendar months, summed, nothing averaged.
    const year = week({
      start: '2026-08-30', end: '2026-10-04', cost_usd: 36,
      days: Array.from({ length: 36 }, (_, i) => ({ day: addDays('2026-08-30', i), prs_opened: 0, cost_usd: 1, active: true })),
    })
    const y = dayBars(year)
    expect(y.label).toBe('Cost per month')
    expect(y.values).toEqual([2, 30, 4])
    expect(y.ticks).toEqual(['Aug', 'Sep', 'Oct'])

    expect(dayBars(busy).values).toHaveLength(7)
  })

  it('draws a one-day card without a bar strip', () => {
    const day = week({
      start: '2026-10-04', end: '2026-10-04', sessions: 2, active_days: 1, turns: 40, cost_usd: 12, prs_opened: 3, prs_merged: 2,
      days: [{ day: '2026-10-04', prs_opened: 3, cost_usd: 12, active: true }],
    })
    const { container } = render(<WeekCard week={day} layout="port" when="today" noun="day" />)
    expect(container.textContent).toContain('My agents shipped 2 PRs today.')
    expect(container.querySelector('.wk-barrow')).toBeNull()
  })
})
