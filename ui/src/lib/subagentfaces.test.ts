import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_SUBAGENT_LOOK, SUBAGENT_LOOK_KEY, clockTime, getSubagentLook, isSubagentLook, peakMinute, resetSubagentLookForTest,
  setSubagentLook, sparkPoints, subagentFace, subagentSummary,
} from './subagentfaces'
import { FACES, DUCKS } from './faces'

const M = 60_000

describe('sparkPoints', () => {
  it('scales the hour to the peak in the box, oldest at the left', () => {
    expect(sparkPoints([0, 2, 4], 4, 80, 16)).toBe('0,15.5 40,8 80,0.5')
  })

  it('draws a flat line along the bottom when none worked', () => {
    expect(sparkPoints([0, 0], 0, 80, 16)).toBe('0,15.5 80,15.5')
    expect(sparkPoints([], 0, 80, 16)).toBe('0,16 80,16')
  })
})

describe('subagentSummary', () => {
  it('says how many work now and the peak of the hour when there was one', () => {
    expect(subagentSummary(1, { peak: 4 })).toBe('1 working · peak 4')
    expect(subagentSummary(0, { peak: 0 })).toBe('0 working')
    expect(subagentSummary(2, undefined)).toBe('2 working')
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

  it('is the faces as chips until one is picked, then the pick, kept in storage', () => {
    expect(DEFAULT_SUBAGENT_LOOK).toBe('chips')
    expect(getSubagentLook()).toBe('chips')
    setSubagentLook('crew')
    expect(localStorage.getItem(SUBAGENT_LOOK_KEY)).toBe('crew')
    resetSubagentLookForTest()
    expect(getSubagentLook()).toBe('crew')
  })

  it('reads garbage in storage as the default', () => {
    localStorage.setItem(SUBAGENT_LOOK_KEY, 'sparkline')
    expect(getSubagentLook()).toBe('chips')
  })

  // The two looks dropped on 2026-11-06 fall back to the default; the crew is kept.
  it('reads a dropped look as the default and keeps the crew', () => {
    expect(isSubagentLook('chart')).toBe(false)
    expect(isSubagentLook('numbers')).toBe(false)
    localStorage.setItem(SUBAGENT_LOOK_KEY, 'numbers')
    expect(getSubagentLook()).toBe('chips')
    resetSubagentLookForTest()
    localStorage.setItem(SUBAGENT_LOOK_KEY, 'crew')
    expect(getSubagentLook()).toBe('crew')
  })
})
