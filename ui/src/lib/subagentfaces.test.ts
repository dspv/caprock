import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_SUBAGENT_LOOK, SUBAGENT_LOOK_KEY, clockTime, faceBuckets, faceScale, getSubagentLook, peakMinute, resetSubagentLookForTest,
  setSubagentLook, stackHeight, subagentFace,
} from './subagentfaces'
import { FACES, DUCKS } from './faces'

const M = 60_000

describe('faceBuckets', () => {
  it('folds an hour into twelve five-minute columns on the clock, each the most at once in it', () => {
    // The hour runs 09:05 … 10:04: the columns are 09:05 … 10:00, the last one partial.
    const end = Date.UTC(2026, 9, 31, 10, 4)
    const start = end - 59 * M
    const counts = Array(60).fill(0)
    counts[59] = 2 // 10:04
    counts[55] = 4 // 10:00, the same column
    counts[54] = 1 // 09:59, the column before
    counts[0] = 9 // 09:05, the first column
    const b = faceBuckets({ start, step_ms: M, counts })
    expect(b).toHaveLength(12)
    expect(b[0]!.start).toBe(Date.UTC(2026, 9, 31, 9, 5))
    expect(b[11]!.start).toBe(Date.UTC(2026, 9, 31, 10, 0))
    expect(b[11]!.most).toBe(4)
    expect(b[10]!.most).toBe(1)
    expect(b[0]!.most).toBe(9)
    expect(b.slice(1, 10).every((x) => x.most === 0)).toBe(true)
  })

  it('leaves out the minutes older than the first column', () => {
    const end = Date.UTC(2026, 9, 31, 10, 2) // columns 09:05 … 10:00
    const start = end - 59 * M // 09:03
    const counts = Array(60).fill(0)
    counts[0] = 5 // 09:03, before 09:05
    counts[1] = 5 // 09:04
    counts[2] = 3 // 09:05
    const b = faceBuckets({ start, step_ms: M, counts })
    expect(b[0]!.start).toBe(Date.UTC(2026, 9, 31, 9, 5))
    expect(b[0]!.most).toBe(3)
    expect(Math.max(...b.map((x) => x.most))).toBe(3)
  })

  it('keeps a minute in the same column as the hour moves on', () => {
    const t = Date.UTC(2026, 9, 31, 10, 1)
    const at = (end: number) => {
      const start = end - 59 * M
      const counts = Array(60).fill(0)
      counts[(t - start) / M] = 3
      return faceBuckets({ start, step_ms: M, counts }).find((x) => x.most === 3)!.start
    }
    expect(at(Date.UTC(2026, 9, 31, 10, 2))).toBe(at(Date.UTC(2026, 9, 31, 10, 4)))
  })
})

describe('peakMinute and clockTime', () => {
  it('names the latest minute that reached the peak, in local HH:MM', () => {
    const start = new Date(2026, 9, 31, 9, 0).getTime()
    const counts = Array(60).fill(0)
    counts[10] = 5
    counts[42] = 5
    counts[50] = 3
    const at = peakMinute({ start, step_ms: M, counts, peak: 5 })
    expect(at).toBe(start + 42 * M)
    expect(clockTime(at!)).toBe('09:42')
    expect(clockTime(new Date(2026, 9, 31, 0, 7).getTime())).toBe('00:07')
  })

  it('has no peak minute in an empty hour', () => {
    expect(peakMinute({ start: 0, step_ms: M, counts: Array(60).fill(0), peak: 0 })).toBeUndefined()
  })
})

describe('faceScale and stackHeight', () => {
  it('draws one face per subagent up to six, then one per ceil(peak / 6)', () => {
    expect(faceScale(0)).toBe(1)
    expect(faceScale(6)).toBe(1)
    expect(faceScale(7)).toBe(2)
    expect(faceScale(12)).toBe(2)
    expect(faceScale(13)).toBe(3)
    expect(faceScale(45)).toBe(8)
  })

  it('never stacks more than six faces, and any subagent at all shows one', () => {
    for (const peak of [1, 5, 6, 7, 13, 45, 100]) expect(stackHeight(peak, faceScale(peak))).toBeLessThanOrEqual(6)
    expect(stackHeight(1, 8)).toBe(1)
    expect(stackHeight(0, 1)).toBe(0)
    expect(stackHeight(5, 1)).toBe(5)
  })
})

describe('subagentFace', () => {
  it('wears the face chosen for Claude, or a stable one from its random pool', () => {
    expect(subagentFace('a1', 'wizard')).toBe('wizard')
    expect(subagentFace('a1', 'duck-party')).toBe('duck-party')
    const f = subagentFace('a1', 'random')
    expect(FACES).toContain(f)
    expect(subagentFace('a1', 'random')).toBe(f)
    expect(DUCKS).toContain(subagentFace('a1', 'random-ducks'))
    // Different keys spread over the pool.
    expect(new Set(Array.from({ length: 40 }, (_, i) => subagentFace(`k${i}`, 'random'))).size).toBeGreaterThan(3)
  })
})

describe('the look a viewer picked', () => {
  beforeEach(() => { localStorage.clear(); resetSubagentLookForTest() })

  it('is the chart of faces until one is picked, then the pick, kept in storage', () => {
    expect(DEFAULT_SUBAGENT_LOOK).toBe('chart')
    expect(getSubagentLook()).toBe('chart')
    setSubagentLook('crew')
    expect(localStorage.getItem(SUBAGENT_LOOK_KEY)).toBe('crew')
    resetSubagentLookForTest()
    expect(getSubagentLook()).toBe('crew')
  })

  it('reads garbage in storage as the default', () => {
    localStorage.setItem(SUBAGENT_LOOK_KEY, 'sparkline')
    expect(getSubagentLook()).toBe('chart')
  })
})
