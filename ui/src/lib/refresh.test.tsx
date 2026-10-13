/**
 * One refresh for the Now screen (lib/refresh.ts): under a steady stream of
 * hook events each section asked on every live tick, about 770 requests a
 * minute with four panels asking the same question (bench, 2026-10-13).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useApi } from './useApi'
import { live } from './live'
import { LivePace, NOW_LIVE_MS, SLOW_LIVE_MS, shared } from './refresh'
import { PANEL_FOLDS_KEY } from '@/components/ui'
import { BreakdownPanel } from '@/components/Breakdown'
import type { History } from './api'

const calls = vi.hoisted(() => ({ history: 0 }))

vi.mock('./api', async (orig) => {
  const actual = await orig<typeof import('./api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      history: async () => {
        calls.history++
        return {
          totals: {},
          tools: [{ tool: 'Bash', count: 4 }],
          summary: { models: [{ model: 'claude-opus-5', tokens: 10, output: 1, turns: 1, cost_usd: 1 }], projects: [] },
        } as unknown as History
      },
    },
  }
})

/** N live events, as the daemon sends one per hook. */
function events(n: number) {
  for (let i = 0; i < n; i++) live.handle({ type: 'session', data: { session_id: `s${i % 3}`, tick: i } as never })
}

/** Lets the timers and the answers they asked for land. */
async function advance(ms: number) {
  await act(async () => { vi.advanceTimersByTime(ms) })
  await act(async () => {})
}

beforeEach(() => {
  vi.useFakeTimers()
  calls.history = 0
})
afterEach(() => {
  vi.useRealTimers()
})

describe('the Now screen refreshes once', () => {
  it('asks one request for a burst of events, shared by every section asking the same question', async () => {
    let fetches = 0
    const ask = () => { fetches++; return Promise.resolve(fetches) }
    const Section = () => {
      const q = useApi(ask, [], { share: 'today' })
      return <span>{q.data ?? '-'}</span>
    }
    render(
      <LivePace.Provider value={NOW_LIVE_MS}>
        <Section /><Section /><Section />
      </LivePace.Provider>,
    )
    await act(async () => {})
    // Three sections, one question, one request.
    expect(fetches).toBe(1)

    // Twenty events inside one pace: one more request, not twenty (or sixty).
    await act(async () => { events(20) })
    await advance(NOW_LIVE_MS / 2)
    expect(fetches).toBe(1)
    await advance(NOW_LIVE_MS)
    expect(fetches).toBe(2)

    // Quiet: nothing more.
    await advance(NOW_LIVE_MS * 3)
    expect(fetches).toBe(2)
  })

  it('a section never refreshes faster than its own pace, whatever the screen allows', async () => {
    let fetches = 0
    const Slow = () => {
      useApi(() => { fetches++; return Promise.resolve(1) }, [], { liveMs: SLOW_LIVE_MS })
      return null
    }
    render(<LivePace.Provider value={NOW_LIVE_MS}><Slow /></LivePace.Provider>)
    await act(async () => {})
    for (let i = 0; i < 4; i++) {
      await act(async () => { events(5) })
      await advance(NOW_LIVE_MS)
    }
    expect(fetches).toBe(1)
    await advance(SLOW_LIVE_MS)
    expect(fetches).toBe(2)
  })

  it('a folded section asks nothing on events, and once when it is opened', async () => {
    localStorage.setItem(PANEL_FOLDS_KEY, JSON.stringify(['now.all-time']))
    render(<BreakdownPanel />)
    await act(async () => {})
    // Its first answer decides whether the panel is there at all.
    expect(calls.history).toBe(1)
    expect(screen.queryByText('Most-used tools')).toBeNull()

    for (let i = 0; i < 3; i++) {
      await act(async () => { events(10) })
      await advance(SLOW_LIVE_MS)
    }
    expect(calls.history).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: /all time/i }))
    await act(async () => {})
    expect(calls.history).toBe(2)
    expect(screen.getByText('Most-used tools')).toBeTruthy()
  })

  it('a hidden page asks nothing, and once on showing', async () => {
    let fetches = 0
    const Section = () => {
      useApi(() => { fetches++; return Promise.resolve(1) }, [])
      return null
    }
    render(<LivePace.Provider value={NOW_LIVE_MS}><Section /></LivePace.Provider>)
    await act(async () => {})
    expect(fetches).toBe(1)
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => { events(10) })
    await advance(NOW_LIVE_MS * 5)
    expect(fetches).toBe(1)
    vis.mockReturnValue('visible')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await advance(0)
    expect(fetches).toBe(2)
    vis.mockRestore()
  })
})

describe('shared', () => {
  it('joins a request in flight and never hands over a failure', async () => {
    let n = 0
    const fail = () => { n++; return Promise.reject(new Error('no')) }
    await Promise.allSettled([shared('x', fail), shared('x', fail)])
    expect(n).toBe(1)
    await shared('x', fail).catch(() => {})
    expect(n).toBe(2)
  })
})
