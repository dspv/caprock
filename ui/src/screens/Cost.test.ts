import { describe, expect, it } from 'vitest'
import { groupDays } from './Cost'

describe('groupDays', () => {
  it('sums per day across projects and models, sorted ascending', () => {
    const out = groupDays([
      { day: '2026-08-18', project: 'a', model: 'm', tokens_total: 10, cost_usd: 1, sessions: 1 },
      { day: '2026-08-17', project: 'a', model: 'm', tokens_total: 5, cost_usd: 0.5, sessions: 1 },
      { day: '2026-08-18', project: 'b', model: 'n', tokens_total: 20, cost_usd: 2, sessions: 2 },
    ])
    expect(out.map((d) => d.day)).toEqual(['2026-08-17', '2026-08-18'])
    expect(out[1]).toEqual({ day: '2026-08-18', cost: 3, tokens: 30, sessions: 3 })
  })
})
