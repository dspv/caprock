/**
 * The plan-value panel makes a claim about money, so its honesty rules are
 * pinned here: no claim without a stated plan, no "saving" language ever, and
 * no multiple at all on metered billing — where the API-list figure is roughly
 * the real bill rather than an equivalent. On a flat plan it compares this
 * month's Claude Code work with the monthly fee (owner, 2026-11-22).
 */
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PlanValue } from './PlanValue'
import { PLAN_ASK_KEY } from './PlanAsk'
import type { Settings, Summary } from '@/lib/api'

const month = vi.hoisted(() => ({ cost: 87.4, asked: [] as unknown[][] }))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      summary: async (...args: unknown[]) => { month.asked.push(args); return { cost_usd: month.cost } as Summary },
    },
  }
})

const summary = { cost_usd: 7119, pricing_version: '2026-08-18.1' } as Summary

function plan(kind: Settings['plan_kind'], usd = 0, label = 'Ultra'): Settings {
  return { update_checks: false, plan_kind: kind, plan_label: label, plan_usd_per_month: usd }
}

afterEach(() => { localStorage.clear(); month.cost = 87.4; month.asked = [] })

describe('PlanValue', () => {
  it('stays out of the way while the hero cost asks for the plan', () => {
    const { container } = render(<PlanValue summary={summary} plan={plan('')} days={30} />)
    expect(container.textContent).toBe('')
  })

  it('claims nothing until the user states a plan, and invites once the hero question is dismissed', () => {
    localStorage.setItem(PLAN_ASK_KEY, 'off')
    render(<PlanValue summary={summary} plan={plan('')} days={30} />)
    expect(screen.getByText(/won't guess|won’t guess/)).toBeTruthy()
    expect(screen.queryByText(/times what you pay/)).toBeNull()
  })

  it('compares this month of Claude Code with the monthly fee on a flat plan', async () => {
    render(<PlanValue summary={summary} plan={plan('flat', 20, 'Pro')} days={30} />)
    await waitFor(() => expect(screen.getByText('$87.40')).toBeTruthy())
    expect(screen.getByText('$20.00 / month')).toBeTruthy()
    expect(screen.getByText('About 4.4 times what you pay.')).toBeTruthy()
    // From the 1st, Claude Code only: the plan stated is the Claude plan.
    expect(month.asked[0]).toEqual([`${new Date().getDate()}d`, 'claude', undefined])
  })

  it('shows one comparison, not a second multiple over the range beside it', async () => {
    render(<PlanValue summary={summary} plan={plan('flat', 200)} days={30} />)
    await waitFor(() => expect(screen.getByText('$87.40')).toBeTruthy())
    // 7119 / 200 over the range was 35.6× — the month's figure replaces it.
    expect(screen.queryByText(/×$/)).toBeNull()
    expect(screen.queryByText('which is')).toBeNull()
  })

  it('says no multiple until the month has spend', async () => {
    month.cost = 0
    render(<PlanValue summary={summary} plan={plan('flat', 20, 'Pro')} days={30} />)
    await waitFor(() => expect(screen.getByText('$0.00')).toBeTruthy())
    expect(screen.queryByText(/what you pay\./)).toBeNull()
  })

  it('never describes the figure as money saved', async () => {
    const { container } = render(<PlanValue summary={summary} plan={plan('flat', 200)} days={30} />)
    await waitFor(() => expect(screen.getByText('$87.40')).toBeTruthy())
    expect(container.textContent).not.toMatch(/\bsaved\b|\bsavings\b/i)
  })

  it('shows no multiple on metered billing, where the figure is the bill', () => {
    render(<PlanValue summary={summary} plan={plan('metered', 0, 'API / Bedrock')} days={30} />)
    expect(screen.queryByText(/\d×/)).toBeNull()
    expect(screen.queryByText(/times what you pay/)).toBeNull()
    expect(screen.getByText(/approximately your actual cost/)).toBeTruthy()
  })

  it('renders nothing without a summary rather than a zeroed claim', () => {
    const { container } = render(<PlanValue summary={undefined} plan={plan('flat', 200)} days={30} />)
    expect(container.textContent).toBe('')
  })
})
