/**
 * The cost basis line. Shown five readers, a bare "$586" was taken for a bill
 * by three of them, so the qualifier is not decoration — and it has to follow
 * the plan, because "not a bill" is itself false for someone billed per token.
 */
import { describe, expect, it } from 'vitest'
import { costBasis, costBasisLong, costLabel } from './CostBasis'
import type { Settings } from '@/lib/api'

const plan = (over: Partial<Settings>): Settings => ({
  update_checks: false, plan_kind: '', plan_label: '', plan_usd_per_month: 0, ...over,
})

describe('costBasis', () => {
  it('tells a flat-plan user the figure is not money out of pocket', () => {
    const s = costBasis(plan({ plan_kind: 'flat', plan_label: 'Max 20×', plan_usd_per_month: 200 }))
    expect(s).toContain('not a bill')
    expect(costBasisLong(plan({ plan_kind: 'flat', plan_label: 'Max 20×' }))).toContain('Max 20×')
  })

  it('does not tell a metered user their bill is not a bill', () => {
    // On an API key this figure IS approximately the invoice. Reassuring them
    // it is only an equivalent would be the same error in the other direction.
    const s = costBasis(plan({ plan_kind: 'metered', plan_label: 'API' }))
    expect(s).not.toContain('not a bill')
    expect(s).toContain('your bill')
    // Hedged, but as a bill rather than as an equivalent. The word itself does
    // not matter — "approximately" and "roughly" both do the job — so this
    // asserts the claim, not the vocabulary.
    expect(costBasisLong(plan({ plan_kind: 'metered' }))).toMatch(/roughly|approximate/i)
  })

  it('claims neither when the plan is unknown', () => {
    // Caprock cannot detect the plan, so with none stated it says the basis
    // and stops — guessing either way would be an invented claim (rule 6).
    const s = costBasis(undefined)
    expect(s).toContain('API list price')
    expect(s).not.toContain('not a bill')
    expect(s).not.toContain('your bill')
  })

  it('always names the basis, whatever the plan', () => {
    for (const p of [undefined, plan({ plan_kind: 'flat' }), plan({ plan_kind: 'metered' })]) {
      expect(costBasis(p)).toContain('API list price')
    }
  })

  it('never uses the internal jargon on a user-facing line', () => {
    // "API-equivalent" is our word. It explained nothing to a first-time reader.
    for (const p of [undefined, plan({ plan_kind: 'flat' }), plan({ plan_kind: 'metered' })]) {
      expect(costBasis(p)).not.toContain('equivalent')
    }
  })
})

describe('costLabel', () => {
  // A subscriber read the whole product as an accusation of waste — "all about
  // if you were a fool and paid for tokens instead of a subscription" (FB-026).
  // He was reading it correctly: the largest figure on the screen was headed
  // "Cost" and then denied it in grey underneath. The figure is right and the
  // word was wrong.
  it('does not call the figure a cost for someone who pays a flat fee', () => {
    const label = costLabel(plan({ plan_kind: 'flat', plan_label: 'Max 20×', plan_usd_per_month: 200 }))
    expect(label.toLowerCase()).not.toContain('cost')
    expect(label.toLowerCase()).toContain('worth')
  })

  it('still calls it a cost for someone billed per token', () => {
    // Metered users are charged for exactly these tokens, so the plain word is
    // the true one and softening it would be its own kind of lie.
    expect(costLabel(plan({ plan_kind: 'metered' }))).toBe('Cost')
  })

  it('calls it a cost when the plan is unknown', () => {
    // Nothing has been set, so nothing can be claimed about whose money it is.
    expect(costLabel(plan({}))).toBe('Cost')
    expect(costLabel(undefined)).toBe('Cost')
  })
})
