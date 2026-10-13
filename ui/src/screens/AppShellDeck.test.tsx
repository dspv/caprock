/**
 * The session deck in the app (.ai/21-app.md § What the user sees): closed by
 * default, opened by ⌘B or the strip's button, only under an agent's
 * terminal, kept per viewer — and closed, it holds nothing.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/lib/api'
import { heldSessions } from '@/lib/sessionEvents'
import { DECK_KEY } from '@/lib/deck'
import { AppShell } from './AppShell'

vi.mock('@/components/TerminalPane', () => ({
  TerminalPane: ({ sessionId, active }: { sessionId: string; active: boolean }) => (
    <div data-testid={`pane-${sessionId}`} data-active={String(active)} />
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

const sessions = [sess({ session_id: 'agent-1', title: 'Fix the login bug' })]
const h = vi.hoisted(() => ({ asked: 0 }))

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
      subagents: async () => ({ working: [], finished: 0 }),
      recentMainEvents: async () => { h.asked++; return [] },
    },
  }
})

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  h.asked = 0
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
  location.hash = '#/app'
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function openAgent() {
  render(<AppShell />)
  await waitFor(() => expect(document.querySelector('[data-project-row]')).toBeTruthy())
  act(() => { fireEvent.keyDown(window, { key: 'k', code: 'KeyK', metaKey: true }) })
  const input = screen.getByRole('combobox', { name: 'Search' })
  fireEvent.change(input, { target: { value: 'Fix the login bug' } })
  fireEvent.click(screen.getAllByRole('option').find((o) => o.textContent?.startsWith('Fix the login bug'))!)
  await screen.findByRole('tab', { name: /Fix the login bug/ })
}

const deck = () => screen.queryByRole('region', { name: 'Session deck' })
const cmdB = () => act(() => { fireEvent.keyDown(window, { key: 'b', code: 'KeyB', metaKey: true }) })

describe('the session deck in the app', () => {
  it('is closed by default and opens and closes on ⌘B, kept per viewer', async () => {
    await openAgent()
    expect(deck()).toBeNull()
    cmdB()
    expect(deck()).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem(DECK_KEY) ?? '{}')).toMatchObject({ open: true })
    cmdB()
    expect(deck()).toBeNull()
    expect(JSON.parse(localStorage.getItem(DECK_KEY) ?? '{}')).toMatchObject({ open: false })
  })

  it('opens from the tab strip’s button and closes from its own', async () => {
    await openAgent()
    fireEvent.click(screen.getByRole('button', { name: 'Session deck (⌘B)' }))
    expect(deck()).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close the session deck (⌘B)' }))
    expect(deck()).toBeNull()
  })

  it('never holds a session’s events: with the inspector closed, the open deck fetches and follows none', async () => {
    await openAgent()
    fireEvent.click(screen.getByRole('button', { name: /^Inspector/ }))
    await waitFor(() => expect(heldSessions()).toBe(0))
    const before = h.asked
    cmdB()
    expect(deck()).toBeInTheDocument()
    expect(heldSessions()).toBe(0)
    expect(h.asked).toBe(before)
  })

  it('adds no fetch to the cockpit beside it', async () => {
    await openAgent()
    await waitFor(() => expect(h.asked).toBe(1))
    cmdB()
    expect(deck()).toBeInTheDocument()
    expect(h.asked).toBe(1)
  })

  it('expands into a PRs & CI tab, and Back to the deck returns to the agent with its deck open', async () => {
    await openAgent()
    cmdB()
    fireEvent.click(screen.getByRole('button', { name: /^Expand/ }))
    expect(await screen.findByRole('tab', { name: /PRs & CI · app/ })).toBeInTheDocument()
    expect(document.querySelector('[data-prs-tab]')).toBeInTheDocument()
    // Not an agent's tab: no deck under it.
    expect(deck()).toBeNull()
    fireEvent.click(document.querySelector('[data-prs-back]')!)
    await waitFor(() => expect(screen.queryByRole('tab', { name: /PRs & CI/ })).toBeNull())
    expect(deck()).toBeInTheDocument()
  })

  it('is listed in the palette', async () => {
    await openAgent()
    act(() => { fireEvent.keyDown(window, { key: 'k', code: 'KeyK', metaKey: true }) })
    fireEvent.change(screen.getByRole('combobox', { name: 'Search' }), { target: { value: 'session deck' } })
    fireEvent.click(screen.getAllByRole('option').find((o) => o.textContent?.startsWith('Show the session deck'))!)
    expect(await screen.findByRole('region', { name: 'Session deck' })).toBeInTheDocument()
  })
})
