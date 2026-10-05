/**
 * The app workspace end to end, with the daemon and the terminal stubbed:
 * the sidebar lists projects from sessions when the daemon has no project
 * list, a session opens as a tab, the keyboard map acts, and tabs come back
 * after a reload.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/lib/api'
import { WORKSPACE_KEY } from '@/lib/tabs'

vi.mock('@/components/TerminalPane', () => ({
  TerminalPane: ({ sessionId, active }: { sessionId: string; active: boolean }) => (
    <div data-testid={`pane-${sessionId}`} data-active={String(active)} />
  ),
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

const sessions = [
  sess({ session_id: 'agent-1', title: 'Fix the login bug' }),
  sess({ session_id: 'agent-2', title: 'Waiting one', activity: { phrase: '', at: '2026-10-05T10:00:00Z', health: 'waiting-on-you' } }),
  sess({ session_id: 'theirs', title: 'Started elsewhere', owned: false, cwd: '/w/other', repo_root: '/w/other', project: 'other' }),
]

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      status: async () => ({ version: 'v0.0.0', claude_available: true }),
      sessions: async () => sessions,
      summary: async () => ({ cost_usd: 1.25, projects: [{ project: 'app', dir: '/w/app', cost_usd: 1.25, tokens: 0, sessions: 2 }], rate_limits: { five_hour: { used_percentage: 40, resets_at: 0 } } }),
      permission: async () => ({ permission: null }),
      diff: async () => ({ root: '/w/app', branch: 'main', files: [], stat: '' }),
      recentEvents: async () => [{ id: 1, ts: '2026-10-05T10:00:00Z', session_id: 'agent-1', source: 'hook', kind: 'turn.user', payload: { prompt: 'Fix it, please' } }],
    },
  }
})

const fetchMock = vi.fn(async () => new Response('', { status: 404 }))

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.stubGlobal('fetch', fetchMock)
  location.hash = '#/app'
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function renderApp() {
  const { AppShell } = await import('./AppShell')
  const view = render(<AppShell />)
  await screen.findByText('Fix the login bug')
  return view
}

const cmd = (key: string, extra: Partial<KeyboardEventInit> = {}) =>
  act(() => { fireEvent.keyDown(window, { key, code: /^\d$/.test(key) ? `Digit${key}` : `Key${key.toUpperCase()}`, metaKey: true, ...extra }) })

describe('the app workspace', () => {
  it('lists projects from sessions, with what waits on you first', async () => {
    await renderApp()
    const inbox = screen.getByRole('region', { name: 'Waiting on you' })
    expect(within(inbox).getByText('Waiting one')).toBeInTheDocument()
    const projects = [...document.querySelectorAll('[data-project-row]')].map((b) => b.querySelector('span.font-medium')?.textContent)
    expect(projects.sort()).toEqual(['app', 'other'])
    expect(await screen.findByText('$1.25')).toBeInTheDocument() // today, in the status strip
    expect(screen.getByLabelText('1 waiting on you')).toBeInTheDocument()
  })

  it('tells the desktop shell it lays out around the title bar itself, and stops saying so when gone', async () => {
    const view = await renderApp()
    expect(document.documentElement.hasAttribute('data-caprock-chrome')).toBe(true)
    view.unmount()
    expect(document.documentElement.hasAttribute('data-caprock-chrome')).toBe(false)
  })

  it('opens a session as a tab, and ⌘W closes the tab without stopping anything', async () => {
    await renderApp()
    fireEvent.click(screen.getByText('Fix the login bug'))
    const tab = await screen.findByRole('tab', { name: /Fix the login bug/ })
    expect(tab).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('pane-agent-1')).toHaveAttribute('data-active', 'true')
    await cmd('w')
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
  })

  it('shows an agent tab as its chat, over the terminal that stays mounted', async () => {
    await renderApp()
    fireEvent.click(screen.getByText('Fix the login bug'))
    await screen.findByRole('tab', { name: /Fix the login bug/ })
    fireEvent.click(screen.getByRole('button', { name: 'Show the chat' }))
    expect(await screen.findByText('Fix it, please')).toBeInTheDocument()
    expect(screen.getByTestId('pane-agent-1')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show the terminal' }))
    expect(screen.queryByRole('log')).not.toBeInTheDocument()
  })

  it('opens a session it does not own in the dashboard, never as a terminal (rule 7)', async () => {
    await renderApp()
    fireEvent.click(screen.getByText('Started elsewhere'))
    expect(location.hash).toBe('#/session/theirs')
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
  })

  it('switches tabs with ⌘1–9 and keeps every terminal mounted', async () => {
    await renderApp()
    fireEvent.click(screen.getByText('Fix the login bug'))
    fireEvent.click(within(screen.getByRole('region', { name: 'Waiting on you' })).getByText('Waiting one'))
    await screen.findAllByRole('tab')
    await cmd('1')
    expect(screen.getByTestId('pane-agent-1')).toHaveAttribute('data-active', 'true')
    expect(screen.getByTestId('pane-agent-2')).toHaveAttribute('data-active', 'false')
  })

  it('restores its tabs after a reload', async () => {
    const first = await renderApp()
    fireEvent.click(screen.getByText('Fix the login bug'))
    await screen.findByRole('tab')
    await waitFor(() => expect(localStorage.getItem(WORKSPACE_KEY)).toContain('agent-1'))
    first.unmount()
    await renderApp()
    expect(await screen.findByRole('tab', { name: /Fix the login bug/ })).toBeInTheDocument()
  })

  it('opens the palette with ⌘K and the new-agent sheet with ⇧⌘N', async () => {
    await renderApp()
    await cmd('k')
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await cmd('n', { shiftKey: true })
    expect(await screen.findByRole('dialog', { name: 'New agent' })).toBeInTheDocument()
  })

  it('says plainly when the daemon has no shell tabs yet', async () => {
    await renderApp()
    await cmd('t')
    expect(await screen.findByText(/Shell tabs needs a newer Caprock daemon/)).toBeInTheDocument()
  })
})
