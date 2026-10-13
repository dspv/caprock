import { describe, expect, it } from 'vitest'
import { fmtUSD } from './format'
import type { SpendFigures } from './spendview'
import { arrow, deltaText, percentileOf, tone, versus, versusTitle, type Usual } from './usual'

/** A measured shape (multiples of the median), scaled to a median. */
const SHAPE = [0.003, 0.03, 0.08, 0.22, 0.56, 1, 1.65, 2.6, 3.7, 6, 22.7]
const dist = (median: number, n = 362) => ({ n, q: SHAPE.map((k) => k * median) })
const usual = (median: number, extra: Partial<Usual> = {}): Usual => ({ days: 30, burn: dist(median), cost: dist(median, 58), tokens: dist(median, 58), cache: 97.4, ...extra })
const figs = (p: Partial<SpendFigures> = {}): SpendFigures => ({ cost: 10, burn: { perHour: 4.14, minutes: 60 }, tokens: 5_000_000, cache: 95, ...p })

describe('percentileOf', () => {
  it('interpolates inside a decile and clamps at the ends', () => {
    const q = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
    expect(percentileOf(55, q)).toBe(55)
    expect(percentileOf(-1, q)).toBe(0)
    expect(percentileOf(1000, q)).toBe(100)
  })
})

describe('versus', () => {
  it('reads above as a percentage and well above as a multiple, amber only in the top fifth', () => {
    const above = versus('burn', figs(), usual(3))!
    expect(arrow(above)).toBe('▲')
    expect(deltaText(above)).toBe('38%')
    expect(tone(above)).toBe('none')
    const far = versus('burn', figs({ burn: { perHour: 13.5, minutes: 60 } }), usual(3))!
    expect(deltaText(far)).toBe('4.5×')
    expect(far.pct).toBeGreaterThan(80)
    expect(tone(far)).toBe('warn')
  })

  it('reads near as about usual, and below muted', () => {
    const near = versus('burn', figs({ burn: { perHour: 3.12, minutes: 60 } }), usual(3))!
    expect(near.near).toBe(true)
    expect(arrow(near)).toBe('≈')
    const below = versus('burn', figs({ burn: { perHour: 1.35, minutes: 60 } }), usual(3))!
    expect(arrow(below)).toBe('▼')
    expect(deltaText(below)).toBe('55%')
    expect(tone(below)).toBe('none')
  })

  it('compares tokens and cost with the median session', () => {
    const t = versus('tokens', figs({ tokens: 6_900_000 }), usual(5_000_000))!
    expect(deltaText(t)).toBe('38%')
    expect(versus('cost', figs({ cost: 3 }), usual(6))!.delta).toBeCloseTo(-0.5)
  })

  it('compares the cache rate in points, amber from three under', () => {
    const c = versus('cache', figs({ cache: 88.4 }), usual(3))!
    expect(deltaText(c)).toBe('9 pts')
    expect(arrow(c)).toBe('▼')
    expect(tone(c)).toBe('warn')
    expect(deltaText(versus('cache', figs({ cache: 97.9 }), usual(3))!)).toBe('0.5 pts')
  })

  it('has nothing to say for a new user, too few samples, or a metric with no usual', () => {
    expect(versus('burn', figs(), undefined)).toBeUndefined()
    expect(versus('burn', figs(), usual(3, { burn: dist(3, 19) }))).toBeUndefined()
    expect(versus('cost', figs(), usual(3, { cost: dist(3, 7) }))).toBeUndefined()
    expect(versus('burn', figs({ burn: undefined }), usual(3))).toBeUndefined()
    expect(versus('cache', figs(), usual(3, { cache: undefined }))).toBeUndefined()
    for (const m of ['turns', 'time', 'tools', 'last'] as const) expect(versus(m, figs(), usual(3))).toBeUndefined()
  })
})

describe('versusTitle', () => {
  it('says how far, from what, on what basis, and where among your own', () => {
    expect(versusTitle(versus('burn', figs(), usual(3))!, fmtUSD, 30))
      .toBe('38% above your usual $3.00/h (the median active session-hour, 30 days) · higher than 56% of your session-hours')
    expect(versusTitle(versus('burn', figs({ burn: { perHour: 13.5, minutes: 60 } }), usual(3))!, fmtUSD, 30))
      .toMatch(/^4\.5× your usual \$3\.00\/h .* · higher than 8\d% of your session-hours$/)
    expect(versusTitle(versus('cost', figs({ cost: 3.12 }), usual(3))!, fmtUSD, 30))
      .toBe('About your median session, $3.00 (30 days) · already more than 51% of your sessions')
    expect(versusTitle(versus('cache', figs({ cache: 88.4 }), usual(3))!, fmtUSD, 30)).toBe('9 pts below your 30-day hit rate of 97.4%')
  })
})
