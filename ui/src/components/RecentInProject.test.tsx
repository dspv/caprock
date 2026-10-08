/**
 * The project's recent sessions on the empty workspace. What matters: agents
 * only, newest work first; an ended session carries on in a new tab with the
 * mode it last ran in, without a detour through the session page; a paired
 * viewer that may not start processes sees no Continue.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RecentInProject, recentOf } from './RecentInProject'
import type { SessionSummary } from '@/lib/api'

const h = vi.hoisted(() => ({
  list: [] as SessionSummary[],
  spawn: vi.fn(async () => ({ session_id: 'new-1', cwd: '/r' })),
  canControl: true,
}))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, sessionsInDir: async () => h.list, spawn: h.spawn } }
})
vi.mock('@/lib/useCanControl', () => ({ useCanControl: () => h.canControl }))

function s(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    session_id: id,
    cwd: '/r',
    project: 'r',
    status: 'ended',
    owned: false,
    last_event_at: 1000,
    description: `work ${id}`,
    stats: { cost_usd: 1.5 },
    resume: { ok: true, permission_mode: 'acceptEdits' },
    ...over,
  } as SessionSummary
}

describe('recentOf', () => {
  it('drops shells and puts the most recent work first', () => {
    const got = recentOf([s('a', { worked_at: 10 }), s('sh', { kind: 'shell', worked_at: 99 }), s('b', { worked_at: 20 })])
    expect(got.map((x) => x.session_id)).toEqual(['b', 'a'])
  })
  it('drops an ended session nobody wrote in, keeps a running one', () => {
    const empty = { description: '', stats: { turns: 0 } } as Partial<SessionSummary>
    const got = recentOf([s('blank', empty), s('fresh', { ...empty, status: 'active' }), s('real', { stats: { turns: 3 } as SessionSummary['stats'] })])
    expect(got.map((x) => x.session_id).sort()).toEqual(['fresh', 'real'])
  })
  it('keeps to the limit', () => {
    expect(recentOf(Array.from({ length: 10 }, (_, i) => s(`s${i}`)), 3)).toHaveLength(3)
  })
})

describe('RecentInProject', () => {
  beforeEach(() => {
    h.spawn.mockClear()
    h.canControl = true
  })

  it('continues an ended session in its last mode and hands the new id back', async () => {
    h.list = [s('old')]
    const onContinued = vi.fn()
    render(<RecentInProject root="/r" permissions={new Set()} onOpen={() => {}} onContinued={onContinued} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(onContinued).toHaveBeenCalledWith('new-1', 'work old'))
    expect(h.spawn).toHaveBeenCalledWith({ cwd: '/r', resume: 'old', fork: false, permission_mode: 'acceptEdits' })
  })

  it('offers Open on a running session and opens it', async () => {
    h.list = [s('live', { status: 'active' })]
    const onOpen = vi.fn()
    render(<RecentInProject root="/r" permissions={new Set()} onOpen={onOpen} onContinued={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }))
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ session_id: 'live' }))
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
  })

  it('offers no Continue to a viewer that may not start processes', async () => {
    h.canControl = false
    h.list = [s('old')]
    render(<RecentInProject root="/r" permissions={new Set()} onOpen={() => {}} onContinued={() => {}} />)
    await screen.findByText('work old')
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
  })

  it('renders nothing for a project with no sessions', async () => {
    h.list = []
    const { container } = render(<RecentInProject root="/r" permissions={new Set()} onOpen={() => {}} onContinued={() => {}} />)
    await new Promise((r) => setTimeout(r, 0))
    expect(container.textContent).toBe('')
  })
})
