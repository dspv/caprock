import { describe, expect, it } from 'vitest'
import { cumulativeCaption, isUnpricedTurn, sessionCost } from './sessionCost'

const tok = (n: number) => ({ in: n, out: 0, cache_read: 0, cache_write: 0 })

describe('a session cost with turns the pricing table could not price', () => {
  it('prints the sum when every turn was priced', () => {
    expect(sessionCost({ cost_usd: 1.5 }, 'claude-opus-5')).toEqual({ state: 'priced', value: '$1.50' })
    // A daemon before the field sends nothing: the old figure stands.
    expect(sessionCost({ cost_usd: 0, unpriced_turns: 0 }).value).toBe('$0.00')
  })

  it('says the price is unknown, not $0.00, when no turn was priced', () => {
    const c = sessionCost({ cost_usd: 0, unpriced_turns: 12 }, 'kimi-k3')
    expect(c.state).toBe('unknown')
    expect(c.value).toBe('—')
    expect(c.note).toBe('price unknown')
    expect(c.title).toMatch(/kimi-k3 has no published price in Caprock's pricing table/)
  })

  it('keeps the priced sum and notes the turns left out of it', () => {
    const c = sessionCost({ cost_usd: 2, unpriced_turns: 3 }, 'kimi-k3')
    expect(c).toMatchObject({ state: 'partial', value: '$2.00', note: '+ 3 unpriced turns' })
    expect(sessionCost({ cost_usd: 2, unpriced_turns: 1 }).note).toBe('+ 1 unpriced turn')
  })
})

describe('the cumulative cost caption', () => {
  const priced = { kind: 'turn.assistant', cost_usd: 0.5, tokens: tok(10) }
  const unpriced = { kind: 'turn.assistant', tokens: tok(10) }

  it('counts only priced turns as priced', () => {
    expect(cumulativeCaption([priced, priced])).toBe('2 priced turns · $1.00')
    expect(cumulativeCaption([priced, unpriced, unpriced])).toBe('1 priced turn · $0.50 · + 2 unpriced')
  })

  it('never folds an all-unpriced session into $0.00', () => {
    expect(cumulativeCaption([unpriced, unpriced])).toBe('2 turns · price unknown')
  })

  it('a turn with no tokens has nothing to price', () => {
    expect(isUnpricedTurn({ kind: 'turn.assistant', tokens: tok(0) })).toBe(false)
    expect(isUnpricedTurn({ kind: 'tool.pre', tokens: tok(5) })).toBe(false)
    expect(isUnpricedTurn(unpriced)).toBe(true)
  })
})
