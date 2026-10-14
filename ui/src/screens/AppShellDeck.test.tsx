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
  // Most of these were written for the Tree sidebar; Flat, a new viewer's default, has its own tests.
  localStorage.setItem('caprock.app.sidebar-grouped', 'on')
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
const barButton = () => document.querySelector<HTMLButtonElement>('[data-bar-mode]')!
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

  it('opens and closes from the tab strip’s button, and draws no Hide of its own', async () => {
    await openAgent()
    fireEvent.click(screen.getByRole('button', { name: 'Session deck (⌘B)' }))
    expect(deck()).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Close the session deck/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Session deck (⌘B)' }))
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
    act(() => { fireEvent.keyDown(window, { key: 'B', code: 'KeyB', metaKey: true, shiftKey: true }) })
    expect(await screen.findByRole('tab', { name: /PRs & CI · app/ })).toBeInTheDocument()
    expect(document.querySelector('[data-prs-tab]')).toBeInTheDocument()
    // Not an agent's tab: no deck under it; the inspector describes the agent it came from.
    expect(deck()).toBeNull()
    expect(screen.queryByText('Loading…')).toBeNull()
    fireEvent.click(document.querySelector('[data-prs-back]')!)
    await waitFor(() => expect(screen.queryByRole('tab', { name: /PRs & CI/ })).toBeNull())
    expect(deck()).toBeInTheDocument()
  })

  // Owner, 2026-10-14, translated: "it should simply be a toggle".
  it('toggles between the deck and the PRs & CI tab on ⇧⌘B, the control in the same corner', async () => {
    await openAgent()
    const shiftCmdB = () => act(() => { fireEvent.keyDown(window, { key: 'B', code: 'KeyB', metaKey: true, shiftKey: true }) })
    cmdB()
    shiftCmdB()
    expect(await screen.findByRole('tab', { name: /PRs & CI · app/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Collapse: back/ })).toBeInTheDocument()
    expect(barButton()).toHaveAttribute('data-bar-mode', 'full')
    shiftCmdB()
    await waitFor(() => expect(screen.queryByRole('tab', { name: /PRs & CI/ })).toBeNull())
    expect(deck()).toBeInTheDocument()
    expect(barButton()).toHaveAttribute('data-bar-mode', 'bar')
    // With the deck hidden, the agent in front still expands.
    cmdB()
    expect(deck()).toBeNull()
    shiftCmdB()
    expect(await screen.findByRole('tab', { name: /PRs & CI · app/ })).toBeInTheDocument()
  })

  // Owner, 2026-10-14, translated: "hide it behind one button with the bar's
  // modes … bottom-left in the sidebar is where it's handy".
  it('cycles Hidden → Bar → Full page → Hidden from the sidebar footer’s one button, its glyph the mode', async () => {
    await openAgent()
    const b = barButton()
    expect(b).toHaveAttribute('data-bar-mode', 'hidden')
    expect(b).toHaveAccessibleName('PRs & CI: Hidden — click for Bar (⌘B shows or hides the bar, ⇧⌘B the full page)')
    const glyph = () => barButton().querySelector('svg')!.innerHTML
    const hidden = glyph()

    fireEvent.click(barButton())
    expect(deck()).toBeInTheDocument()
    expect(barButton()).toHaveAttribute('data-bar-mode', 'bar')
    expect(barButton()).toHaveAccessibleName(/^PRs & CI: Bar — click for Full page/)
    const bar = glyph()

    fireEvent.click(barButton())
    expect(await screen.findByRole('tab', { name: /PRs & CI · app/ })).toBeInTheDocument()
    expect(barButton()).toHaveAttribute('data-bar-mode', 'full')
    const full = glyph()
    expect(new Set([hidden, bar, full]).size).toBe(3)

    fireEvent.click(barButton())
    await waitFor(() => expect(screen.queryByRole('tab', { name: /PRs & CI/ })).toBeNull())
    expect(screen.getByRole('tab', { name: /Fix the login bug/ })).toHaveAttribute('aria-selected', 'true')
    expect(deck()).toBeNull()
    expect(barButton()).toHaveAttribute('data-bar-mode', 'hidden')
    expect(JSON.parse(localStorage.getItem(DECK_KEY) ?? '{}')).toMatchObject({ open: false })
  })

  it('follows ⌘B and ⇧⌘B: the keys and the button are one state', async () => {
    await openAgent()
    cmdB()
    expect(barButton()).toHaveAttribute('data-bar-mode', 'bar')
    act(() => { fireEvent.keyDown(window, { key: 'B', code: 'KeyB', metaKey: true, shiftKey: true }) })
    await screen.findByRole('tab', { name: /PRs & CI · app/ })
    expect(barButton()).toHaveAttribute('data-bar-mode', 'full')
  })

  it('is listed in the palette', async () => {
    await openAgent()
    act(() => { fireEvent.keyDown(window, { key: 'k', code: 'KeyK', metaKey: true }) })
    fireEvent.change(screen.getByRole('combobox', { name: 'Search' }), { target: { value: 'session deck' } })
    fireEvent.click(screen.getAllByRole('option').find((o) => o.textContent?.startsWith('Show the session deck'))!)
    expect(await screen.findByRole('region', { name: 'Session deck' })).toBeInTheDocument()
  })
})
