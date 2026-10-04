import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Summary, History } from './api'

const calls = { summary: 0, history: 0, week: 0 }
const gates: Array<() => void> = []

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  const summary = { cost_usd: 5, sessions: 2, tokens_in: 1, tokens_out: 1, cache_read: 1, cache_write: 1, models: [], work: [] } as unknown as Summary
  const history = { totals: { cost_usd: 50, days: 3, sessions: 9 }, summary } as unknown as History
  return {
    ...actual,
    api: {
      ...actual.api,
      // Each answer waits for the test to let it through, so progress can be
      // watched one range at a time.
      summary: () => { calls.summary++; return new Promise((r) => gates.push(() => r(summary))) },
      history: () => { calls.history++; return new Promise((r) => gates.push(() => r(history))) },
      weekFor: async (p: string) => { calls.week++; return { start: '2026-10-04', end: '2026-10-04', days: [], agents: [], period: p } },
    },
  }
})

import { currentFigures, fetchFigures, fetchStory, lastFigures, lastStory, resetShareCache } from './sharecache'

beforeEach(() => {
  resetShareCache()
  localStorage.clear()
  calls.summary = 0; calls.history = 0; calls.week = 0
  gates.length = 0
})

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('share cache', () => {
  it('shares one round of requests and reports each range as it lands', async () => {
    const seen: number[] = []
    const a = fetchFigures('7d', (done) => seen.push(done.size))
    const b = fetchFigures('7d')
    expect(a).toBe(b)
    expect(calls.summary).toBe(3)
    expect(calls.history).toBe(1)
    while (gates.length) { gates.shift()!(); await flush() }
    const data = await a
    expect(data.period).toBe('7d')
    expect(seen).toEqual([0, 1, 2, 3, 4])
  })

  it('keeps the last figures for the next tab, and reuses a fresh reading', async () => {
    const p = fetchFigures('30d')
    while (gates.length) { gates.shift()!(); await flush() }
    await p
    resetShareCache() // a new tab: memory gone, localStorage kept
    const kept = lastFigures('30d')
    expect(kept?.value.allTime.cost).toBe(50)
    expect(kept?.value.takenAt).toBeInstanceOf(Date)
    expect(lastFigures('today')).toBeUndefined()
    // Within a minute, saving does not ask again.
    await currentFigures('30d')
    expect(calls.summary).toBe(3)
  })

  it('drops a kept reading of another shape rather than half-drawing it', () => {
    localStorage.setItem('caprock-share-figures-v1-7d', JSON.stringify({ at: 1, value: { period: '7d' } }))
    expect(lastFigures('7d')).toBeUndefined()
    localStorage.setItem('caprock-share-story-v1-all', 'not json')
    expect(lastStory('all')).toBeUndefined()
  })

  it('keeps the story card per period', async () => {
    await fetchStory('all')
    resetShareCache()
    expect(lastStory('all')?.value.period).toBe('all')
    expect(calls.week).toBe(1)
  })
})
