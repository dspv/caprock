import { describe, expect, it } from 'vitest'
import { FLOW_MIN_DAYS, flowCompare, flowCompareTitle, flowPointTitle, flowTone, flowUsualLine, flowWord } from './flowtrend'
import type { FlowPoint } from './prboard'

/** 14 days, oldest first, today last; undefined is a day with no sample. */
const series = (values: (number | undefined)[], n: (v: number | undefined) => number = (v) => (v === undefined ? 0 : 1)): FlowPoint[] =>
  values.map((v, i) => ({ day: `2026-10-${String(i + 1).padStart(2, '0')}`, value: v, n: n(v) }))

const min = 60_000
const U = undefined

describe('flowCompare', () => {
  it('sets a median day against the median of the earlier days with a sample, gaps left out', () => {
    // Previous days with a run: 6, 8, 10 (and gaps); today 12 → +50% over 8.
    const c = flowCompare('ci', series([U, 6 * min, U, U, 8 * min, U, U, 10 * min, U, U, U, U, U, 12 * min]))
    expect(c).toMatchObject({ kind: 'above', usual: 8 * min, now: 12 * min, days: 3 })
    expect(flowWord('ci', c!)).toBe('above usual +50%')
    // A longer run is worse: amber. A shorter one is better: green.
    expect(flowTone('ci', c)).toBe('warn')
    const faster = flowCompare('ci', series([U, 6 * min, U, U, 8 * min, U, U, 10 * min, U, U, U, U, U, 4 * min]))
    expect(flowWord('ci', faster!)).toBe('below usual −50%')
    expect(flowTone('ci', faster)).toBe('ok')
  })

  it('says nothing compared with fewer than FLOW_MIN_DAYS earlier days with data', () => {
    expect(FLOW_MIN_DAYS).toBe(3)
    const c = flowCompare('ttm', series([U, U, U, U, U, U, U, U, U, U, U, 30 * min, 40 * min, 90 * min]))
    expect(c).toEqual({ kind: 'thin', days: 2 })
    expect(flowWord('ttm', c!)).toBe('not enough history')
    expect(flowTone('ttm', c)).toBe('none')
    expect(flowCompareTitle('ttm', c!, 14)).toBe('Not enough history: 2 of the previous 13 days had a merge; a comparison needs 3')
  })

  it('a median with nothing today is "none today", not below usual', () => {
    const c = flowCompare('lag', series([U, 30 * min, 40 * min, 50 * min, U, U, U, U, U, U, U, U, U, U]))
    expect(c).toEqual({ kind: 'quiet', usual: 40 * min, days: 3 })
    expect(flowWord('lag', c!)).toBe('no release yet today')
    expect(flowCompareTitle('lag', c!, 14)).toBe('No release yet today · vs the median of the daily medians, last 14 days: ~40m, on the 3 days with a release')
  })

  it('a running total compares today so far with earlier days by the same hour, over the days with a merge', () => {
    // Whole days 4, 0, 6, 2 merges; by this hour 2, 0, 3, 1; today 3 so far.
    const pts: FlowPoint[] = [
      ...series([U, U, U, U, U, U, U, U, U]).map((p) => ({ ...p, value: 0, n: 0, by_now: 0 })),
      { day: '2026-10-10', value: 4, n: 4, by_now: 2 },
      { day: '2026-10-11', value: 0, n: 0, by_now: 0 },
      { day: '2026-10-12', value: 6, n: 6, by_now: 3 },
      { day: '2026-10-13', value: 2, n: 2, by_now: 1 },
      { day: '2026-10-14', value: 3, n: 3, by_now: 3 },
    ]
    const c = flowCompare('throughput', pts)
    // The median of 2, 3, 1 (the zero day is not a usual) is 2; 3 is +50%.
    expect(c).toMatchObject({ kind: 'above', now: 3, usual: 2, days: 3 })
    // More merges is better.
    expect(flowTone('throughput', c)).toBe('ok')
    expect(flowCompareTitle('throughput', c!, 14)).toBe('3 today so far · vs the median of the previous 13 days by this time of day: 2, on the 3 days with a merge')
    // Its usual is by this hour while its line is whole days: no dashed line.
    expect(flowUsualLine('throughput', 2)).toBeUndefined()
    expect(flowUsualLine('ci', 2)).toBe(2)
  })

  it('keeps the open count and the agent cost muted either way', () => {
    const c = flowCompare('flight', series([2, 2, 3, 2, 2, 3, 2, 2, 3, 2, 2, 3, 2, 8], (v) => v ?? 0))
    expect(c).toMatchObject({ kind: 'above', usual: 2, now: 8 })
    expect(flowWord('flight', c!)).toBe('above usual 4.0×')
    expect(flowTone('flight', c)).toBe('none')
    expect(flowCompareTitle('flight', c!, 14)).toBe('8 open now · vs the median of the previous 13 days, each at its end: 2')
    expect(flowTone('cost', { kind: 'below', now: 1, usual: 4, days: 5, ratio: 0.25 })).toBe('none')
  })

  it('within ±15% of usual is "usual"', () => {
    const c = flowCompare('ttm', series([U, 10 * min, 10 * min, 10 * min, U, U, U, U, U, U, U, U, U, 11 * min]))
    expect(c?.kind).toBe('usual')
    expect(flowWord('ttm', c!)).toBe('usual')
    expect(flowTone('ttm', c)).toBe('none')
  })

  it('has nothing to say without a series', () => {
    expect(flowCompare('ci', [])).toBeUndefined()
  })
})

describe('flowPointTitle', () => {
  it('names the day and what its value rests on, or that it had none', () => {
    expect(flowPointTitle('ttm', { day: '2026-10-13', value: 30 * min, n: 3 }, false)).toBe('Tue 13 Oct · 30m, median of 3 merges')
    expect(flowPointTitle('ci', { day: '2026-10-13', n: 0 }, false)).toBe('Tue 13 Oct · no successful run')
    expect(flowPointTitle('flight', { day: '2026-10-14', value: 8, n: 8 }, true)).toBe('Today · 8 open now')
    expect(flowPointTitle('throughput', { day: '2026-10-14', value: 1, n: 1, by_now: 1 }, true)).toBe('Today · 1 merge so far')
  })
})
