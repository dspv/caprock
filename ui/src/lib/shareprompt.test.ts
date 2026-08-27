/**
 * A nudge that fires too often is worse than none: people stop reading the
 * banner, and then they stop reading every other banner beside it. Most of
 * these tests are about when it stays quiet.
 */
import { describe, expect, it } from 'vitest'
import { findOccasion, weeklyTotals } from './shareprompt'
import type { History, Summary } from './api'

const totals = (over: Partial<History['totals']> = {}) =>
  ({ sessions: 50, cost_usd: 3000, days: 30, turns: 1000, tool_calls: 1,
     owned_sessions: 0, files_touched: 1, avg_session_sec: 1, ...over }) as History['totals']

const week = (cost = 400) => ({ cost_usd: cost }) as Pick<Summary, 'cost_usd'>

/** `n` days of equal spend, newest first. */
const series = (perDay: number[], start = '2026-08-27') =>
  perDay.map((cost_usd, i) => {
    const d = new Date(start)
    d.setDate(d.getDate() - i)
    return { day: d.toISOString().slice(0, 10), cost_usd }
  })

describe('findOccasion', () => {
  it('says nothing on a machine that has captured nothing', () => {
    expect(findOccasion(totals({ sessions: 0, cost_usd: 0 }), [], week(0))).toBeNull()
  })

  it('calls out a round number just crossed', () => {
    const o = findOccasion(totals({ cost_usd: 1040 }), [], week())
    expect(o?.kind).toBe('milestone')
    expect(o?.line).toContain('$1,000')
  })

  it('stops mentioning a milestone once the moment has gone', () => {
    // $1,800 is past $1,000 and nowhere near $5,000. Still shouting about the
    // first is how a prompt becomes wallpaper.
    const o = findOccasion(totals({ cost_usd: 1800, days: 30 }), series([10, 10, 10]), week())
    expect(o?.kind).not.toBe('milestone')
  })

  it('marks the first full week, once', () => {
    const o = findOccasion(totals({ cost_usd: 300, days: 7 }), [], week(300))
    expect(o?.kind).toBe('first-week')
    // And not a month later.
    expect(findOccasion(totals({ cost_usd: 300, days: 30 }), [], week(300))?.kind)
      .not.toBe('first-week')
  })

  it('calls a record week only when it is clear of the last best', () => {
    // 100 against a previous best of 90 is noise; while usage grows, "highest
    // ever" is true nearly every week and the prompt would never stop.
    const narrow = series([...Array(7).fill(100 / 7), ...Array(7).fill(90 / 7), ...Array(7).fill(80 / 7)])
    expect(findOccasion(totals({ cost_usd: 270, days: 21 }), narrow, week())?.kind)
      .not.toBe('record-week')

    const clear = series([...Array(7).fill(200 / 7), ...Array(7).fill(90 / 7), ...Array(7).fill(80 / 7)])
    expect(findOccasion(totals({ cost_usd: 370, days: 21 }), clear, week())?.kind)
      .toBe('record-week')
  })

  it('needs a history before it can call anything a record', () => {
    // Two weeks in, the "previous best" is one sample. That is not a record.
    const thin = series([...Array(7).fill(50), ...Array(7).fill(1)])
    expect(findOccasion(totals({ cost_usd: 357, days: 14 }), thin, week())?.kind)
      .not.toBe('record-week')
  })

  it('prefers the rarest occasion when more than one is true', () => {
    // A milestone and a record week at once: the milestone is the specific
    // thing worth saying, the record is the fallback for everyone else.
    const clear = series([...Array(7).fill(200), ...Array(7).fill(20), ...Array(7).fill(20)])
    expect(findOccasion(totals({ cost_usd: 1040, days: 21 }), clear, week())?.kind)
      .toBe('milestone')
  })
})

describe('weeklyTotals', () => {
  it('groups days into weeks, newest first', () => {
    const w = weeklyTotals(series([...Array(7).fill(10), ...Array(7).fill(5)]))
    expect(w[0]).toBeCloseTo(70)
    expect(w[1]).toBeCloseTo(35)
  })

  it('sums repeated entries for one day', () => {
    // The daily series carries a row per project, so one date appears several
    // times — treating those as separate days would divide a week by project.
    const w = weeklyTotals([
      { day: '2026-08-27', cost_usd: 10 },
      { day: '2026-08-27', cost_usd: 15 },
    ])
    expect(w[0]).toBe(25)
  })
})
