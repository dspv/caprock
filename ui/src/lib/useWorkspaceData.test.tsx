/**
 * A missed `permission` frame must not leave a prompt (and the app's badge)
 * stale: after a live `reset`, every live owned session is asked again.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { live } from './live'
import { resyncPermissions, useWorkspaceData } from './useWorkspaceData'
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
