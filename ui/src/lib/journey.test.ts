import { describe, expect, it } from 'vitest'
import { journey, journeyOrder, progressOf, stageOf } from './journey'

describe('a pull request’s journey', () => {
  it('puts CI on its step while open, with its colour', () => {
    const red = journey({ state: 'open', card: { stage: 'fix', ci: 'fail', why: 'ci' } })
    expect(red.map((s) => s.state)).toEqual(['done', 'current', 'todo', 'todo'])
    expect(red[1]!).toMatchObject({ text: 'CI red', tone: 'fail' })
    expect(journey({ state: 'open', card: { stage: 'open', ci: 'running' } })[1]).toMatchObject({ text: 'CI running', tone: 'pending' })
    expect(journey({ state: 'open', card: { stage: 'fix', why: 'conflict' } })[1]!.text).toBe('Conflict')
    expect(progressOf(red)).toBe(2)
  })

  it('names the release it shipped in', () => {
    const s = journey({ state: 'merged', card: { stage: 'released', release: 'v0.117.1' } })
    expect(s.map((x) => x.state)).toEqual(['done', 'done', 'done', 'current'])
    expect(s[3]!.text).toBe('v0.117.1')
    expect(progressOf(s)).toBe(4)
  })

  it('tells a merged one waiting for a release, and a closed one', () => {
    expect(journey({ state: 'merged', card: { stage: 'merged' } })[2]).toMatchObject({ state: 'current', tone: 'merged' })
    expect(stageOf({ state: 'closed' })).toBe('closed')
    expect(journey({ state: 'closed' })[2]).toMatchObject({ state: 'closed', text: 'Closed' })
    expect(stageOf({ state: 'open', draft: true })).toBe('draft')
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
