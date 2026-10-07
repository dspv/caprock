import { beforeEach, describe, expect, it } from 'vitest'
import { lineFor, markOf, RESUME_TTL_MS, saveScroll, takeScroll } from './termresume'

beforeEach(() => localStorage.clear())

describe('termresume (F20)', () => {
  it('marks only a terminal scrolled up', () => {
    expect(markOf(500, 500, 24)).toBeNull()
    expect(markOf(120, 500, 24)).toEqual({ top: 120, total: 524, fromBottom: 380 })
  })

  it('goes back to the same line after an identical replay, else the same distance from the bottom', () => {
    const m = { top: 120, total: 524, fromBottom: 380 }
    expect(lineFor(m, 500, 24)).toBe(120)
    expect(lineFor(m, 600, 24)).toBe(220)
    expect(lineFor(m, 100, 24)).toBe(0)
  })

  it('gives a place back once, per session, and forgets a stale one', () => {
    const now = 1_000_000
    saveScroll('a', { top: 1, total: 30, fromBottom: 5 }, now)
    saveScroll('b', { top: 2, total: 30, fromBottom: 4 }, now)
    saveScroll('b', null, now)
    expect(takeScroll('b', now)).toBeUndefined()
    expect(takeScroll('a', now + 1000)).toEqual({ top: 1, total: 30, fromBottom: 5 })
    expect(takeScroll('a', now + 1000)).toBeUndefined()
    saveScroll('c', { top: 3, total: 30, fromBottom: 3 }, now)
    expect(takeScroll('c', now + RESUME_TTL_MS + 1)).toBeUndefined()
  })
})
