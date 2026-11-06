import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_SUBAGENT_LOOK, MATRIX_TILES, SUBAGENT_LOOKS, SUBAGENT_LOOK_KEY, clockTime, getSubagentLook, isSubagentLook, peakMinute, readSubagentLook, resetSubagentLookForTest,
  matrixRoom, setSubagentLook, sparkPoints, subagentFace, subagentSummary,
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

describe('matrixRoom', () => {
  // Two rows of four, the +N included: the grid is never taller than the portrait.
  it('gives eight faces, or seven and room for +N when more than eight work', () => {
    expect(MATRIX_TILES).toBe(8)
    expect(matrixRoom(0)).toBe(8)
    expect(matrixRoom(8)).toBe(8)
    expect(matrixRoom(9)).toBe(7)
    expect(matrixRoom(40)).toBe(7)
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

  // Owner, 2026-11-06: at most three looks, the matrix (B) first and the default.
  it('is the matrix until one is picked, then the pick, kept in storage', () => {
    expect(SUBAGENT_LOOKS.map((l) => l.id)).toEqual(['matrix', 'chips', 'strip'])
    expect(DEFAULT_SUBAGENT_LOOK).toBe('matrix')
    expect(getSubagentLook()).toBe('matrix')
    setSubagentLook('strip')
    expect(localStorage.getItem(SUBAGENT_LOOK_KEY)).toBe('strip')
    resetSubagentLookForTest()
    expect(getSubagentLook()).toBe('strip')
  })

  it('reads garbage in storage as the default', () => {
    localStorage.setItem(SUBAGENT_LOOK_KEY, 'sparkline')
    expect(getSubagentLook()).toBe('matrix')
  })

  // The crew, dropped when the matrix replaced it, reads as the matrix; the
  // two looks dropped earlier that day as the default.
  it('reads a stored crew as the matrix and a dropped look as the default', () => {
    expect(isSubagentLook('crew')).toBe(false)
    expect(readSubagentLook('crew')).toBe('matrix')
    expect(readSubagentLook('chips')).toBe('chips')
    expect(readSubagentLook(null)).toBe('matrix')
    localStorage.setItem(SUBAGENT_LOOK_KEY, 'crew')
    expect(getSubagentLook()).toBe('matrix')
    resetSubagentLookForTest()
    for (const gone of ['chart', 'numbers']) {
      expect(isSubagentLook(gone)).toBe(false)
      localStorage.setItem(SUBAGENT_LOOK_KEY, gone)
      resetSubagentLookForTest()
      expect(getSubagentLook()).toBe('matrix')
    }
  })
})
