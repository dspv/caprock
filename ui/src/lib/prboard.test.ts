import { afterEach, describe, expect, it, vi } from 'vitest'
import { EXPENSIVE_PERIOD_KEY, asBoard, asCostliest, boardColumns, ciChip, costText, costTitle, initials, perDay, periodWords, readExpensivePeriod, writeExpensivePeriod } from './prboard'

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
// most expensive releases" … "by default a month".
describe('the most expensive pull requests and releases', () => {
  afterEach(() => { localStorage.clear(); vi.restoreAllMocks() })

  it('is the month until All time is picked, remembered on this device', () => {
    expect(readExpensivePeriod()).toBe('30')
    writeExpensivePeriod('all')
    expect(localStorage.getItem(EXPENSIVE_PERIOD_KEY)).toBe('all')
    expect(readExpensivePeriod()).toBe('all')
    writeExpensivePeriod('30')
    expect(localStorage.getItem(EXPENSIVE_PERIOD_KEY)).toBeNull()
    localStorage.setItem(EXPENSIVE_PERIOD_KEY, 'week')
    expect(readExpensivePeriod()).toBe('30')
  })

  it('falls back to the month when storage is closed, and never throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    expect(readExpensivePeriod()).toBe('30')
    expect(() => writeExpensivePeriod('all')).not.toThrow()
  })

  it('names the period honestly', () => {
    expect(periodWords(30)).toBe('last 30 days')
    expect(periodWords(14)).toBe('last 14 days')
    expect(periodWords(0)).toBe('all time')
  })

  it('reads the daemon’s answer defensively: an older daemon’s 404 body or an odd row is none', () => {
    expect(asCostliest(undefined)).toBeUndefined()
    expect(asCostliest({ error: 'not found' })).toBeUndefined()
    const c = asCostliest({
      repo: 'a/b', days: 30, since: 5, prs_known: 3, prs_counted: 1, releases_counted: 1, tags_read: true,
      prs: [{ number: 7, url: 'u', title: 'Seven', state: 'merged', at: 9, spend: { cost_usd: 2, sessions: 1, live: 0, agents: ['claude'] } }, { title: 'no number' }],
      releases: [{ tag: 'v1.0.0', at: 1, url: 'r', prs: [7, 'x'], cost_usd: 2, sessions: 1, first: true }, { prs: [] }],
    })!
    expect(c.prs).toHaveLength(1)
    expect(c.prs[0]).toMatchObject({ number: 7, title: 'Seven', state: 'merged', spend: { cost_usd: 2, sessions: 1 } })
    expect(c.releases).toEqual([{ tag: 'v1.0.0', at: 1, url: 'r', prs: [7], cost_usd: 2, sessions: 1, first: true }])
    expect(c.tags_read).toBe(true)
  })
})
