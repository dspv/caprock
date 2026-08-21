/**
 * The sparkline model. The parts worth covering are the ones a reader would
 * silently misread if they broke: which array the selected measure plots, that
 * an empty bucket stays distinguishable from a small one, and that every row is
 * scaled to one shared ceiling so the pictures are comparable.
 */
import { describe, expect, it } from 'vitest'
import { buildSpark, bucketLabel, peak, seriesOf } from './spark'
import type { Spark } from './api'

const DAY = 86_400_000

function spark(cost: number[], tokens: number[]): Spark {
  return { from_ms: 1_000_000, width_ms: DAY, cost, tokens }
}

describe('seriesOf', () => {
  it('plots the array the selected measure names', () => {
    const s = spark([1, 2], [300, 400])
    expect(seriesOf(s, 'cost')).toEqual([1, 2])
    expect(seriesOf(s, 'tokens')).toEqual([300, 400])
  })

  it('is empty rather than throwing when a row has no series', () => {
    // range=all sends no spark; the row must still render.
    expect(seriesOf(undefined, 'cost')).toEqual([])
  })
})

describe('buildSpark', () => {
  it('marks a zero bucket empty and a spent bucket not, so silence is drawable', () => {
    const bars = buildSpark(spark([2, 0, 1], [20, 0, 10]), 'cost', 2)
    expect(bars.map((b) => b.empty)).toEqual([false, true, false])
    // The empty bucket must carry no height at all — the canvas draws it as a
    // hairline, which is what distinguishes it from a merely small bucket.
    expect(bars[1]!.height).toBe(0)
    expect(bars[2]!.height).toBeGreaterThan(0)
  })

  it('gives a tiny bucket a visible height rather than rounding it to silence', () => {
    // 1/1000 of the ceiling: linear scaling would make this invisible, which
    // would make "a little happened" look identical to "nothing happened".
    const bars = buildSpark(spark([1000, 1], [0, 0]), 'cost', 1000)
    expect(bars[1]!.empty).toBe(false)
    expect(bars[1]!.height).toBeGreaterThan(0.01)
    expect(bars[0]!.height).toBe(1)
  })

  it('scales every row to the SHARED ceiling, not to its own maximum', () => {
    // A quiet project drawn against a loud one must look quiet. Scaling each
    // row to itself would give both the same silhouette.
    const loud = buildSpark(spark([100, 50], [0, 0]), 'cost', 100)
    const quiet = buildSpark(spark([1, 1], [0, 0]), 'cost', 100)
    expect(loud[0]!.height).toBe(1)
    expect(quiet[0]!.height).toBeLessThan(0.2)
  })

  it('switches the plotted values with the measure', () => {
    // Cost and tokens genuinely disagree: a cheap model burns tokens cheaply,
    // so the shape of the picture must change with the toggle.
    const s = spark([10, 0], [0, 500])
    const byCost = buildSpark(s, 'cost', 10)
    const byTokens = buildSpark(s, 'tokens', 500)
    expect(byCost.map((b) => b.empty)).toEqual([false, true])
    expect(byTokens.map((b) => b.empty)).toEqual([true, false])
  })

  it('dates each column from the bucket grid the daemon sent', () => {
    const bars = buildSpark(spark([1, 1, 1], [0, 0, 0]), 'cost', 1)
    expect(bars.map((b) => b.at)).toEqual([1_000_000, 1_000_000 + DAY, 1_000_000 + 2 * DAY])
  })

  it('treats a negative or non-finite value as no data instead of drawing it', () => {
    const bars = buildSpark(spark([-5, Number.NaN, 3], [0, 0, 0]), 'cost', 3)
    expect(bars.map((b) => b.empty)).toEqual([true, true, false])
  })

  it('returns nothing when the row has no series at all', () => {
    expect(buildSpark(undefined, 'cost', 10)).toEqual([])
  })
})

describe('peak', () => {
  it('is the tallest column across every row, so rows share one ceiling', () => {
    // The maximum deliberately sits in the LAST row: a peak that stopped
    // scanning early would return the first row's 4 and silently squash every
    // other row's picture against a ceiling that is too low.
    const a = spark([4, 2], [40, 20])
    const b = spark([1, 9], [10, 90])
    expect(peak([a, b], 'cost')).toBe(9)
    expect(peak([a, b], 'tokens')).toBe(90)
  })

  it('is zero when there is nothing to scale to', () => {
    expect(peak([undefined], 'cost')).toBe(0)
  })
})

describe('bucketLabel', () => {
  it('names an hourly column by its clock time and a daily one by its date', () => {
    const at = Date.UTC(2026, 0, 15, 13, 0, 0)
    // An hourly bucket needs the hour; a daily one naming a clock time would
    // claim a precision the column does not have.
    expect(bucketLabel(at, 3_600_000)).toMatch(/\d/)
    expect(bucketLabel(at, DAY)).not.toMatch(/:/)
  })
})
