/**
 * The permission card in the app (.ai/21-app.md § What the user sees): drawn
 * for the focused agent whether or not its terminal is in front, its keys work
 * from that terminal — and never twice.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/lib/api'

vi.mock('@/components/TerminalPane', () => ({
  TerminalPane: ({ sessionId, active }: { sessionId: string; active: boolean }) => (
    <div data-testid={`pane-${sessionId}`} data-active={String(active)} />
  ),
}))
vi.mock('@/components/PermissionPrompt', async (orig) => ({
  ...(await orig<typeof import('@/components/PermissionPrompt')>()),
  PermissionPrompt: ({ sessionId }: { sessionId: string }) => <div data-testid="permission-card" data-session={sessionId} />,
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
  sess({ session_id: 'agent-2', title: 'Waiting one', activity: { phrase: '', at: new Date(Date.now() - 60_000).toISOString(), health: 'waiting-on-you' } }),
]

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      status: async () => ({ version: 'v0.0.0', claude_available: true }),
      sessions: async () => sessions,
      summary: async () => ({ cost_usd: 0, projects: [] }),
      permission: async () => ({ permission: null }),
      diff: async () => ({ root: '/w/app', branch: 'main', files: [], stat: '' }),
      editors: async () => ({ editors: [], preferred: '' }),
      recentEvents: async () => [],
    },
  }
})

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
  location.hash = '#/app'
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function openAgent() {
  const { AppShell } = await import('./AppShell')
  render(<AppShell />)
  fireEvent.click(await screen.findByText('Fix the login bug'))
  await screen.findByRole('tab', { name: /Fix the login bug/ })
}

const cards = () => screen.queryAllByTestId('permission-card')

describe('the permission card in the app', () => {
  it('is drawn, once, under the session’s own terminal', async () => {
    await openAgent()
    expect(screen.getByTestId('pane-agent-1')).toHaveAttribute('data-active', 'true')
    expect(cards()).toHaveLength(1)
    expect(cards()[0]).toHaveAttribute('data-session', 'agent-1')
  })

  it('stays, once, when the chat covers the terminal and when it is back', async () => {
    await openAgent()
    fireEvent.click(screen.getByRole('button', { name: 'Show the chat' }))
    expect(cards()).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Show the terminal' }))
    expect(cards()).toHaveLength(1)
  })

  it('sits in the inspector, open by default, and under the terminal once it is closed — never twice', async () => {
    await openAgent()
    expect(screen.getByRole('complementary', { name: 'Inspector' })).toBeInTheDocument()
    expect(cards()).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: /Inspector/ }))
    expect(screen.queryByRole('complementary', { name: 'Inspector' })).toBeNull()
    expect(cards()).toHaveLength(1)
    // Closed is remembered, under the key that replaced the old closed-by-default flag.
    expect(JSON.parse(localStorage.getItem('caprock.app.ui') ?? '{}')).toMatchObject({ cockpit: false })
  })

  it('follows the tab: switching to a waiting session shows its card', async () => {
    await openAgent()
    fireEvent.click(within(screen.getByRole('region', { name: 'Waiting on you' })).getByText('Waiting one'))
    await screen.findByRole('tab', { name: /Waiting one/ })
    expect(screen.getByTestId('pane-agent-2')).toHaveAttribute('data-active', 'true')
    expect(cards()).toHaveLength(1)
    expect(cards()[0]).toHaveAttribute('data-session', 'agent-2')
  })
})
