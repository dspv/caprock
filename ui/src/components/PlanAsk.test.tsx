/**
 * The plan question under a hero cost. A Pro user read "Cost $29.14 at API
 * list price" as $29 charged (2026-11-22); Caprock cannot know the plan, so it
 * asks where the number is — and a tap must save exactly what the header chip
 * and Settings save, the hint must never become a choice, and "Not now" must
 * mean not again in this browser.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CostHeroSub, PLAN_ASK_CHOICES, PLAN_ASK_KEY, hasPlanWindows } from './PlanAsk'
import { timesWhatYouPay, monthRange } from './PlanMonth'
import { TodayLine } from './TodayLine'
import type { RateLimits, Settings } from '@/lib/api'

const paired = vi.hoisted(() => ({ on: false }))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, isPairedDevice: () => paired.on }
})

const plan = (over: Partial<Settings> = {}): Settings => ({
  update_checks: false, plan_kind: '', plan_label: '', plan_usd_per_month: 0, ...over,
})
const windows: RateLimits = { five_hour: { used_percentage: 12, resets_at: 0 } }

function sub(p: Settings | undefined, onSave = vi.fn(), limits?: RateLimits, measured = true) {
  render(<CostHeroSub plan={p} onSave={onSave} limits={limits} measured={measured} basis={<span>at API list price</span>} />)
  return onSave
}

beforeEach(() => { localStorage.clear(); paired.on = false })
afterEach(() => { localStorage.clear() })

describe('the plan question', () => {
  it('offers the picker’s own plans and prices, nothing invented', () => {
    expect(PLAN_ASK_CHOICES.map((c) => c.chip)).toEqual(['Pro $20', 'Max $100', 'Ultra $200', 'API key'])
    expect(PLAN_ASK_CHOICES.map((c) => c.patch)).toEqual([
      { plan_kind: 'flat', plan_label: 'Pro', plan_usd_per_month: 20 },
      { plan_kind: 'flat', plan_label: 'Max', plan_usd_per_month: 100 },
      { plan_kind: 'flat', plan_label: 'Ultra', plan_usd_per_month: 200 },
      { plan_kind: 'metered', plan_label: 'API / Bedrock', plan_usd_per_month: 0 },
    ])
  })

  it('saves the same fields Settings saves on a tap', () => {
    const onSave = sub(plan())
    expect(screen.getByText('How do you pay for Claude?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Max $100' }))
    expect(onSave).toHaveBeenCalledWith({ plan_kind: 'flat', plan_label: 'Max', plan_usd_per_month: 100 })
    fireEvent.click(screen.getByRole('button', { name: 'API key' }))
    expect(onSave).toHaveBeenLastCalledWith({ plan_kind: 'metered', plan_label: 'API / Bedrock', plan_usd_per_month: 0 })
  })

  it('keeps the basis line beside the question', () => {
    sub(plan())
    expect(screen.getByText('at API list price')).toBeInTheDocument()
  })

  it('"Not now" hides it and remembers that in this browser', () => {
    const onSave = sub(plan())
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(screen.queryByText('How do you pay for Claude?')).toBeNull()
    expect(localStorage.getItem(PLAN_ASK_KEY)).toBe('off')
    expect(onSave).not.toHaveBeenCalled()
  })

  it('stays hidden on the next visit once dismissed', () => {
    localStorage.setItem(PLAN_ASK_KEY, 'off')
    sub(plan())
    expect(screen.queryByText('How do you pay for Claude?')).toBeNull()
    expect(screen.getByText('at API list price')).toBeInTheDocument()
  })

  it('one dismissal hides it in every place that asks', () => {
    render(<>
      <CostHeroSub plan={plan()} onSave={vi.fn()} measured basis="a" />
      <CostHeroSub plan={plan()} onSave={vi.fn()} measured basis="b" />
    </>)
    expect(screen.getAllByText('How do you pay for Claude?')).toHaveLength(2)
    act(() => { fireEvent.click(screen.getAllByRole('button', { name: 'Not now' })[0]!) })
    expect(screen.queryByText('How do you pay for Claude?')).toBeNull()
  })

  it('hints a subscription only when Claude Code has reported plan windows, and chooses nothing', () => {
    const onSave = sub(plan(), vi.fn(), windows)
    expect(screen.getByText('Claude shows you plan limits, so it looks like a subscription.')).toBeInTheDocument()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('gives no hint without plan windows', () => {
    sub(plan(), vi.fn(), {})
    expect(screen.queryByText(/looks like a subscription/)).toBeNull()
    expect(hasPlanWindows(undefined)).toBe(false)
    expect(hasPlanWindows(null)).toBe(false)
    expect(hasPlanWindows({ seven_day: { used_percentage: 1, resets_at: 0 } })).toBe(true)
  })

  it('does not ask before the plan has loaded, or once one is stated', () => {
    sub(undefined)
    expect(screen.queryByText('How do you pay for Claude?')).toBeNull()
  })

  it('does not ask a paired device, which cannot save settings', () => {
    paired.on = true
    sub(plan())
    expect(screen.queryByText('How do you pay for Claude?')).toBeNull()
  })
})

describe('the hero line once the plan is stated', () => {
  it('says a flat plan covered the work, with the extra-usage caveat', () => {
    sub(plan({ plan_kind: 'flat', plan_label: 'Pro', plan_usd_per_month: 20 }))
    expect(screen.getByText('Claude Code work is covered by your Pro plan.')).toHaveClass('text-ok')
    expect(screen.getByText('Nothing extra was charged unless you turned on extra usage.')).toBeInTheDocument()
    expect(screen.queryByText('How do you pay for Claude?')).toBeNull()
  })

  it('keeps the basis for a metered plan, and asks nothing', () => {
    sub(plan({ plan_kind: 'metered', plan_label: 'API / Bedrock' }))
    expect(screen.getByText('at API list price')).toBeInTheDocument()
    expect(screen.queryByText(/covered by/)).toBeNull()
    expect(screen.queryByText('How do you pay for Claude?')).toBeNull()
  })

  it('says nothing is measured rather than "covered" when nothing is', () => {
    sub(plan({ plan_kind: 'flat', plan_label: 'Pro', plan_usd_per_month: 20 }), vi.fn(), undefined, false)
    expect(screen.queryByText(/covered by/)).toBeNull()
  })
})

describe('this month against the plan', () => {
  it('says the multiple only when both figures are known', () => {
    expect(timesWhatYouPay(87.4, 20)).toBe('About 4.4 times what you pay.')
    expect(timesWhatYouPay(400, 20)).toBe('About 20 times what you pay.')
    expect(timesWhatYouPay(40, 20)).toBe('About 2 times what you pay.')
    expect(timesWhatYouPay(5, 20)).toBe('About 25% of what you pay.')
    expect(timesWhatYouPay(undefined, 20)).toBeUndefined()
    expect(timesWhatYouPay(0, 20)).toBeUndefined()
    expect(timesWhatYouPay(30, 0)).toBeUndefined()
  })

  it('starts on the 1st of the month', () => {
    expect(monthRange(new Date(2026, 10, 22))).toBe('22d')
    expect(monthRange(new Date(2026, 11, 1))).toBe('1d')
  })
})

describe('the sidebar Today line', () => {
  const today = { spend: 29.14, agents: 1, working: 0, waiting: 0, windows: [] }
  const line = (p?: Settings) => render(<TodayLine today={today} loaded now={0} onSpend={vi.fn()} onWindows={vi.fn()} onRunning={vi.fn()} plan={p} />)

  it('names a flat plan’s spend as covered work, not money spent', () => {
    line(plan({ plan_kind: 'flat', plan_label: 'Pro', plan_usd_per_month: 20 }))
    expect(screen.getByRole('button', { name: /^Work at API prices today, every agent: \$29\.14\. Claude Code work is covered by your Pro plan\./ })).toBeInTheDocument()
  })

  it('keeps "Spent today" for a metered or unstated plan', () => {
    line(plan({ plan_kind: 'metered' }))
    expect(screen.getByRole('button', { name: /^Spent today, every agent: \$29\.14/ })).toBeInTheDocument()
  })
})
