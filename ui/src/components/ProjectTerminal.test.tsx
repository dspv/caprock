/**
 * The terminal button on a Projects row. What matters: its label says what a
 * click will do before the click; "Terminal" — the one label that promises
 * typing — appears only for a session Caprock started; a session started
 * elsewhere is picked up as a second process, never typed into (rule 7).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectTerminal, projectAction } from './ProjectTerminal'
import type { SessionSummary } from '@/lib/api'

const h = vi.hoisted(() => ({
  list: [] as SessionSummary[],
  spawn: vi.fn(async () => ({ session_id: 'new-1', cwd: '/r' })),
  navigate: vi.fn(),
  paired: false,
}))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    isPairedDevice: () => h.paired,
    api: { ...actual.api, sessionsInDir: async () => h.list, spawn: h.spawn },
  }
})
vi.mock('@/lib/router', () => ({ navigate: h.navigate }))

function s(id: string, over: Partial<SessionSummary>): SessionSummary {
  return {
    session_id: id,
    cwd: '/r',
    project: 'r',
    status: 'ended',
    owned: false,
    last_event_at: 1000,
    description: `work ${id}`,
    ...over,
  } as SessionSummary
}

beforeEach(() => {
  h.spawn.mockClear()
  h.navigate.mockClear()
  h.paired = false
})
afterEach(() => {
  h.list = []
})

describe('projectAction', () => {
  it('opens Caprock’s own live session first, the most recently worked', () => {
    const a = projectAction([
      s('theirs', { status: 'active', worked_at: 9000 }),
      s('mine-old', { owned: true, status: 'idle', worked_at: 2000 }),
      s('mine-new', { owned: true, status: 'active', worked_at: 5000 }),
      s('done', { owned: true, worked_at: 9999 }),
    ], false)
    expect(a).toMatchObject({ kind: 'open', session: { session_id: 'mine-new' } })
  })
  it('picks up the newest live session when none is Caprock’s', () => {
    const a = projectAction([s('a', { status: 'active', worked_at: 1 }), s('b', { status: 'idle', worked_at: 7 })], false)
    expect(a).toMatchObject({ kind: 'pickup', session: { session_id: 'b' } })
  })
  it('never offers to type into a session Caprock started before its restart', () => {
    const a = projectAction([s('gone', { owned: true, status: 'active', detached: true })], false)
    expect(a.kind).toBe('pickup')
  })
  it('starts a new session when nothing runs, but not on a paired device', () => {
    expect(projectAction([s('done', {})], false).kind).toBe('new')
    expect(projectAction([], true).kind).toBe('none')
  })
})

describe('ProjectTerminal', () => {
  it('says Terminal and opens Caprock’s own session, with no menu', async () => {
    render(<ProjectTerminal dir="/r" label="r" sessions={[s('mine', { owned: true, status: 'active' })]} />)
    const b = screen.getByRole('button', { name: 'Terminal — r' })
    fireEvent.click(b)
    expect(h.navigate).toHaveBeenCalledWith({ name: 'session', id: 'mine', tab: 'terminal' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('picks up a session started elsewhere as a branch, never as Terminal', async () => {
    const theirs = s('theirs', { status: 'active' })
    h.list = [{ ...theirs, resume: { ok: true } }]
    render(<ProjectTerminal dir="/r" label="r" sessions={[theirs]} />)
    expect(screen.queryByRole('button', { name: 'Terminal — r' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Pick up in a terminal — r' }))
    await waitFor(() => expect(h.spawn).toHaveBeenCalledWith({ cwd: '/r', resume: 'theirs', fork: true }))
    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith({ name: 'session', id: 'new-1', tab: 'terminal' }))
  })

  it('opens the session’s page when it cannot be picked up here', async () => {
    const theirs = s('codex', { status: 'active', agent: 'codex' })
    h.list = [{ ...theirs, resume: { ok: false, reason: 'Codex' } }]
    render(<ProjectTerminal dir="/r" label="r" sessions={[theirs]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Pick up in a terminal — r' }))
    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith({ name: 'session', id: 'codex' }))
    expect(h.spawn).not.toHaveBeenCalled()
  })

  it('starts a new session in the folder when nothing runs there', async () => {
    render(<ProjectTerminal dir="/r" label="r" sessions={[s('done', {})]} />)
    fireEvent.click(screen.getByRole('button', { name: 'New session here — r' }))
    await waitFor(() => expect(h.spawn).toHaveBeenCalledWith({ cwd: '/r' }))
  })

  it('keeps every way in behind ⋯, leaving out what cannot be carried on', async () => {
    h.list = [
      s('theirs', { status: 'active', resume: { ok: true } }),
      s('done', { resume: { ok: true } }),
      s('codex', { agent: 'codex', resume: { ok: false, reason: 'Codex' } }),
    ]
    render(<ProjectTerminal dir="/r" label="r" />)
    fireEvent.click(screen.getByRole('button', { name: 'Every way into r' }))
    expect(await screen.findByRole('menu')).toBeTruthy()
    expect(screen.queryByText('work codex')).toBeNull()
    fireEvent.click(screen.getByText('work done'))
    await waitFor(() => expect(h.spawn).toHaveBeenCalledWith({ cwd: '/r', resume: 'done', fork: false }))
  })

  it('on a paired device opens pages and starts nothing', async () => {
    h.paired = true
    render(<ProjectTerminal dir="/r" label="r" sessions={[s('theirs', { status: 'active' })]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open session — r' }))
    expect(h.navigate).toHaveBeenCalledWith({ name: 'session', id: 'theirs' })
    expect(h.spawn).not.toHaveBeenCalled()
    h.list = [s('a', { owned: true, status: 'active' }), s('done', { resume: { ok: true } })]
    fireEvent.click(screen.getByRole('button', { name: 'Every way into r' }))
    await screen.findByRole('menu')
    expect(screen.getByText('work a')).toBeTruthy()
    expect(screen.queryByText('work done')).toBeNull()
    expect(screen.queryByText('+ new session here')).toBeNull()
  })
})
