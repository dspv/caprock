/**
 * Will this plan window last? One glance (owner, 2026-10-11, translated: "I
 * want to understand at once whether it is enough or not … one line").
 *
 * `elapsed` is how far through its window the clock is — where an even pace
 * would have the bar. The verdict is the daemon's measured forecast, never
 * computed here: `out` when the current pace reaches 100% before the reset
 * (`limit_at`), `ok` when a forecast-capable window has none, `unknown` for
 * an agent that is never forecast (Codex) or a stale reading.
 */
import type { RateWindow } from './api'

export const WINDOW_MS = { five_hour: 5 * 3600_000, seven_day: 7 * 86_400_000 } as const

export interface Pace {
  pct: number
  /** 0–100: how much of the window's time has passed. */
  elapsed: number
  resetMs: number
  verdict: 'ok' | 'out' | 'unknown'
  /** When 100% arrives at this pace, for `out`. */
  outAt?: number
  /** Under half an hour to 100%. */
  urgent: boolean
}

export function pace(w: RateWindow, lenMs: number, now: number, opts: { forecasts: boolean; stale: boolean }): Pace {
  const resetMs = w.resets_at * 1000
  const elapsed = Math.max(0, Math.min(100, 100 * (1 - (resetMs - now) / lenMs)))
  const pct = Math.round(w.used_percentage)
  if (opts.stale || !opts.forecasts) return { pct, elapsed, resetMs, verdict: 'unknown', urgent: false }
  if (w.limit_at && w.limit_at < resetMs && w.limit_at > now) {
    return { pct, elapsed, resetMs, verdict: 'out', outAt: w.limit_at, urgent: w.limit_at - now < 30 * 60_000 }
  }
  return { pct, elapsed, resetMs, verdict: pct >= 100 ? 'out' : 'ok', urgent: pct >= 100 }
}
