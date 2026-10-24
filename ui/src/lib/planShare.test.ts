import { describe, expect, it } from 'vitest'
import { asRates, asSpendParts, fmtPlanUSD, fmtWeekPct, planShare, planShareItems, planShareLines, sessionParts, type PlanRates } from './planShare'

const DAY = 86_400_000
const now = Date.UTC(2026, 9, 25)

/** The own Claude sign-in on Max at $200 against $4,000 of work (factor 0.05), its week 50 points over $1,000. */
const rates: PlanRates = {
  computed_at: now,
  plan_days: 30,
  rates: [
    { agent: 'claude', subscription: '', label: 'Own sign-in', plan_kind: 'flat',
      plan: { label: 'Max 20×', usd_per_month: 200, days: 30, fee_usd: 200, api_usd: 4000, from: now - 30 * DAY, to: now, factor: 0.05 },
      week: { resets_at: (now - DAY) / 1000, completed: true, from: now - 8 * DAY, to: now - 2 * DAY, used_points: 50, api_usd: 1000, pct_per_usd: 0.05 } },
    { agent: 'claude', subscription: 'ab12cd34', label: 'Work', plan_kind: 'flat',
      plan: { label: 'Pro', usd_per_month: 20, days: 30, fee_usd: 20, api_usd: 100, from: now - 30 * DAY, to: now, factor: 0.2 },
      week_note: 'no_window' },
    { agent: 'claude', subscription: 'deepseek', label: 'DeepSeek', plan_kind: 'metered', plan_note: 'metered', week_note: 'no_window' },
    { agent: 'codex', subscription: '', label: 'Own sign-in', plan_kind: '', plan_note: 'no_plan',
      week: { resets_at: (now + 3 * DAY) / 1000, completed: false, from: now - 4 * DAY, to: now - 3600_000, used_points: 40, api_usd: 80, pct_per_usd: 0.5 } },
  ],
}

describe('planShare', () => {
  it('prices one session on a flat plan in plan dollars and a share of its week', () => {
    const s = planShare(rates, [{ agent: 'claude', subscription: '', cost_usd: 50 }])!
    expect(s.plan_usd).toBeCloseTo(2.5)
    expect(s.partial).toBe(false)
    expect(s.weeks).toHaveLength(1)
    expect(s.weeks[0]?.pct).toBeCloseTo(2.5)
    expect(planShareItems(s)).toEqual(['≈$2.50 of plan', '≈2.5% of a week'])
  })

  it('prices each part by its own sign-in and sums the plan dollars', () => {
    const s = planShare(rates, [
      { agent: 'claude', subscription: '', cost_usd: 100 },
      { agent: 'claude', subscription: 'ab12cd34', cost_usd: 10 },
    ])!
    expect(s.plan_usd).toBeCloseTo(100 * 0.05 + 10 * 0.2)
    expect(s.covered_usd).toBe(110)
    expect(s.partial).toBe(false)
    // Only the own sign-in has a week: the Work part adds no percentage.
    expect(s.weeks.map((w) => w.rate.subscription)).toEqual([''])
    expect(s.weeks[0]?.pct).toBeCloseTo(5)
  })

  it('never adds two sign-ins’ weeks together and names each when there are two', () => {
    const s = planShare(rates, [
      { agent: 'claude', subscription: '', cost_usd: 100 },
      { agent: 'codex', subscription: '', cost_usd: 20 },
    ])!
    expect(s.weeks.map((w) => [w.rate.agent, Math.round(w.pct)])).toEqual([['codex', 10], ['claude', 5]])
    expect(planShareItems(s).slice(1)).toEqual(['≈10% of a Codex week', '≈5% of a Claude week'])
  })

  it('marks a plan figure a floor when part of the cost has no plan, and drops it under half covered', () => {
    const mostly = planShare(rates, [
      { agent: 'claude', subscription: '', cost_usd: 90 },
      { agent: 'opencode', subscription: '', cost_usd: 10 },
    ])!
    expect(mostly.partial).toBe(true)
    expect(mostly.plan_usd).toBeCloseTo(4.5)
    expect(planShareItems(mostly)[0]).toBe('≈$4.50+ of plan')
    expect(planShareLines(mostly).join(' ')).toContain('Not in it (hence the +): $10.00 on opencode')

    const little = planShare(rates, [
      { agent: 'claude', subscription: '', cost_usd: 10 },
      { agent: 'opencode', subscription: '', cost_usd: 90 },
    ])!
    expect(little.plan_usd).toBeUndefined()
    expect(little.weeks).toHaveLength(1) // the week share of the Claude part still holds
  })

  it('says nothing for a metered plan, no plan, or no rates at all', () => {
    expect(planShare(rates, [{ agent: 'claude', subscription: 'deepseek', cost_usd: 30 }])).toBeUndefined()
    expect(planShare(rates, [{ agent: 'gemini', subscription: '', cost_usd: 30 }])).toBeUndefined()
    expect(planShare(undefined, [{ agent: 'claude', subscription: '', cost_usd: 30 }])).toBeUndefined()
    expect(planShare(rates, undefined)).toBeUndefined()
    // Codex has no plan stated: a week share, never plan dollars.
    const cx = planShare(rates, [{ agent: 'codex', subscription: '', cost_usd: 30 }])!
    expect(cx.plan_usd).toBeUndefined()
    expect(planShareItems(cx)).toEqual(['≈15% of a week'])
  })

  it('shows more than a week honestly', () => {
    const s = planShare(rates, [{ agent: 'claude', subscription: '', cost_usd: 2600 }])!
    expect(s.weeks[0]?.pct).toBeCloseTo(130)
    expect(planShareItems(s)[1]).toBe('≈130% of a week')
    expect(planShareLines(s).join(' ')).toContain('Over 100%')
  })

  it('explains the method, the period and why it runs high', () => {
    const s = planShare(rates, [{ agent: 'claude', subscription: '', cost_usd: 50 }])!
    const text = planShareLines(s).join('\n')
    expect(text).toContain('Max 20× at $200.00/mo is $200.00 over the last 30 days')
    expect(text).toContain('against $4,000.00 of work at API list price')
    expect(text).toContain('in the week that ended')
    expect(text).toContain('50 points of it went on $1,000.00')
    expect(text).toContain('claude.ai chats, another computer')
  })
})

