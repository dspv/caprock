/**
 * The terminal button on a Projects row. What matters: one terminal Caprock
 * holds opens straight away; anything else is a menu that never offers to
 * type into a session Caprock did not start — those are continued or
 * branched as a second process.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectTerminal } from './ProjectTerminal'
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
    last_event_at: Date.now(),
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

describe('ProjectTerminal', () => {
  it('opens the one terminal Caprock holds, with no menu', async () => {
    h.list = [s('mine', { owned: true, status: 'active' }), s('old', { resume: { ok: true } })]
    render(<ProjectTerminal dir="/r" label="r" />)
    fireEvent.click(screen.getByTitle('Open a terminal in r'))
    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith({ name: 'session', id: 'mine', tab: 'terminal' }))
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('continues an ended session and branches a running one, as new processes', async () => {
    h.list = [
      s('theirs', { status: 'active', resume: { ok: true } }),
      s('done', { resume: { ok: true } }),
    ]
    render(<ProjectTerminal dir="/r" label="r" />)
    fireEvent.click(screen.getByTitle('Open a terminal in r'))
    expect(await screen.findByRole('menu')).toBeTruthy()

    fireEvent.click(screen.getByText('work theirs'))
    await waitFor(() => expect(h.spawn).toHaveBeenCalledWith({ cwd: '/r', resume: 'theirs', fork: true }))
    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith({ name: 'session', id: 'new-1', tab: 'terminal' }))
  })

  it('leaves out sessions that cannot be carried on, and offers a new one', async () => {
    h.list = [s('codex', { agent: 'codex', resume: { ok: false, reason: 'Codex' } })]
    render(<ProjectTerminal dir="/r" label="r" />)
    fireEvent.click(screen.getByTitle('Open a terminal in r'))
    await screen.findByRole('menu')
    expect(screen.queryByText('work codex')).toBeNull()
    fireEvent.click(screen.getByText('+ new session here'))
    await waitFor(() => expect(h.spawn).toHaveBeenCalledWith({ cwd: '/r' }))
  })

  it('on a paired device offers only what Caprock already holds', async () => {
    h.paired = true
    h.list = [
      s('a', { owned: true, status: 'active' }),
      s('b', { owned: true, status: 'idle' }),
      s('done', { resume: { ok: true } }),
    ]
    render(<ProjectTerminal dir="/r" label="r" />)
    fireEvent.click(screen.getByTitle('Open a terminal in r'))
    await screen.findByRole('menu')
    expect(screen.getByText('work a')).toBeTruthy()
    expect(screen.queryByText('work done')).toBeNull()
    expect(screen.queryByText('+ new session here')).toBeNull()
  })
})
