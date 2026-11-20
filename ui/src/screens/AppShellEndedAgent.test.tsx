/**
 * An agent session that ended unexpectedly (lib/endedAgent.ts; owner,
 * 2026-11-20: "ops" died when he quit Chrome, its tab silently became a
 * shell, and the session was nowhere, not even in Recently closed). The
 * shell that takes the tab keeps the session's name and says so at its top,
 * Resume continues the conversation there (POST /v1/agents with resume),
 * the × leaves the shell, and Recently closed lists the session. A clean
 * exit says nothing.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentExit, SessionSummary, SpawnRequest } from '@/lib/api'
import { AppShell } from './AppShell'
import { loadRecentlyClosed } from '@/lib/recentlyClosed'
import '@/App'

// The pane is a button that "exits" its session, as the terminal's exit frame does.
vi.mock('@/components/TerminalPane', () => ({
  TerminalPane: ({ sessionId, onExit }: { sessionId: string; onExit?: (code: number) => void }) => (
    <button type="button" data-testid={`pane-${sessionId}`} onClick={() => onExit?.(-1)}>exit {sessionId}</button>
  ),
}))
vi.mock('@/components/PermissionPrompt', async (orig) => ({
  ...(await orig<typeof import('@/components/PermissionPrompt')>()),
  PermissionPrompt: () => null,
}))

function sess(p: Partial<SessionSummary>): SessionSummary {
  return {
    session_id: 's', cwd: '/w/app', repo_root: '/w/app', project: 'app', model: 'claude-opus-5', started_at: 0, last_event_at: 1, status: 'active',
    transcript_path: '', has_hooks: true, has_transcript: true, git_branch: 'main', version: '', owned: true,
    stats: { session_id: 's', turns: 3, tool_calls: 5, files_touched: 1, tokens_in: 10, tokens_out: 20, cache_read: 0, cache_write: 0, cost_usd: 0.42 },
    activity: { phrase: '', at: '', health: 'working' },
    savings: { billed_with: 0, billed_without: 0, saved: 0, hit_rate: 0, cut_pct: 0 },
    ...p,
  } as SessionSummary
}

const h = vi.hoisted(() => ({
  exit: null as AgentExit | null,
  spawned: [] as SpawnRequest[],
  shells: [] as { cwd?: string; replaces?: string }[],
  signals: [] as [string, string][],
}))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      status: async () => ({ version: 'v0.0.0', claude_available: true }),
      sessions: async () => [sess({ session_id: 'agent-1', title: 'Ops scripts' })],
      summary: async () => ({ cost_usd: 0, savings: { billed_with: 0, billed_without: 0, saved: 0, hit_rate: 0, cut_pct: 0 }, projects: [] }),
      permission: async () => ({ permission: null }),
      diff: async () => ({ root: '/w/app', branch: 'main', files: [], stat: '' }),
      editors: async () => ({ editors: [], preferred: '' }),
      recentEvents: async () => [],
      subagents: async () => ({ working: [], finished: 0 }),
      recentMainEvents: async () => [],
      agentExit: async () => { if (!h.exit) throw new Error('404'); return h.exit },
      session: async (id: string) => ({ ...sess({ session_id: id, title: 'Ops scripts', status: 'ended' }), resume: { ok: true, permission_mode: 'auto' } }),
      spawn: async (req: SpawnRequest) => { h.spawned.push(req); return { session_id: req.resume ?? 'new' } },
      signal: async (id: string, action: string) => { h.signals.push([id, action]) },
    },
  }
})
vi.mock('@/lib/projects', async (orig) => {
  const actual = await orig<typeof import('@/lib/projects')>()
  return {
    ...actual,
    projectsApi: {
      ...actual.projectsApi,
      startShell: async (req: { cwd?: string; replaces?: string }) => { h.shells.push(req); return { id: 'shell-1', cwd: req.cwd ?? '', started_at: 1, kind: 'shell' as const } },
    },
  }
})

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('caprock.app.sidebar-grouped', 'on')
  localStorage.setItem('caprock.app.project-open', JSON.stringify(['dir:/w/app', 'other-folders']))
  localStorage.setItem('caprock.app.recently-closed-open', 'open')
  sessionStorage.clear()
  h.exit = null
  h.spawned = []
  h.shells = []
  h.signals = []
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
  location.hash = '#/app'
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function openAndExit() {
  render(<AppShell />)
  await waitFor(() => expect(document.querySelector('[data-project-row]')).toBeTruthy())
  act(() => { fireEvent.keyDown(window, { key: 'k', code: 'KeyK', metaKey: true }) })
  fireEvent.change(screen.getByRole('combobox', { name: 'Search' }), { target: { value: 'Ops scripts' } })
  fireEvent.click(screen.getAllByRole('option').find((o) => o.textContent?.startsWith('Ops scripts'))!)
  fireEvent.click(await screen.findByTestId('pane-agent-1'))
  await screen.findByTestId('pane-shell-1')
}

const notice = () => document.querySelector<HTMLElement>('[data-ended-notice="agent-1"]')

describe('an agent session that ended unexpectedly', () => {
  it('leaves a shell that keeps its name and says so, and lists it in Recently closed', async () => {
    h.exit = { session_id: 'agent-1', agent: 'claude', code: -1, early: false, unexpected: true, ran_ms: 60000, tail: '', at: new Date(2026, 10, 20, 19, 58).getTime() }
    await openAndExit()
    expect(h.shells).toEqual([expect.objectContaining({ cwd: '/w/app', replaces: 'agent-1' })])
    await waitFor(() => expect(notice()).toBeTruthy())
    expect(notice()!.textContent).toContain('Ops scripts ended unexpectedly at')
    expect(notice()!.textContent).toContain('19:58 (killed by a signal)')
    // The tab keeps the session's name, not "Shell 1".
    expect(screen.getByRole('tab', { name: /Ops scripts/ })).toBeTruthy()
    // Recently closed lists it, with why.
    const row = await waitFor(() => {
      const r = document.querySelector<HTMLElement>('[data-closed-row="agent-1"]')
      expect(r).toBeTruthy()
      return r!
    })
    expect(row.textContent).toContain('ended unexpectedly')
    expect(loadRecentlyClosed()[0]).toMatchObject({ sessionId: 'agent-1', unexpected: true })
  })

  it('resumes the same conversation in that tab and ends the idle shell', async () => {
    h.exit = { session_id: 'agent-1', agent: 'claude', code: -1, early: false, unexpected: true, ran_ms: 60000, tail: '', at: Date.now() }
    await openAndExit()
    await waitFor(() => expect(notice()).toBeTruthy())
    fireEvent.click(notice()!.querySelector('[data-ended-resume]')!)
    await waitFor(() => expect(h.spawned).toEqual([{ cwd: '/w/app', resume: 'agent-1', fork: false, permission_mode: 'auto' }]))
    await screen.findByTestId('pane-agent-1')
    expect(screen.queryByTestId('pane-shell-1')).toBeNull()
    await waitFor(() => expect(h.signals).toEqual([['shell-1', 'kill']]))
    expect(loadRecentlyClosed().some((e) => e.sessionId === 'agent-1')).toBe(false)
  })

  it('dismisses the line and keeps the shell and its name', async () => {
    h.exit = { session_id: 'agent-1', agent: 'claude', code: 1, early: false, unexpected: true, ran_ms: 60000, tail: '', at: Date.now() }
    await openAndExit()
    await waitFor(() => expect(notice()).toBeTruthy())
    expect(notice()!.textContent).toContain('(exited with code 1)')
    fireEvent.click(notice()!.querySelector('[data-ended-dismiss]')!)
    await waitFor(() => expect(notice()).toBeNull())
    expect(screen.getByTestId('pane-shell-1')).toBeTruthy()
    expect(screen.getByRole('tab', { name: /Ops scripts/ })).toBeTruthy()
    expect(h.spawned).toEqual([])
  })

  it('says nothing after a clean exit', async () => {
    h.exit = { session_id: 'agent-1', agent: 'claude', code: 0, early: false, ran_ms: 60000, tail: '', at: Date.now() }
    await openAndExit()
    expect(notice()).toBeNull()
    expect(loadRecentlyClosed()).toEqual([])
  })
})
