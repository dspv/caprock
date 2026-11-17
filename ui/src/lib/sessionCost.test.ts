import { describe, expect, it } from 'vitest'
import { costLine, cumulativeCaption, isUnpricedTurn, sessionCost } from './sessionCost'

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

describe('a session cost the agent keeps no record of', () => {
  it('names the agent instead of blaming the pricing table', () => {
    const c = sessionCost({ cost_usd: 0, unpriced_turns: 4 }, 'claude-4-sonnet', "Cursor doesn't record a cost for this chat")
    expect(c).toMatchObject({ state: 'unknown', value: '—', note: "Cursor doesn't record a cost for this chat" })
    // A priced sum stays a priced sum.
    expect(sessionCost({ cost_usd: 2, unpriced_turns: 1 }, 'm', 'gap').state).toBe('partial')
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

  it('leaves out a resumed session\'s replayed turn, which has no tokens and $0', () => {
    const replayed = { kind: 'turn.assistant', cost_usd: 0, tokens: tok(0) }
    expect(cumulativeCaption([replayed, unpriced])).toBe('1 turn · price unknown')
    expect(cumulativeCaption([replayed, priced])).toBe('1 priced turn · $0.50')
  })

  it('a turn with no tokens has nothing to price', () => {
    expect(isUnpricedTurn({ kind: 'turn.assistant', tokens: tok(0) })).toBe(false)
    expect(isUnpricedTurn({ kind: 'tool.pre', tokens: tok(5) })).toBe(false)
    expect(isUnpricedTurn(unpriced)).toBe(true)
  })
})

describe('the cumulative cost line', () => {
  const tool = { kind: 'tool.post', tokens: undefined }
  const reply = { kind: 'turn.assistant', cost_usd: 0, tokens: tok(10) }

  it('follows the whole session, not the 60 events loaded, so a Cursor chat is not $0.00 flat', () => {
    // The usage record holding the chat's $51.55 is older than every event
    // loaded: the loaded window alone summed to nothing.
    const loaded = [reply, ...Array.from({ length: 59 }, () => tool)]
    const series = { points: [{ ts: 1, usd: 0 }, { ts: 2, usd: 51.55 }], priced_turns: 1 }
    const line = costLine(series, loaded)
    expect(line.values).toEqual([0, 0, 51.55])
    expect(line.values.at(-1)).toBe(51.55)
    expect(line.caption).toBe('1 priced turn · $51.55')
  })

  it('names usage totals that are nobody\'s turn', () => {
    const series = { points: [{ ts: 1, usd: 4.2 }], priced_turns: 0 }
    expect(costLine(series, []).caption).toBe("$4.20 · from the agent's usage totals")
  })

  it('keeps unpriced turns beside the sum and never says $0.00 for them alone', () => {
    expect(costLine({ points: [{ ts: 1, usd: 2 }], priced_turns: 3 }, [], 2).caption).toBe('3 priced turns · $2.00 · + 2 unpriced')
    const none = costLine({ points: [], priced_turns: 0 }, [], 4)
    expect(none.caption).toBe('4 turns · price unknown')
    expect(none.values).toEqual([0, 0])
  })

  it('falls back to the loaded turns from a daemon that sends no series', () => {
    const priced = { kind: 'turn.assistant', cost_usd: 0.5, tokens: tok(10) }
    expect(costLine(undefined, [priced, tool, priced])).toEqual({ values: [0.5, 1], caption: '2 priced turns · $1.00' })
    expect(costLine(undefined, []).values).toEqual([0, 0])
  })
})
