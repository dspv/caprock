import { describe, expect, it } from 'vitest'
import { asBoard, boardColumns, ciChip, costText, costTitle, initials, perDay } from './prboard'

describe('the board’s words', () => {
  it('reads an older daemon’s answer as no board, and an odd card as none', () => {
    expect(asBoard(undefined)).toBeUndefined()
    expect(asBoard({ cards: 'x' })).toBeUndefined()
    const b = asBoard({ cards: [{ number: 1, stage: 'ready' }, { number: 2, stage: 'lost' }], flow: { counts: { ready: 1 } } })!
    expect(b.cards.map((c) => c.number)).toEqual([1])
    expect(b.cards[0]!.spend).toEqual({ cost_usd: 0, sessions: 0, live: 0, agents: [], by_branch: 0, by_slice: 0 })
    expect(b.flow.counts.draft).toBe(0)
    expect(b.flow.days).toBe(14)
    expect(boardColumns(b, [{ number: 1, url: 'u', state: 'open', title: 'One' }]).map((c) => c.cards.length)).toEqual([0, 0, 0, 1, 0, 0])
  })

  it('says CI, cost and pace briefly, and never a cost with no session behind it', () => {
    expect(ciChip({ stage: 'fix', ci: 'pass', why: 'conflict' })?.text).toBe('conflict')
    expect(ciChip({ stage: 'open', ci: 'running' })?.tone).toBe('pending')
    expect(ciChip({ stage: 'open' })?.text).toBe('CI not read')
    expect(ciChip({ stage: 'released' })).toBeUndefined()
    expect(costText({ cost_usd: 0, sessions: 0, live: 0, agents: [] })).toBe('')
    expect(costText({ cost_usd: 0.004, sessions: 1, live: 0, agents: [] })).toBe('<$0.01')
    expect(costText({ cost_usd: 1411.9, sessions: 1, live: 0, agents: [] })).toBe('$1.4k')
    expect(costTitle({ cost_usd: 2, sessions: 2, live: 1, agents: ['claude', 'codex'] })).toContain('2 sessions (claude, codex), 1 running now')
    expect(perDay(13, 14)).toBe('0.9/day')
    expect(initials('dependabot[bot]')).toBe('DE')
    expect(initials('ada-lovelace')).toBe('AL')
  })
})
