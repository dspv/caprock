/** A pane whose program exited at once: what it printed, Try again, Close. */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentExit, SpawnRequest } from '@/lib/api'
import { earlyExitHeadline, earlyExitHint, earlyExitWhen } from '@/lib/earlyexit'

const h = vi.hoisted(() => ({
  report: undefined as unknown,
  spawned: [] as unknown[],
  spawnFails: '' as string,
}))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      agentExit: async () => {
        if (h.report instanceof Error) throw h.report
        return h.report
      },
      spawn: async (req: SpawnRequest) => {
        if (h.spawnFails) throw new actual.ApiError(400, h.spawnFails)
        h.spawned.push(req)
        return { session_id: 'new-id', cwd: req.cwd ?? '' }
      },
    },
  }
})

import { EarlyExit } from './EarlyExit'

const report: AgentExit = {
  session_id: 's1', agent: 'claude', code: 1, early: true, ran_ms: 120, at: 0,
  tail: 'No conversation found with session ID: 11111111-2222-3333-4444-555555555555',
  retry: { cwd: '/Users/u/work', resume: '11111111-2222-3333-4444-555555555555', fork: true, permission_mode: 'auto' },
}

const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

describe('EarlyExit', () => {
  beforeEach(() => {
    h.report = report
    h.spawned = []
    h.spawnFails = ''
  })

  it('says the program exited at once, with its last lines and what they mean', async () => {
    render(<EarlyExit sessionId="s1" code={1} onRetried={() => {}} onClose={() => {}} />)
    // The code is known from the exit frame before the report arrives.
    expect(screen.getByText('Claude Code exited at once (code 1)')).toBeTruthy()
    await settle()
    expect(document.querySelector('[data-early-exit-tail]')?.textContent).toBe(report.tail)
    expect(screen.getByText(/It ended 120 ms after it started/)).toBeTruthy()
    expect(document.querySelector('[data-early-exit-hint]')?.textContent).toMatch(/only under the folder it was started in/)
    // No reconnect loop, no "Connecting…".
    expect(screen.queryByText(/Connecting/)).toBeNull()
  })

  it('Try again starts the same launch and hands over the new id', async () => {
    const retried = vi.fn()
    render(<EarlyExit sessionId="s1" code={1} onRetried={retried} onClose={() => {}} />)
    await settle()
    fireEvent.click(screen.getByText('Try again'))
    await settle()
    expect(h.spawned).toEqual([report.retry])
    expect(retried).toHaveBeenCalledWith('new-id')
  })

  it('says why Try again failed, and keeps the panel', async () => {
    h.spawnFails = 'Caprock cannot find claude to start it'
    const retried = vi.fn()
    render(<EarlyExit sessionId="s1" code={1} onRetried={retried} />)
    await settle()
    fireEvent.click(screen.getByText('Try again'))
    await settle()
    expect(retried).not.toHaveBeenCalled()
    expect(screen.getByText(/cannot find claude/)).toBeTruthy()
    // Without onClose there is no Close.
    expect(screen.queryByText('Close')).toBeNull()
  })

  it('Close closes; no Try again when the daemon does not have the launch', async () => {
    h.report = { ...report, retry: undefined, tail: '' }
    const closed = vi.fn()
    render(<EarlyExit sessionId="s1" code={1} onRetried={() => {}} onClose={closed} />)
    await settle()
    expect(screen.queryByText('Try again')).toBeNull()
    expect(screen.getByText(/It printed nothing/)).toBeTruthy()
    fireEvent.click(screen.getByText('Close'))
    expect(closed).toHaveBeenCalled()
  })
})

describe('earlyexit words', () => {
  it('headline and timing', () => {
    expect(earlyExitHeadline('Codex', 2)).toBe('Codex exited at once (code 2)')
    expect(earlyExitWhen(40)).toBe('It ended 40 ms after it started, before anything was typed.')
    expect(earlyExitWhen(4200)).toBe('It ended 4 s after it started, before anything was typed.')
    expect(earlyExitWhen(undefined)).toMatch(/right after it started/)
  })

  it('reads the messages Claude Code prints when it cannot start', () => {
    expect(earlyExitHint("error: option '--permission-mode <mode>' argument 'bogus' is invalid. Allowed choices are acceptEdits, auto")).toMatch(/refused a flag/)
    expect(earlyExitHint('Error: Session ID 7873cb1c is already in use.')).toMatch(/new one/)
    expect(earlyExitHint('Error: EPERM: operation not permitted, uv_cwd')).toMatch(/Files and Folders/)
    expect(earlyExitHint('Settings Error … Invalid or malformed JSON')).toMatch(/not valid JSON/)
    expect(earlyExitHint('something else entirely')).toBeUndefined()
  })
})
