import { describe, expect, it } from 'vitest'
import { burnRate, foldedLine, metricValue, normalizeSlots, normalizeSpendPrefs, periodFigures, periodScope, pickSlot, shownSlots, type SpendFigures } from './spendview'
import type { CallPoint } from './scrub'
import type { Summary } from './api'

const call = (id: number, ts: number, cost: number): CallPoint => ({ id, ts, cost })
const H = 3_600_000

describe('the spend figures', () => {
  it('keeps three distinct figures, swaps on a pick, and never repeats the session headline', () => {
    expect(normalizeSlots(undefined)).toEqual(['cost', 'tokens', 'cache'])
    expect(normalizeSlots(['burn', 'burn', 'nope'])).toEqual(['burn', 'cost', 'tokens'])
    expect(normalizeSlots(['last', 'time', 'turns', 'tools'])).toEqual(['last', 'time', 'turns'])
    // Picking a figure another slot shows swaps the two.
    expect(pickSlot(['cost', 'tokens', 'cache'], 0, 'cache')).toEqual(['cache', 'tokens', 'cost'])
    expect(pickSlot(['cost', 'tokens', 'cache'], 1, 'burn')).toEqual(['cost', 'burn', 'cache'])
    // The session's headline is beside the agent already: its slot shows the next one not shown.
    expect(shownSlots(['cost', 'tokens', 'cache'], 'session', 'cost')).toEqual(['burn', 'tokens', 'cache'])
    expect(shownSlots(['cost', 'tokens', 'cache'], 'session', 'turns')).toEqual(['cost', 'tokens', 'cache'])
    // A Caprock-wide period is another figure: it keeps it.
    expect(shownSlots(['cost', 'tokens', 'cache'], '7d', 'cost')).toEqual(['cost', 'tokens', 'cache'])
    for (const h of ['cost', 'burn', 'tokens', 'turns', 'cache', 'time'] as const) {
      const shown = shownSlots(['cost', 'tokens', 'cache'], 'session', h)
      expect(shown).not.toContain(h)
      expect(new Set(shown).size).toBe(3)
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

  it('reads stored choices field by field, folded by default, and 0.111.0’s views as Numbers or Chart', () => {
    expect(normalizeSpendPrefs(undefined)).toEqual({ folded: true, headline: 'cost', view: 'numbers', period: 'session', slots: ['cost', 'tokens', 'cache'] })
    expect(normalizeSpendPrefs({ folded: false, headline: 'nope', view: 'chart', period: '7d', slots: ['turns'] }))
      .toEqual({ folded: false, headline: 'cost', view: 'chart', period: '7d', slots: ['turns', 'cost', 'tokens'] })
    // 0.111.0 stored Compact | Full: Full drew the chart, Compact the figures.
    expect(normalizeSpendPrefs({ view: 'full', chart: false }).view).toBe('chart')
    expect(normalizeSpendPrefs({ view: 'compact', chart: true }).view).toBe('numbers')
    expect(normalizeSpendPrefs({ view: 'tiny', period: '90d' })).toMatchObject({ view: 'numbers', period: 'session' })
    expect(normalizeSpendPrefs({ chart: true })).not.toHaveProperty('chart')
  })

  it('takes the figures from the session, or from the range summary with its sparks as the chart', () => {
    const f: SpendFigures = { cost: 2, tokens: 1_000, cache: 80, last: 0.25 }
    expect(periodFigures('session', f, undefined)).toBe(f)
    expect(periodFigures('7d', f, undefined)).toEqual({})
    const sum = {
      cost_usd: 9, tokens_in: 10, cache_read: 30, cache_write: 0, turns: 7, tool_calls: 21, savings: { hit_rate: 0.75 },
      projects: [{ spark: { from_ms: 1_000, width_ms: H, cost: [1, 0, 2] } }, { spark: { from_ms: 1_000, width_ms: H, cost: [0, 4] } }, {}],
    } as unknown as Summary
    const pf = periodFigures('today', f, sum)
    expect(pf).toMatchObject({ cost: 9, tokens: 40, cache: 75, turns: 7, tools: 21 })
    expect(pf.series?.step).toBe(H)
    expect(pf.series?.bars).toEqual([
      { start: 1_000, end: 1_000 + H, cost: 1 },
      { start: 1_000 + H, end: 1_000 + 2 * H, cost: 4 },
      { start: 1_000 + 2 * H, end: 1_000 + 3 * H, cost: 2 },
    ])
    // A session's own figure has no Caprock-wide value: a dash, never a zero.
    expect(metricValue('last', pf)).toBe('—')
    expect(metricValue('last', f)).toBe('$0.25')
    // No spark in the summary: no series, rather than an empty line.
    expect(periodFigures('30d', f, { ...sum, projects: [] } as Summary).series).toBeUndefined()
    expect(periodScope('session')).toBe('This session')
    expect(periodScope('30d')).toBe('30 days · all sessions')
  })
})
