import { describe, expect, it } from 'vitest'
import { WINDOW_MS, pace } from './pace'

const now = Date.parse('2026-10-11T19:00:00Z')
const resetIn = (min: number) => (now + min * 60_000) / 1000

describe('plan pace', () => {
  it('places an even pace by the clock and says enough when no forecast hits 100%', () => {
    const p = pace({ used_percentage: 20, resets_at: resetIn(150) }, WINDOW_MS.five_hour, now, { forecasts: true, stale: false })
    expect(p.elapsed).toBeCloseTo(50)
    expect(p.verdict).toBe('ok')
  })
  it('says when it runs out, from the daemon forecast, and urgent under half an hour', () => {
    const w = { used_percentage: 80, resets_at: resetIn(120), forecast: '~0.3h', limit_at: now + 20 * 60_000 }
    const p = pace(w, WINDOW_MS.five_hour, now, { forecasts: true, stale: false })
    expect(p.verdict).toBe('out')
    expect(p.outAt).toBe(now + 20 * 60_000)
    expect(p.urgent).toBe(true)
  })
  it('gives no verdict for an agent that is never forecast, or a stale reading', () => {
    expect(pace({ used_percentage: 5, resets_at: resetIn(60) }, WINDOW_MS.seven_day, now, { forecasts: false, stale: false }).verdict).toBe('unknown')
    expect(pace({ used_percentage: 5, resets_at: resetIn(60) }, WINDOW_MS.five_hour, now, { forecasts: true, stale: true }).verdict).toBe('unknown')
  })
})
