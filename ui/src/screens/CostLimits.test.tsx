/**
 * The plan-limits panel used to render only when there was window state to
 * show, so the one screen that could explain why a user has no limits showed
 * nothing at all — the same shape as the spawn button that hid the dialog
 * explaining itself.
 */
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Settings, Summary } from '@/lib/api'

const state = vi.hoisted(() => ({ summary: undefined as Partial<Summary> | undefined }))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      summary: async () => state.summary as Summary,
      daily: async () => [],
      settings: async () => ({ update_checks: false, plan_kind: 'flat', plan_label: 'Max 20×', plan_usd_per_month: 200 }) as Settings,
    },
  }
})

import { CostScreen } from './Cost'

const summary = (over: Partial<Summary> = {}): Partial<Summary> => ({
  range: '30d', from_ms: 0, sessions: 1, active_sessions: 0, turns: 10, tool_calls: 0,
  tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, cost_usd: 100,
  models: [], projects: [], pricing_version: '2026-08-01', throttles: 0,
  savings: { billed_with: 0, billed_without: 0, saved: 0, hit_rate: 0, cut_pct: 0 },
  burn: { window_min: 5, usd_per_hour: 0, tokens_per_min: 0, turns: 0 },
  ...over,
})

describe('plan limits panel', () => {
  it('says where limits come from when there are none', async () => {
    state.summary = summary({ rate_limits: undefined })
    render(<CostScreen />)
    await waitFor(() => expect(screen.getByText('Plan limits')).toBeInTheDocument())
    // Vanishing taught the user nothing. The empty state has to name the thing
    // that produces the data, or "I could not find plan limits" is the only
    // possible outcome.
    expect(document.body.textContent).toMatch(/status line/i)
    expect(document.body.textContent).toMatch(/caprock statusline/)
  })

  it('shows the windows when there is state', async () => {
    state.summary = summary({
      rate_limits: { five_hour: { used_percentage: 24, resets_at: 0 }, seven_day: { used_percentage: 27, resets_at: 0 } },
    })
    render(<CostScreen />)
    await waitFor(() => expect(screen.getByText('24%')).toBeInTheDocument())
    expect(screen.getByText('27%')).toBeTruthy()
  })
})
