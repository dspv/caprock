/**
 * The feed seeds from the NEWEST events, and getting that wrong is subtle: the
 * panel fills, the rows are real, and every one of them is a fortnight old.
 *
 * `api.events(id, after, limit)` pages FORWARD from `after`, so `events(id, 0,
 * 60)` returns the first sixty events a session ever recorded. On a session
 * with thousands that is ancient history presented as live activity — and the
 * reader's complaint is not "this is wrong" but "why can I only see old rows
 * and why won't it scroll", because every row is equally stale. The session
 * timeline had the identical defect.
 */
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ActivityFeed } from './ActivityFeed'
import type { Event, SessionSummary } from '@/lib/api'

const calls = vi.hoisted(() => ({ recent: [] as number[], forward: [] as number[] }))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      recentEvents: async (_id: string, limit: number) => {
        calls.recent.push(limit)
        return [ev(9_000, 'newest')]
      },
      events: async (_id: string, after: number) => {
        calls.forward.push(after)
        return [ev(1, 'ancient')]
      },
    },
  }
})

vi.mock('@/lib/live', async (orig) => {
  const actual = await orig<typeof import('@/lib/live')>()
  return { ...actual, live: { ...actual.live, onFrame: () => () => {} } }
})

const NOW = Date.parse('2026-09-01T12:00:00Z')

function ev(id: number, command: string): Event {
  return {
    id, ts: new Date(NOW - 60_000).toISOString(), session_id: 's1',
    source: 'hook', kind: 'tool.pre', tool: 'Bash',
    payload: { tool_input: { command } },
  } as Event
}

const session = (): SessionSummary =>
  ({ session_id: 's1', project: 'p', status: 'active', last_event_at: NOW } as SessionSummary)

describe('ActivityFeed', () => {
  it('asks for the newest events, never the first ones ever recorded', async () => {
    calls.recent = []
    calls.forward = []
    render(<ActivityFeed sessions={[session()]} now={NOW} />)

    await waitFor(() => expect(calls.recent.length).toBeGreaterThan(0))
    // The forward-paging call is the bug: it returns a session's opening
    // moments, which on a long session is a fortnight ago.
    expect(calls.forward).toHaveLength(0)
  })

  it('shows what just happened', async () => {
    calls.recent = []
    render(<ActivityFeed sessions={[session()]} now={NOW} />)
    await waitFor(() => expect(screen.getByText(/newest/)).toBeInTheDocument())
    expect(screen.queryByText(/ancient/)).toBeNull()
  })
})
