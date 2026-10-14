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
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
        return [ev(9_000, 'git commit -m "newest"'), ev(9_001, 'sed -n 150,260p internal/github/branchpulls.go')]
      },
      events: async (_id: string, after: number) => {
        calls.forward.push(after)
        return [ev(1, 'git commit -m "ancient"')]
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

  // The owner, 2026-10-14 (translated): "This block is completely
  // uninformative" — of a feed of `sed -n …` and `cat …` lines.
  it('shows what happened, not every command, until asked for all of them', async () => {
    try { localStorage.removeItem('caprock.activity.mode') } catch { /* none */ }
    render(<ActivityFeed sessions={[session()]} now={NOW} />)
    await waitFor(() => expect(screen.getByText('newest')).toBeInTheDocument())
    expect(screen.getByText('What happened')).toBeInTheDocument()
    expect(screen.queryByText(/sed -n/)).toBeNull()
    // The read is counted on the moment, not dropped silently.
    fireEvent.click(screen.getByRole('button', { name: 'All commands' }))
    await waitFor(() => expect(screen.getByText(/sed -n/)).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'All commands' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'All commands' }))
  })

  it('folds like the other panels', async () => {
    render(<ActivityFeed sessions={[session()]} now={NOW} />)
    await waitFor(() => expect(screen.getByText('newest')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /What happened/ }))
    expect(screen.queryByText('newest')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /What happened/ }))
    await waitFor(() => expect(screen.getByText('newest')).toBeInTheDocument())
  })

  it('gives every row the same height', async () => {
    render(<ActivityFeed sessions={[session()]} now={NOW} />)
    await waitFor(() => expect(screen.getByText('newest')).toBeInTheDocument())
    for (const row of screen.getAllByTestId('activity-row')) expect(row.className).toMatch(/\bh-7\b/)
  })
})
