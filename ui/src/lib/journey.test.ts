import { describe, expect, it } from 'vitest'
import { flightLead, inFlight, journey, journeyOrder, pipelineRows, progressOf, releaseNote, shipsOf, stageOf } from './journey'

describe('a pull request’s journey', () => {
  it('puts CI on its step while open, with its colour', () => {
    const red = journey({ state: 'open', card: { stage: 'fix', ci: 'fail', why: 'ci' } })
    expect(red.map((s) => s.state)).toEqual(['done', 'current', 'todo'])
    expect(red[1]!).toMatchObject({ text: 'CI red', tone: 'fail' })
    expect(journey({ state: 'open', card: { stage: 'open', ci: 'running' } })[1]).toMatchObject({ text: 'CI running', tone: 'pending' })
    expect(journey({ state: 'open', card: { stage: 'fix', why: 'conflict' } })[1]!.text).toBe('Conflict')
    expect(progressOf(red)).toBe(2)
  })

  // Owner, 2026-10-20, translated: the final status should be merged — a
  // grey Released block read as unfinished, or closed.
  it('ends at merged: a merge, released or not, is the last step and fills the bar', () => {
    for (const card of [{ stage: 'merged' as const }, { stage: 'released' as const, release: 'v0.117.1' }]) {
      const s = journey({ state: 'merged', card })
      expect(s.map((x) => x.key)).toEqual(['open', 'ci', 'merged'])
      expect(s.map((x) => x.state)).toEqual(['done', 'done', 'current'])
      expect(s[2]).toMatchObject({ text: 'Merged', tone: 'merged' })
      expect(progressOf(s)).toBe(s.length)
    }
    expect(journey({ state: 'open', card: { stage: 'open', ci: 'running' } })).toHaveLength(3)
  })

  it('keeps a closed one distinct: its last step closed, CI never filled', () => {
    expect(stageOf({ state: 'closed' })).toBe('closed')
    const c = journey({ state: 'closed' })
    expect(c.map((s) => s.state)).toEqual(['done', 'todo', 'closed'])
    expect(c[2]).toMatchObject({ text: 'Closed', tone: 'muted' })
    expect(stageOf({ state: 'open', draft: true })).toBe('draft')
  })

  it('says the release after the steps: its tag once shipped, "not released" where releases are cut, nothing elsewhere', () => {
    const m = { state: 'merged' as const, card: { stage: 'merged' as const } }
    expect(releaseNote({ state: 'merged', card: { stage: 'released', release: 'v0.117.1' } })).toMatchObject({ text: 'in v0.117.1', released: true })
    expect(releaseNote(m, { ships: 'release', lastRelease: 'v0.132.0' })).toMatchObject({ text: 'not released', released: false, title: expect.stringContaining('after v0.132.0') })
    expect(releaseNote(m, { ships: 'release', next: '0.133.0' })!.title).toContain('(v0.133.0')
    expect(releaseNote(m, { ships: 'merge' })).toBeUndefined()
    expect(releaseNote(m)).toBeUndefined()
    expect(releaseNote({ state: 'open', card: { stage: 'ready' } }, { ships: 'release' })).toBeUndefined()
    expect(releaseNote({ state: 'closed' }, { ships: 'release' })).toBeUndefined()
  })

  it('reads how the repository ships, and its newest release, from the board', () => {
    const board = { cards: [], releases: [{ tag: 'v1', published_at: 1, prs: [], cost_usd: 0, sessions: 0 }, { tag: 'v2', published_at: 5, prs: [], cost_usd: 0, sessions: 0 }], flow: {} as never, ships_by: 'release' as const }
    expect(shipsOf(board)).toEqual({ ships: 'release', lastRelease: 'v2', next: undefined })
    expect(shipsOf(undefined)).toEqual({ ships: undefined, lastRelease: undefined, next: undefined })
  })

  it('lists in flight first, then merged, then released, newest merges first', () => {
    const rows = [
      { n: 1, state: 'merged' as const, card: { stage: 'released' as const, stage_at: 10 } },
      { n: 2, state: 'merged' as const, card: { stage: 'released' as const, stage_at: 30 } },
      { n: 3, state: 'open' as const, card: { stage: 'ready' as const, stage_at: 5 } },
      { n: 4, state: 'merged' as const, card: { stage: 'merged' as const, stage_at: 20 } },
      { n: 5, state: 'open' as const, card: { stage: 'fix' as const, stage_at: 50 } },
      { n: 6, state: 'open' as const, card: { stage: 'open' as const, stage_at: 7 } },
    ]
    expect(journeyOrder(rows).map((r) => r.n)).toEqual([5, 6, 3, 4, 2, 1])
  })
})

