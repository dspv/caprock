import { describe, expect, it } from 'vitest'
import type { TrendDay, Trends } from './api'
import { compare, compareTitle, compareWord, cutClock, median, trendPoints } from './trend'

function day(i: number, over: Partial<TrendDay> = {}): TrendDay {
  return { day: `2026-10-${String(i).padStart(2, '0')}`, cost_usd: 0, sessions: 0, turns: 0, tool_calls: 0, active: false, ...over }
}

/** Fourteen previous days with the given costs (undefined = a day off), and today. */
function trends(costs: (number | undefined)[], today: Partial<TrendDay> = {}, burn?: Trends['burn']): Trends {
  const series = costs.map((c, i) => day(i + 1, c === undefined ? {} : { cost_usd: c, turns: c * 10, sessions: 2, active: true, burn_usd_per_hour: c / 10 }))
  series.push(day(costs.length + 1, { active: true, ...today }))
  return { days: costs.length, cut_min: 18 * 60 + 40, series, burn }
}

const WEEK = [100, 100, undefined, undefined, 80, 120, 100, 100, 90, undefined, undefined, 110, 100, 100]

describe('compare', () => {
  it('sets today against the median of the days with work, not the days off', () => {
    const c = compare(trends(WEEK), 'cost', 138)
    // Ten working days, median $100; the four days off are not a usual of $0.
    expect(c).toMatchObject({ kind: 'above', usual: 100, days: 10 })
    expect(compareWord(c!)).toBe('above usual +38%')
  })

  it('says usual within ±15%, below beneath it, and × past double', () => {
    expect(compareWord(compare(trends(WEEK), 'cost', 110)!)).toBe('usual')
    expect(compareWord(compare(trends(WEEK), 'cost', 80)!)).toBe('below usual −20%')
    expect(compareWord(compare(trends(WEEK), 'cost', 240)!)).toBe('above usual 2.4×')
  })

  it('has no usual with fewer than five working days', () => {
    const c = compare(trends([undefined, 100, undefined, 50, 70, 80, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined]), 'cost', 120)
    expect(c).toEqual({ kind: 'thin', days: 4 })
    expect(compareWord(c!)).toBe('not enough history')
  })

  it('compares burn now with the usual window, and says idle when nothing runs', () => {
    const t = trends(WEEK, {}, { median_usd_per_hour: 14, windows: 900, days: 10 })
    expect(compareWord(compare(t, 'burn', 21)!)).toBe('above usual +50%')
    expect(compare(t, 'burn', 0)?.kind).toBe('idle')
    expect(compare(trends(WEEK), 'burn', 21)?.kind).toBe('thin')
    expect(compareTitle(compare(t, 'burn', 21)!, 'burn', t, (n) => `$${n}`)).toContain('vs your 14-day median: $14/h')
  })

  it('names the cut and the basis on hover', () => {
    const t = trends(WEEK)
    expect(compareTitle(compare(t, 'cost', 138)!, 'cost', t, (n) => `$${n}`)).toBe('$138 today · vs your 14-day median: $100 by 18:40, on the 10 days with any work')
  })

  it('gives cache a line but no word', () => {
    expect(compare(trends(WEEK), 'cache', 98)).toBeUndefined()
  })

  it('reads anything above a usual of nothing as above, with no percentage', () => {
    // Ten working days, none with a turn by this hour.
    const c = compare(trends(WEEK.map((v) => (v === undefined ? v : 0))), 'turns', 5)
    expect(compareWord(c!)).toBe('above usual')
  })
})

describe('trendPoints', () => {
  it('draws today from the live figure, except for burn', () => {
    const t = trends(WEEK, { cost_usd: 50, burn_usd_per_hour: 9 })
    expect(trendPoints(t, 'cost', 60).at(-1)).toBe(60)
    expect(trendPoints(t, 'burn', 60).at(-1)).toBe(9)
    expect(trendPoints(t, 'burn')[2]).toBeUndefined() // a day off has no rate
  })
})

it('median and clock', () => {
  expect(median([3, 1, 2])).toBe(2)
  expect(median([4, 1, 2, 3])).toBe(2.5)
  expect(cutClock(9 * 60 + 5)).toBe('09:05')
})
