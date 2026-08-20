/**
 * The plan-value panel makes a claim about money, so its honesty rules are
 * pinned here: no claim without a stated plan, no "saving" language ever, and
 * no multiple at all on metered billing — where the API-list figure is roughly
 * the real bill rather than an equivalent.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PlanValue } from './PlanValue'
import type { Settings, Summary } from '@/lib/api'

const summary = { cost_usd: 7119, pricing_version: '2026-08-18.1' } as Summary

function plan(kind: Settings['plan_kind'], usd = 0, label = 'Max 20×'): Settings {
  return { plan_kind: kind, plan_label: label, plan_usd_per_month: usd }
}

describe('PlanValue', () => {
  it('claims nothing until the user states a plan', () => {
    render(<PlanValue summary={summary} plan={plan('')} days={30} />)
    expect(screen.getByText(/won't guess|won’t guess/)).toBeTruthy()
    expect(screen.queryByText(/×/)).toBeNull()
  })

  it('shows the multiple against a flat plan for the same window', () => {
    render(<PlanValue summary={summary} plan={plan('flat', 200)} days={30} />)
    // 7119 / 200 = 35.6
    expect(screen.getByText('35.6×')).toBeTruthy()
  })

  it('scales the fee to a shorter window rather than comparing to a full month', () => {
    render(<PlanValue summary={{ ...summary, cost_usd: 100 } as Summary} plan={plan('flat', 300)} days={7} />)
    // fee for 7 days = 300 * 7/30 = 70; 100/70 = 1.4
    expect(screen.getByText('1.4×')).toBeTruthy()
  })

  it('never describes the figure as money saved', () => {
    const { container } = render(<PlanValue summary={summary} plan={plan('flat', 200)} days={30} />)
    expect(container.textContent).not.toMatch(/\bsaved\b|\bsavings\b/i)
  })

  it('shows no multiple on metered billing, where the figure is the bill', () => {
    render(<PlanValue summary={summary} plan={plan('metered', 0, 'API / Bedrock')} days={30} />)
    expect(screen.queryByText(/\d×/)).toBeNull()
    expect(screen.getByText(/approximately your actual cost/)).toBeTruthy()
  })

  it('renders nothing without a summary rather than a zeroed claim', () => {
    const { container } = render(<PlanValue summary={undefined} plan={plan('flat', 200)} days={30} />)
    expect(container.textContent).toBe('')
  })
})
