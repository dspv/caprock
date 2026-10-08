/**
 * The menu bar popover's page: what needs you first, Approve only with the
 * whole request shown, a calm empty state, keys that move and close.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Permission, SessionSummary } from '@/lib/api'
import { ApiError } from '@/lib/api'

const state: { sessions: SessionSummary[]; perms: Record<string, Permission> } = { sessions: [], perms: {} }
const answer = vi.fn(async () => undefined as void)

function sess(p: Partial<SessionSummary>): SessionSummary {
  return {
    session_id: 's', cwd: '/w/app', repo_root: '/w/app', project: 'app', model: 'claude-opus-5', started_at: Date.now() - 5 * 60_000, last_event_at: Date.now(),
    status: 'active', transcript_path: '', has_hooks: true, has_transcript: true, git_branch: 'main', version: '', owned: true,
    stats: { session_id: 's', turns: 1, tool_calls: 0, files_touched: 0, tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, cost_usd: 1.5 },
    activity: { phrase: 'Running the tests', at: '', health: 'working' },
    savings: { billed_with: 0, billed_without: 0, saved: 0, hit_rate: 0, cut_pct: 0 },
    ...p,
  } as SessionSummary
}

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      sessions: async () => state.sessions,
      permission: async (id: string) => ({ permission: state.perms[id] ?? null }),
      summary: async () => ({ cost_usd: 4.2, rate_limits: { five_hour: { used_percentage: 41.5, resets_at: 0 } } }),
      answerPermission: (...a: unknown[]) => answer(...(a as [])),
    },
  }
})

import { PopoverView } from './TrayPanel'

beforeEach(() => {
  state.sessions = []
  state.perms = {}
  answer.mockReset()
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
})
afterEach(() => { vi.unstubAllGlobals() })

describe('PopoverView', () => {
  it('is calm when nothing needs you', async () => {
    state.sessions = [sess({ session_id: 'a', title: 'Fix login' })]
    render(<PopoverView />)
    expect(await screen.findByText('Nothing needs you')).toBeInTheDocument()
    expect(screen.getByText('1 agent is working.')).toBeInTheDocument()
    expect(screen.getByText('Running the tests')).toBeInTheDocument()
    expect(screen.getByText('$4.20')).toBeInTheDocument()
    // Rounded as Now rounds it: 41.5 reads 42, never 41.
    expect(screen.getByText('42%')).toBeInTheDocument()
  })

  it('offers Approve for a request it shows whole, and answers it', async () => {
    state.sessions = [sess({ session_id: 'a', title: 'Fix login' })]
    state.perms = { a: { id: 'p1', tool: 'Bash', detail: 'npm test', since: '' } }
    render(<PopoverView />)
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(answer).toHaveBeenCalledWith('a', 'p1', 'allow'))
  })

  it('offers only Deny for a request it cannot show whole', async () => {
    state.sessions = [sess({ session_id: 'a' })]
    state.perms = { a: { id: 'p1', tool: 'Bash', detail: 'rm -rf build\nnpm run deploy', since: '' } }
    render(<PopoverView />)
    expect(await screen.findByRole('button', { name: 'Deny' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Review in Caprock' })).toBeInTheDocument()
  })

  it('names a subagent that asks', async () => {
    state.sessions = [sess({ session_id: 'a' })]
    state.perms = { a: { id: 'p1', tool: 'Bash', detail: 'npm test', since: '', agent_id: 'x', agent_type: 'general-purpose' } }
    render(<PopoverView />)
    expect(await screen.findByText('Subagent (general-purpose)')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
  })

  it('answers none of several outstanding prompts: which is on screen is unknown', async () => {
    state.sessions = [sess({ session_id: 'a' })]
    const one = { id: 'p1', tool: 'Bash', detail: 'npm test', since: '' }
    const two = { id: 'p2', tool: 'Edit', detail: '/w/a.go', since: '', agent_id: 'x', agent_type: 'general-purpose' }
    state.perms = { a: { ...one, queued: 1, waiting: [one, two] } }
    render(<PopoverView />)
    expect(await screen.findByText(/2 approvals waiting — Claude: Bash · Subagent \(general-purpose\): Edit/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Open terminal' })).toBeInTheDocument()
  })

  it('says when a prompt was already answered', async () => {
    state.sessions = [sess({ session_id: 'a' })]
    state.perms = { a: { id: 'p1', tool: 'Bash', detail: 'ls', since: '' } }
    answer.mockRejectedValueOnce(new ApiError(409, 'conflict'))
    render(<PopoverView />)
    fireEvent.click(await screen.findByRole('button', { name: 'Deny' }))
    expect(await screen.findByText('Already answered.')).toBeInTheDocument()
  })

  it('moves between rows with the arrow keys', async () => {
    state.sessions = [sess({ session_id: 'a', title: 'One' }), sess({ session_id: 'b', title: 'Two', last_event_at: 0 })]
    const { container } = render(<PopoverView />)
    await screen.findByText('Nothing needs you')
    const items = [...container.querySelectorAll<HTMLElement>('[data-tray-item]')]
    items[0]!.focus()
    fireEvent.keyDown(items[0]!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[1])
    fireEvent.keyDown(items[1]!, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(items[0])
  })
})
