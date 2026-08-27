/**
 * A user went looking for plan limits and did not find them. They existed —
 * on one screen, in the second column of the bottom row, and only when there
 * was data to show. Both halves of that are tested here.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PlanLimitsStat, readWindow } from './PlanLimits'
import type { RateLimits } from '@/lib/api'

const NOW = Date.parse('2026-08-26T12:00:00Z')

const limits = (over: Partial<RateLimits> = {}): RateLimits => ({
  five_hour: { used_percentage: 24, resets_at: NOW / 1000 + 3600 },
  seven_day: { used_percentage: 27, resets_at: NOW / 1000 + 4 * 86400 },
  ...over,
})

describe('readWindow', () => {
  it('refuses a reset clock that is already past', () => {
    // The status line goes stale the moment a session stops writing it, and a
    // stale sample rendered as a clock is a confident lie about the future.
    const w = readWindow({ used_percentage: 40, resets_at: NOW / 1000 - 60 }, NOW)
    expect(w.resetsAt).toBeNull()
    expect(w.stale).toBe(true)
  })

  it('refuses a reset clock implausibly far ahead', () => {
    // This is not hypothetical: the 5-hour window once announced a reset in 2030.
    const w = readWindow({ used_percentage: 40, resets_at: Date.parse('2030-01-01') / 1000 }, NOW)
    expect(w.resetsAt).toBeNull()
    expect(w.stale).toBe(true)
  })

  it('colours by how close the window is to its limit', () => {
    expect(readWindow({ used_percentage: 20, resets_at: 0 }, NOW).color).toContain('text-fg')
    expect(readWindow({ used_percentage: 70, resets_at: 0 }, NOW).color).toContain('warn')
    expect(readWindow({ used_percentage: 95, resets_at: 0 }, NOW).color).toContain('danger')
  })
})

describe('PlanLimitsStat', () => {
  it('leads with the window closest to its limit, and still names the other', () => {
    // One cell in a dense row, so it cannot print both windows at full size.
    // The one that will stop the work is the one worth the headline.
    render(<PlanLimitsStat limits={limits()} now={NOW} />)
    expect(screen.getByText('27%')).toBeTruthy()
    expect(screen.getByText(/24%/)).toBeTruthy()
  })

  it('says the figures are old rather than printing them as facts', () => {
    // Claude Code writes these to its status line and stops when no session
    // runs. The owner's machine showed a 5-hour window resetting in 2030: a
    // stale sample, and a percentage from an unknown time ago is not a fact.
    const stale = {
      five_hour: { used_percentage: 24, resets_at: Math.floor(NOW / 1000) - 3600 },
      seven_day: { used_percentage: 27, resets_at: Math.floor(NOW / 1000) - 7200 },
    }
    render(<PlanLimitsStat limits={stale} now={NOW} />)
    expect(screen.getByText(/last reported a while ago/i)).toBeTruthy()
  })

  it('renders nothing at all when there is no window state', () => {
    // Now is a live screen, not where someone learns a feature exists — the
    // Cost screen carries that explanation instead.
    const { container } = render(<PlanLimitsStat limits={undefined} now={NOW} />)
    expect(container.textContent).toBe('')
  })
})
