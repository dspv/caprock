/** Until the plan is set, Plan limits asks for it and says why. */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PlanLimitsPanel } from './PlanLimits'
import { PLAN_ASK_KEY } from './PlanAsk'

const saved = vi.hoisted(() => ({ patch: undefined as unknown }))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      settings: async () => ({ update_checks: false, plan_kind: '', plan_label: '', plan_usd_per_month: 0 }),
      saveSettings: async (p: unknown) => { saved.patch = p; return p },
    },
  }
})

describe('the set-plan banner', () => {
  afterEach(() => localStorage.clear())

  it('stays out of sight while the hero cost asks with its chips: one prompt only', async () => {
    localStorage.clear()
    const now = Date.now()
    render(<PlanLimitsPanel now={now} limits={{ five_hour: { used_percentage: 10, resets_at: now / 1000 + 3600 } }} codex={undefined} />)
    await waitFor(() => expect(screen.getByText('5 hours')).toBeTruthy())
    // Let the plan load (it is what the banner waits on) before asserting.
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByText('Which plan are you on?')).toBeNull()
  })

  it('asks for the plan, says why, and goes once one is picked', async () => {
    // After "Not now" under the hero, this card is the ask again.
    localStorage.setItem(PLAN_ASK_KEY, 'off')
    const now = Date.now()
    render(<PlanLimitsPanel now={now} limits={{ five_hour: { used_percentage: 10, resets_at: now / 1000 + 3600 } }} codex={undefined} />)
    await waitFor(() => expect(screen.getByText('Which plan are you on?')).toBeTruthy())
    expect(document.body.textContent).toContain('Cost compares what you used at API prices with what the plan costs you')
    fireEvent.click(screen.getByRole('button', { name: 'Set my plan' }))
    fireEvent.click(screen.getAllByRole('button').find((b) => /^Max/.test(b.textContent ?? ''))!)
    await waitFor(() => expect(screen.queryByText('Which plan are you on?')).toBeNull())
    expect(saved.patch).toMatchObject({ plan_kind: 'flat' })
  })
})
