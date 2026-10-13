import { describe, expect, it } from 'vitest'
import { fmtUSD } from './format'
import type { SpendBar, SpendFigures } from './spendview'
import { arrow, barPace, deltaText, paceLabel, paceOf, paceSentence, paceTitle, percentileOf, tone, versus, versusTitle, type Pace, type Usual } from './usual'

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

describe('the chart’s pace line', () => {
  const H = 3_600_000
  const bar = (i: number, p: Partial<SpendBar>): SpendBar => ({ start: i * H, end: (i + 1) * H, cost: 0, ...p })

  it('draws burn rate against the 30-day mean active session-hour, or the period’s own rate without one', () => {
    const bars = [bar(0, { activeHours: 1, activeCost: 6 }), bar(1, { activeHours: 0, activeCost: 0 }), bar(2, { activeHours: 2, activeCost: 3 })]
    // A bar is a mean of its hours, so the line is the mean, not the median ($1 here).
    const p = paceOf('burn', bars, usual(3, { burn: { ...dist(1), mean: 3 } }))!
    expect(p).toMatchObject({ value: 3, kind: 'usual' })
    expect(paceLabel('burn', p)).toBe('usual $3.00/h')
    expect(paceTitle('burn', p, 30)).toBe('Your usual, $3.00/h: every active session-hour’s cost over every active hour, 30 days')
    // Too few hours for a usual: the period's own, every active hour's cost over every active hour.
    const own = paceOf('burn', bars, usual(3, { burn: { ...dist(3, 12), mean: 5 } }))!
    expect(own).toMatchObject({ value: 3, kind: 'avg' })
    expect(paceLabel('burn', own)).toBe('avg $3.00/h')
    expect(paceOf('burn', bars, undefined)).toMatchObject({ value: 3, kind: 'avg' })
    // An older daemon sends no mean: the period's own rate, never the median in its place.
    expect(paceOf('burn', bars, usual(5))).toMatchObject({ value: 3, kind: 'avg' })
  })

  it('draws cost, tokens and turns against the average stretch with any activity, and nothing for one stretch', () => {
    const bars = [bar(0, { cost: 2, tokens: 1_000_000 }), bar(1, { cost: 0, tokens: 0 }), bar(2, { cost: 4, tokens: 2_000_000 })]
    // The idle stretch is left out of the average: (2 + 4) / 2.
    expect(paceOf('cost', bars, usual(3))).toEqual({ value: 3, kind: 'avg' })
    expect(paceLabel('tokens', paceOf('tokens', bars, usual(3))!)).toBe('avg 1.50M')
    expect(paceOf('cost', [bars[0]!, bars[1]!], usual(3))).toBeUndefined()
    // An older daemon's bars without turns: no line.
    expect(paceOf('turns', bars, undefined)).toBeUndefined()
  })

  it('says where a bar stands: above or below, and amber only in the top fifth of a usual', () => {
    const u: Pace = { value: 3, kind: 'usual', dist: dist(3) }
    expect(paceSentence(4.14, u)).toBe('38% above your usual')
    expect(paceSentence(1.35, u)).toBe('55% below your usual')
    expect(paceSentence(3.2, u)).toBe('about your usual')
    expect(paceSentence(7.2, u)).toBe('2.4× your usual')
    expect(paceSentence(36, u)).toBe('12× your usual')
    expect(paceSentence(undefined, u)).toBeUndefined()
    expect(paceSentence(5, { value: 4, kind: 'avg' })).toBe('25% above the average')
    // The short form the chart's top line has room for.
    expect(paceSentence(4.14, u, true)).toBe('38% above usual')
    expect(paceSentence(1, { value: 4, kind: 'avg' }, true)).toBe('75% below avg')
    expect(paceSentence(3.2, u, true)).toBe('about usual')
    // The 80th percentile of this shape is 3.7× the median: $11.10/h.
    expect(barPace(4.14, u)).toBe('above')
    expect(barPace(9, u)).toBe('above')
    expect(barPace(12, u)).toBe('high')
    expect(barPace(2, u)).toBe('below')
    expect(barPace(undefined, u)).toBeUndefined()
    // An average has no distribution: never amber, however high.
    expect(barPace(40, { value: 3, kind: 'avg' })).toBe('above')
  })
})