describe('formats', () => {
  it('keeps the secondary figures short and never a misleading zero', () => {
    expect(fmtPlanUSD(0.004)).toBe('<$0.01')
    expect(fmtPlanUSD(5.2)).toBe('$5.20')
    expect(fmtPlanUSD(152.4)).toBe('$152')
    expect(fmtPlanUSD(1234)).toBe('$1.2k')
    expect(fmtWeekPct(0.04)).toBe('<0.1%')
    expect(fmtWeekPct(2.25)).toBe('2.3%')
    expect(fmtWeekPct(8)).toBe('8%')
    expect(fmtWeekPct(1234.4)).toBe('1,234%')
  })

  it('does not put ≈ before a < bound', () => {
    const s = planShare(rates, [{ agent: 'claude', subscription: '', cost_usd: 0.1 }])!
    expect(planShareItems(s)).toEqual(['<$0.01 of plan', '<0.1% of a week'])
  })
})

describe('reading', () => {
  it('reads parts and rates defensively', () => {
    expect(asSpendParts(undefined)).toBeUndefined()
    expect(asSpendParts([{ agent: 'claude', cost_usd: 2 }, { agent: 'codex', subscription: 'x', cost_usd: 0 }, 'junk'])).toEqual([{ agent: 'claude', subscription: '', cost_usd: 2 }])
    expect(sessionParts({ stats: { cost_usd: 3 } })).toEqual([{ agent: 'claude', subscription: '', cost_usd: 3 }])
    expect(sessionParts({ agent: 'codex', subscription: 'ab', stats: { cost_usd: 0 } })).toBeUndefined()
    expect(asRates({})).toBeUndefined()
    const r = asRates({ rates: [{ agent: 'claude', subscription: '', plan: { factor: 0 } }, 7] })!
    expect(r.rates).toHaveLength(1)
    expect(r.rates[0]?.plan).toBeUndefined() // a zero factor is no factor
  })
})
