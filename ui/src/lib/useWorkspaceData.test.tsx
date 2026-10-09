/**
 * A missed `permission` frame must not leave a prompt (and the app's badge)
 * stale: after a live `reset`, every live owned session is asked again.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { live } from './live'
import { applySessionFrames, mergeSessions, resyncPermissions, SESSION_FRAMES_MS, useWorkspaceData } from './useWorkspaceData'
import type { SessionSummary } from './api'

const pending = vi.hoisted(() => ({ ids: new Set<string>(['a']) }))

vi.mock('./api', async (orig) => {
  const actual = await orig<typeof import('./api')>()
  const sessions = [
    { session_id: 'a', owned: true, status: 'active' },
    { session_id: 'b', owned: true, status: 'active' },
  ] as SessionSummary[]
  return {
    ...actual,
    api: {
      ...actual.api,
      sessions: async () => sessions,
      summary: async () => ({ cost_usd: 0, projects: [] }),
      permission: async (id: string) => ({ permission: pending.ids.has(id) ? { id: 'p' } : null }),
    },
  }
})

vi.mock('./projects', async (orig) => {
  const actual = await orig<typeof import('./projects')>()
  return { ...actual, projectsApi: { ...actual.projectsApi, list: async () => [], shells: async () => [] } }
})

describe('useWorkspaceData after a live reset', () => {
  it('drops a prompt answered while frames were lost, and picks up a new one', async () => {
    const { result } = renderHook(() => useWorkspaceData())
    await waitFor(() => expect([...result.current.permissions]).toEqual(['a']))
    // While the socket was away: a's prompt was answered, b got one; both frames lost.
    pending.ids = new Set(['b'])
    act(() => live.handle({ type: 'reset', data: { seq: 99 } }))
    await waitFor(() => expect([...result.current.permissions]).toEqual(['b']))
  })
})

describe('resyncPermissions', () => {
  it('keeps what it knew for a session whose answer failed, and drops ended ones', () => {
    const next = resyncPermissions(new Set(['a', 'gone']), new Map([['a', 'unknown'], ['b', 'none']] as const))
    expect([...next]).toEqual(['a'])
  })
})

describe('session updates that re-render nothing', () => {
  const s = (id: string, status = 'active') => ({ session_id: id, owned: true, status }) as SessionSummary

  it('a refetch that changes nothing gives back the list held', () => {
    const held = [s('a'), s('b')]
    expect(mergeSessions(held, [s('a'), s('b')])).toBe(held)
    const next = mergeSessions(held, [s('b', 'ended')])
    expect(next).not.toBe(held)
    expect(next.map((x) => x.status)).toEqual(['active', 'ended'])
    expect(mergeSessions(held, [s('c')]).map((x) => x.session_id)).toEqual(['a', 'b', 'c'])
  })

  it('applies a batch of frames in order, and only to sessions it holds', () => {
    const held = [s('a'), s('b')]
    expect(applySessionFrames(held, [['zz', { session: { session_id: 'zz' } }]])).toBe(held)
    const next = applySessionFrames(held, [
      ['a', { session: { session_id: 'a', status: 'idle' } as Partial<SessionSummary> }],
      ['a', { session: { session_id: 'a', status: 'ended' } as Partial<SessionSummary> }],
    ])
    expect(next.map((x) => x.status)).toEqual(['ended', 'active'])
    expect(next[1]).toBe(held[1])
  })

  it('folds a burst of session frames into one update', async () => {
    const { result } = renderHook(() => useWorkspaceData())
    await waitFor(() => expect(result.current.sessions.map((x) => x.session_id)).toEqual(['a', 'b']))
    vi.useFakeTimers()
    try {
      const before = result.current.sessions
      act(() => {
        for (const status of ['idle', 'active', 'ended']) {
          live.handle({ type: 'session', data: { session: { session_id: 'b', status } } as never })
        }
      })
      expect(result.current.sessions).toBe(before)
      act(() => { vi.advanceTimersByTime(SESSION_FRAMES_MS) })
      expect(result.current.sessions.find((x) => x.session_id === 'b')?.status).toBe('ended')
    } finally {
      vi.useRealTimers()
    }
  })
})
