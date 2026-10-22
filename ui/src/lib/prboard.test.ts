import { describe, expect, it } from 'vitest'
import { asBoard, boardColumns, ciChip, costText, costTitle, initials, perDay, topPRs, topReleases, type BoardRelease, type PRBoard } from './prboard'

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

  it('reads the figures’ series: a missing value stays a gap, an odd series or point is dropped', () => {
    const b = asBoard({ cards: [], flow: { counts: {}, series: {
      ci: [{ day: '2026-10-13', n: 0 }, { day: '2026-10-14', value: 430_000, n: 2 }, { value: 1 }],
      throughput: [{ day: '2026-10-14', value: 2, n: 2, by_now: 1 }],
      fix: [{ day: '2026-10-14', value: 1, n: 1 }],
      ttm: 'x',
    } } })!
    expect(b.flow.series?.ci).toEqual([{ day: '2026-10-13', value: undefined, n: 0, by_now: undefined }, { day: '2026-10-14', value: 430_000, n: 2, by_now: undefined }])
    expect(b.flow.series?.throughput?.[0]?.by_now).toBe(1)
    expect(b.flow.series && 'fix' in b.flow.series).toBe(false)
    expect(b.flow.series?.ttm).toBeUndefined()
    expect(asBoard({ cards: [], flow: {} })!.flow.series).toBeUndefined()
  })
})

// Owner, 2026-10-23, translated: "TOP-5 most expensive pull requests and TOP-5
// most expensive releases".
describe('the most expensive pull requests and releases', () => {
  const spend = (cost_usd: number, sessions: number) => ({ cost_usd, sessions, live: 0, agents: [] })
  const rel = (tag: string, cost_usd: number, sessions: number, prs: number[], published_at: number): BoardRelease => ({ tag, cost_usd, sessions, prs, published_at })
  const board = (cards: unknown[], releases: BoardRelease[] = []): PRBoard => asBoard({ cards, releases, flow: {} })!

  it('ranks the pull requests dearest first, five at most, joined with their titles', () => {
    const b = board([1, 2, 3, 4, 5, 6, 7].map((n) => ({ number: n, stage: 'merged', spend: spend(n * 1.5, 1) })))
    const top = topPRs(b, [{ number: 7, url: 'https://github.com/a/b/pull/7', state: 'merged', title: 'Seven' }])
    expect(top.map((p) => p.number)).toEqual([7, 6, 5, 4, 3])
    expect(top[0]).toMatchObject({ title: 'Seven', url: 'https://github.com/a/b/pull/7', stage: 'merged' })
    expect(top[1]!.title).toBeUndefined()
    // The board's own order is left alone.
    expect(b.cards.map((c) => c.number)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('breaks a tie by more sessions, then the newer number', () => {
    const b = board([
      { number: 10, stage: 'open', spend: spend(4, 1) },
      { number: 11, stage: 'open', spend: spend(4, 3) },
      { number: 12, stage: 'ready', spend: spend(4, 1) },
    ])
    expect(topPRs(b, []).map((p) => p.number)).toEqual([11, 12, 10])
  })

  it('leaves out a pull request with no recorded session or no cost, and says fewer than five or none', () => {
    const b = board([
      { number: 1, stage: 'open', spend: spend(0, 0) },
      { number: 2, stage: 'open', spend: spend(0, 2) },
      { number: 3, stage: 'merged', spend: spend(0.004, 1) },
    ])
    expect(topPRs(b, []).map((p) => p.number)).toEqual([3])
    expect(topPRs(board([]), [])).toEqual([])
  })

  it('ranks the releases by what their merges cost, ties by more pull requests then the newer, none at no cost', () => {
    const b = board([], [
      rel('v1.6.0', 2, 1, [6], 600), rel('v1.5.0', 9, 4, [5, 4], 500), rel('v1.4.0', 0, 0, [], 400),
      rel('v1.3.0', 2, 1, [3, 2], 300), rel('v1.2.0', 2, 1, [1], 200), rel('v1.1.0', 1, 1, [8], 100), rel('v1.0.0', 0.5, 1, [9], 50),
    ])
    expect(topReleases(b).map((r) => r.tag)).toEqual(['v1.5.0', 'v1.3.0', 'v1.6.0', 'v1.2.0', 'v1.1.0'])
    expect(topReleases(board([], [rel('v2', 0, 0, [], 1)]))).toEqual([])
    expect(topReleases(board([]))).toEqual([])
    expect(topReleases(b, 2).map((r) => r.tag)).toEqual(['v1.5.0', 'v1.3.0'])
    // The board's newest-first order is left alone.
    expect(b.releases[0]!.tag).toBe('v1.6.0')
  })
})
