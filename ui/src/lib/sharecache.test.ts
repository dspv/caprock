import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls = { week: 0 }
const gates: Array<() => void> = []

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      // The answer waits for the test to let it through, so sharing one
      // request between callers can be watched.
      weekFor: (p: string) => {
        calls.week++
        return new Promise((r) => gates.push(() => r({ start: '2026-10-04', end: '2026-10-04', days: [], agents: [], period: p })))
      },
    },
  }
})

import { currentStory, fetchStory, lastStory, resetShareCache } from './sharecache'

beforeEach(() => {
  resetShareCache()
  localStorage.clear()
  calls.week = 0
  gates.length = 0
})

const drain = async () => { while (gates.length) { gates.shift()!(); await new Promise((r) => setTimeout(r, 0)) } }

describe('share cache', () => {
  it('shares one request per period between everyone who asks', async () => {
    const a = fetchStory('7d')
    const b = fetchStory('7d')
    expect(a).toBe(b)
    expect(calls.week).toBe(1)
    await drain()
    expect((await a).period).toBe('7d')
  })

  it('keeps the last card for the next tab, and reuses a fresh reading', async () => {
    const p = fetchStory('all')
    await drain()
    await p
    resetShareCache() // a new tab: memory gone, localStorage kept
    expect(lastStory('all')?.value.period).toBe('all')
    expect(lastStory('today')).toBeUndefined()
    // Within a minute, saving does not ask again.
    const p2 = fetchStory('30d')
    await drain()
    await p2
    await currentStory('30d')
    expect(calls.week).toBe(2)
  })

  it('drops a kept reading of another shape, or of the old count, rather than half-drawing it', () => {
    localStorage.setItem('caprock-share-story-v2-all', 'not json')
    expect(lastStory('all')).toBeUndefined()
    localStorage.setItem('caprock-share-story-v2-7d', JSON.stringify({ at: 1, value: { period: '7d' } }))
    expect(lastStory('7d')).toBeUndefined()
    // A v1 reading counted only the agents' merges: not shown.
    localStorage.setItem('caprock-share-story-v1-30d', JSON.stringify({ at: 1, value: { start: 'a', days: [], agents: [] } }))
    expect(lastStory('30d')).toBeUndefined()
  })
})
