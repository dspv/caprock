/**
 * The owner followed a "95%" alert to the Cost screen and could not tell what
 * any of it meant. These pin the answer in words: whose limit it is, how much
 * is used, when it resets and how long that is, what happens at 100%, and
 * what to do — and that the alert lands on it.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PlanLimitsPanel, forecastLine, planName } from './PlanLimits'
import { countdown } from '@/lib/limitclock'
import { findAttention } from '@/lib/attention'
import { href, parseHash } from '@/lib/router'
import type { Settings } from '@/lib/api'

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: { ...actual.api, settings: async () => ({ update_checks: false, plan_kind: 'flat', plan_label: 'Max 5×', plan_usd_per_month: 100 }) },
  }
})

const NOW = Date.parse('2026-10-04T12:11:00Z')
const at = (min: number) => (NOW + min * 60_000) / 1000

describe('plan limits in plain words', () => {
  it('counts down in minutes under an hour', () => {
    expect(countdown(9 * 60_000)).toBe('9 min')
    expect(countdown(99 * 60_000)).toBe('1 h 39 min')
    expect(countdown(120 * 60_000)).toBe('2 h')
    expect(countdown((3 * 24 + 4) * 3600_000)).toBe('3 d 4 h')
  })

  it('names the plan the user picked, and never guesses one', () => {
    expect(planName({ plan_kind: 'flat', plan_label: 'Max 5×' } as Settings)).toBe('Claude Max 5×')
    expect(planName({ plan_kind: 'metered', plan_label: 'API / Bedrock' } as Settings)).toBe('Claude Code')
    expect(planName(undefined)).toBe('Claude Code')
  })

  it('says what is used, when it resets, what 100% means and what to do', async () => {
    render(
      <PlanLimitsPanel
        now={NOW}
        limits={{ five_hour: { used_percentage: 97, resets_at: at(9) }, seven_day: { used_percentage: 47, resets_at: at(3 * 24 * 60) } }}
        codex={{ seven_day: { used_percentage: 8, resets_at: at(5 * 24 * 60), observed_at: NOW - 3600_000 } }}
      />,
    )
    const text = () => document.body.textContent ?? ''
    expect(text()).toContain('5-hour window: 97% used')
    expect(text()).toMatch(/Resets .+ — in 9 min\./)
    expect(text()).toContain('At 100%, Claude Code pauses until then.')
    expect(text()).toContain('Weekly: 47% used')
    expect(text()).toContain("Anthropic's plan limits, per 5-hour window and per week — not Caprock's.")
    // The details are one click away, not three lines of the panel.
    expect(text()).not.toContain('rolling 5-hour window')
    fireEvent.click(screen.getByRole('button', { name: 'more' }))
    expect(text()).toContain('rolling 5-hour window')
    expect(text()).toMatch(/Claude is near its limit\. Wait for the reset at .+ \(in 9 min\), or switch to Codex — its weekly window is at 8%\./)
    await waitFor(() => expect(screen.getByText('Claude Max 5×')).toBeTruthy())
  })

  it('draws a forecast as a plain sentence, amber unless it is close', () => {
    // 9% used, 100% at pace in 3 h 12 min, reset in 4 h 19 min: about an hour early.
    const w = { used_percentage: 9, resets_at: at(259), forecast: '~3.2h to limit at current pace', limit_at: NOW + 192 * 60_000 }
    const f = forecastLine(w, NOW)
    expect(f?.text).toMatch(/^At this pace you'll hit 100% around .+ — about 1 h 7 min before it resets\.$/)
    expect(f?.urgent).toBe(false)
    expect(forecastLine({ ...w, limit_at: NOW + 20 * 60_000 }, NOW)?.urgent).toBe(true)
    expect(forecastLine({ used_percentage: 9, resets_at: at(259) }, NOW)).toBeNull()
    render(<PlanLimitsPanel now={NOW} limits={{ five_hour: w }} codex={undefined} />)
    const line = screen.getByText(/At this pace you'll hit 100%/)
    expect(line.className).toContain('text-warn')
  })

  it('gives no advice while nothing is near its limit', () => {
    render(<PlanLimitsPanel now={NOW} limits={{ five_hour: { used_percentage: 40, resets_at: at(120) } }} codex={undefined} />)
    expect(document.body.textContent).not.toMatch(/near its limit/)
  })

  it('sends the alert straight to the explanation', () => {
    const [item] = findAttention({ sessions: [], alerts: [], now: NOW, limits: { five_hour: { used_percentage: 97, resets_at: at(9) } } })
    expect(item?.title).toBe("Claude's 5-hour limit: 97% used")
    expect(item?.detail).toMatch(/in 9 min; at 100% Claude Code pauses until then/)
    expect(href({ name: 'cost', section: 'limits' })).toBe('#/cost?section=limits')
    expect(parseHash('#/cost?section=limits')).toEqual({ name: 'cost', section: 'limits' })
  })
})
