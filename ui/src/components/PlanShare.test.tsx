import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PlanShare } from './PlanShare'
import { setPlanRatesForTest } from '@/lib/planRates'
import type { PlanRates } from '@/lib/planShare'

const now = Date.UTC(2026, 9, 25)
const rates: PlanRates = {
  computed_at: now, plan_days: 30,
  rates: [{
    agent: 'claude', subscription: '', label: 'Own sign-in', plan_kind: 'flat',
    plan: { label: 'Max 20×', usd_per_month: 200, days: 30, fee_usd: 200, api_usd: 2000, from: now - 30 * 86_400_000, to: now, factor: 0.1 },
    week: { resets_at: now / 1000, completed: true, from: now - 7 * 86_400_000, to: now, used_points: 80, api_usd: 1000, pct_per_usd: 0.08 },
  }],
}
const parts = [{ agent: 'claude', subscription: '', cost_usd: 50 }]

afterEach(() => { cleanup(); act(() => setPlanRatesForTest(undefined)) })

describe('PlanShare', () => {
  it('draws the plan dollars and the week share, each piece whole', () => {
    act(() => setPlanRatesForTest(rates))
    const { container } = render(<PlanShare parts={parts} />)
    const line = container.querySelector('[data-plan-share]')!
    // Each piece has its own separator, on the side a wrapped line starts
    // from, so a wrapped line never begins with a stray dot.
    expect(line.textContent).toBe('·≈$5.00 of plan·≈4% of a week')
    const pieces = [...line.querySelectorAll(':scope > span > span')]
    expect(pieces.map((p) => p.textContent)).toEqual(['·≈$5.00 of plan', '·≈4% of a week'])
  })

  it('opens its explanation on hover and on focus', () => {
    act(() => setPlanRatesForTest(rates))
    const { container } = render(<PlanShare parts={parts} />)
    const line = container.querySelector('[data-plan-share]') as HTMLElement
    fireEvent.mouseEnter(line)
    const card = screen.getByRole('tooltip')
    expect(card.textContent).toContain('over the last 30 days')
    expect(card.textContent).toContain('another computer')
    fireEvent.mouseLeave(line)
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.focus(line)
    expect(screen.getByRole('tooltip')).toBeTruthy()
  })

  it('draws nothing without rates, without parts, or with tip off opens nothing', () => {
    const { container, rerender } = render(<PlanShare parts={parts} />)
    expect(container.querySelector('[data-plan-share]')).toBeNull()
    act(() => setPlanRatesForTest(rates))
    rerender(<PlanShare parts={undefined} />)
    expect(container.querySelector('[data-plan-share]')).toBeNull()
    rerender(<PlanShare parts={parts} tip={false} />)
    const line = container.querySelector('[data-plan-share]') as HTMLElement
    expect(line.tabIndex).toBe(-1)
    fireEvent.mouseEnter(line)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})
