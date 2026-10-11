import { describe, expect, it } from 'vitest'
import { burnRate, cellsFor, foldedLine, normalizeSpendPrefs, periodFigures, periodScope, type SpendFigures } from './spendview'
import type { CallPoint } from './scrub'
import type { Summary } from './api'

const call = (id: number, ts: number, cost: number): CallPoint => ({ id, ts, cost })
const H = 3_600_000

describe('the spend figures', () => {
  it('never repeats the headline in the cells', () => {
    expect(cellsFor('cost')).toEqual(['turns', 'tools', 'tokens', 'cache'])
    expect(cellsFor('turns')).toEqual(['cost', 'tools', 'tokens', 'cache'])
    for (const h of ['cost', 'burn', 'tokens', 'turns', 'cache', 'time'] as const) {
      expect(cellsFor(h)).not.toContain(h)
      expect(cellsFor(h)).toHaveLength(4)
    }
  })

  it('measures the burn rate over the hour ending at the newest call', () => {
    const t = 10 * H
    // $5 more than an hour before the newest call is outside the window.
    expect(burnRate([call(1, t - 2 * H, 5), call(2, t - 30 * 60_000, 1), call(3, t, 2)], t - 3 * H)).toEqual({ perHour: 3, minutes: 60 })
    // A 30-minute-old session: $2 over half an hour is $4 an hour.
    expect(burnRate([call(1, t - 30 * 60_000, 1), call(2, t, 1)], t - 30 * 60_000)).toEqual({ perHour: 4, minutes: 30 })
    // Two calls a second apart are measured over five minutes, not one second.
    expect(burnRate([call(1, t - 1000, 1), call(2, t, 1)])).toEqual({ perHour: 24, minutes: 5 })
    expect(burnRate([call(1, t, 1)])).toBeUndefined()
  })

  it('folds to one line with the headline first', () => {
    const f: SpendFigures = { cost: 12.4, turns: 48, timeMs: 72 * 60_000, burn: { perHour: 4.1, minutes: 60 } }
    expect(foldedLine('cost', f)).toBe('Spent $12.40 · 48 turns · 1h 12m')
    expect(foldedLine('burn', f)).toBe('$4.10/h · spent $12.40 · 48 turns')
    expect(foldedLine('turns', { cost: 1, turns: 1 })).toBe('1 turn · spent $1.00')
  })

  it('reads stored choices field by field, folded by default', () => {
    expect(normalizeSpendPrefs(undefined)).toEqual({ folded: true, headline: 'cost', chart: false, view: 'compact', period: 'session' })
    expect(normalizeSpendPrefs({ folded: false, headline: 'nope', chart: true, view: 'full', period: '7d' }))
      .toEqual({ folded: false, headline: 'cost', chart: true, view: 'full', period: '7d' })
    expect(normalizeSpendPrefs({ view: 'tiny', period: '90d' })).toMatchObject({ view: 'compact', period: 'session' })
  })

  it('takes the compact figures from the session, or from the range summary', () => {
    const f: SpendFigures = { cost: 2, tokens: 1_000, cache: 80 }
    const calls = [call(1, H, 1), call(2, 2 * H, 1)]
    const own = periodFigures('session', f, calls, undefined)
    expect(own).toMatchObject({ cost: 2, tokens: 1_000, cache: 80 })
    expect(own.series.length).toBeGreaterThan(1)
    expect(periodFigures('7d', f, calls, undefined)).toEqual({ series: [] })
    const sum = {
      cost_usd: 9, tokens_in: 10, cache_read: 30, cache_write: 0, savings: { hit_rate: 0.75 },
      projects: [{ spark: { cost: [1, 0, 2] } }, { spark: { cost: [0, 4] } }, {}],
    } as unknown as Summary
    expect(periodFigures('today', f, calls, sum)).toEqual({ cost: 9, tokens: 40, cache: 75, series: [1, 4, 2] })
    expect(periodScope('session')).toBe('This session')
    expect(periodScope('30d')).toBe('30 days · all sessions')
  })
})