// Owner, 2026-10-16, translated: "on the right it sometimes shows too many
// PRs, e.g. for caprock-web".
describe('what is in flight', () => {
  const spend = { cost_usd: 0, sessions: 0, live: 0, agents: [] }
  const flow = { counts: {} as never, days: 14, merged: 0, ttm_count: 0, release_lag_count: 0, cost_usd: 0 }
  const pr = (number: number, state: 'open' | 'closed' | 'merged', at: number) => ({ number, url: `u/${number}`, title: `PR ${number}`, state, created_at: at - 100, merged_at: state === 'merged' ? at : undefined })
  const rowsOf = (prs: ReturnType<typeof pr>[], board: Parameters<typeof pipelineRows>[1]) => pipelineRows(prs, board, [])

  it('keeps the open ones and the merges since the newest release, and drops released and closed ones', () => {
    const board = {
      cards: [
        { number: 5, stage: 'fix' as const, stage_at: 900, spend },
        { number: 4, stage: 'merged' as const, stage_at: 800, spend },
        { number: 3, stage: 'released' as const, release: 'v2', stage_at: 700, spend },
      ],
      releases: [{ tag: 'v1', published_at: 300, prs: [], cost_usd: 0, sessions: 0 }, { tag: 'v2', published_at: 700, prs: [3], cost_usd: 0, sessions: 0 }],
      flow,
    }
    // #2 merged before the board's window, with no card: shipped in v1.
    const f = inFlight(rowsOf([pr(5, 'open', 900), pr(4, 'merged', 800), pr(3, 'merged', 600), pr(2, 'merged', 200), pr(1, 'closed', 100)], board), board)
    expect(f.rows.map((r) => r.number)).toEqual([5, 4])
    expect(f.recent).toEqual([])
    expect(f.release).toEqual({ tag: 'v2', published_at: 700 })
    expect(flightLead(f)?.number).toBe(5)
  })

  it('has only open ones in flight where no release is published, and the newest three merges as context', () => {
    // caprock-web's shape on 2026-10-16: 48 merged, 2 closed, no release.
    const prs = [pr(9, 'merged', 900), pr(8, 'merged', 800), pr(7, 'closed', 750), pr(6, 'merged', 700), pr(5, 'merged', 600)]
    const board = { cards: prs.filter((p) => p.state === 'merged').map((p) => ({ number: p.number, stage: 'merged' as const, stage_at: p.merged_at, spend })), releases: [], flow }
    const f = inFlight(rowsOf(prs, board), board)
    expect(f.rows).toEqual([])
    expect(f.release).toBeUndefined()
    expect(f.recent.map((r) => r.number)).toEqual([9, 8, 6])
    expect(flightLead(f)).toBeUndefined()
    // An open one is in flight there, and it leads.
    const g = inFlight(rowsOf([pr(10, 'open', 950), ...prs], board), board)
    expect(g.rows.map((r) => r.number)).toEqual([10])
    expect(flightLead(g)?.number).toBe(10)
  })

  it('leads with the newest merge when nothing is open', () => {
    const board = { cards: [{ number: 4, stage: 'merged' as const, stage_at: 800, spend }, { number: 3, stage: 'merged' as const, stage_at: 900, spend }],
      releases: [{ tag: 'v1', published_at: 500, prs: [], cost_usd: 0, sessions: 0 }], flow }
    const f = inFlight(rowsOf([pr(4, 'merged', 800), pr(3, 'merged', 900)], board), board)
    expect(flightLead(f)?.number).toBe(3)
  })

  it('never keeps a merge in flight where the repository ships on merge, whatever old release it published', () => {
    const board = { cards: [{ number: 4, stage: 'merged' as const, stage_at: 800, spend }],
      releases: [{ tag: 'v0.1.0', published_at: 100, prs: [], cost_usd: 0, sessions: 0 }], flow, ships_by: 'merge' as const }
    const f = inFlight(rowsOf([pr(4, 'merged', 800)], board), board)
    expect(f.rows).toEqual([])
    expect(f.recent.map((r) => r.number)).toEqual([4])
    expect(f.ships).toBe('merge')
  })
})
