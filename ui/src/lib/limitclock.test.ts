import { describe, expect, it } from 'vitest'
import { resetClock } from './limitclock'

const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime()
const hm = (h: number, m: number) => new Date(2026, 0, 1, h, m).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

describe('resetClock', () => {
  it('names no day for a moment later today', () => {
    expect(resetClock(at(20, 23, 10), at(20, 19, 54))).toBe(hm(23, 10))
  })
  it('says tomorrow for a moment on the next day, even under 24 hours away', () => {
    expect(resetClock(at(21, 17, 11), at(20, 19, 54))).toBe(`tomorrow ${hm(17, 11)}`)
  })
  it('names the weekday further away', () => {
    const r = resetClock(at(23, 9, 0), at(20, 19, 54))
    expect(r).toBe(`${new Date(at(23, 9, 0)).toLocaleDateString([], { weekday: 'short' })} ${hm(9, 0)}`)
  })
})
