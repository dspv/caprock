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
const pipelineButton = () => document.querySelector<HTMLButtonElement>('[data-pipeline-button]')!
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

  it('opens and closes from the tab strip’s button', async () => {
    await openAgent()
    fireEvent.click(screen.getByRole('button', { name: 'Session deck (⌘B)' }))
    expect(deck()).toBeInTheDocument()
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

  // Owner, 2026-10-14, translated: "it feels like quick access to the CI/CD
  // page is missing". Since 2026-10-15 the Pipeline is a page of the
  // dashboard ("Pipeline is part of the Dashboard, just a separate page"):
  // ⇧⌘B opens the Dashboard tab at #/pipeline and, from there, goes back.
  const dashboardTab = () => screen.getByRole('tab', { name: /^Dashboard/ })
  const pipelinePage = () => waitFor(() => {
    const v = document.querySelector('[data-dashboard-view]:not([hidden]) [data-prs-tab]')
    if (!v) throw new Error('no Pipeline page')
    return v
  }, { timeout: 5000 })
  it('opens the Pipeline in the Dashboard tab on ⇧⌘B and goes back to the tab before on ⇧⌘B or Back', async () => {
    await openAgent()
    const shiftCmdB = () => act(() => { fireEvent.keyDown(window, { key: 'B', code: 'KeyB', metaKey: true, shiftKey: true }) })
    cmdB()
    shiftCmdB()
    expect(location.hash).toBe('#/pipeline?of=agent-1')
    await pipelinePage()
    expect(dashboardTab()).toHaveAttribute('aria-selected', 'true')
    // No tab of its own, no deck: the footer's button says it is in front.
    expect(screen.queryAllByRole('tab', { name: /Pipeline/ })).toHaveLength(0)
    expect(deck()).toBeNull()
    expect(pipelineButton()).toHaveAttribute('aria-current', 'true')
    // In the dashboard's nav, marked as the page shown.
    expect(screen.getByRole('link', { name: 'Pipeline' })).toHaveAttribute('aria-current', 'page')
    shiftCmdB()
    await waitFor(() => expect(screen.getByRole('tab', { name: /Fix the login bug/ })).toHaveAttribute('aria-selected', 'true'))
    expect(deck()).toBeInTheDocument()
    // Again, then Back returns.
    shiftCmdB()
    await pipelinePage()
    fireEvent.click(document.querySelector('[data-dashboard-view]:not([hidden]) [data-prs-back]')!)
    await waitFor(() => expect(screen.getByRole('tab', { name: /Fix the login bug/ })).toHaveAttribute('aria-selected', 'true'))
  })

  it('opens the Pipeline from the sidebar footer’s button and from the bar’s own control, and hides the bar with its ×', async () => {
    await openAgent()
    expect(pipelineButton()).toHaveAccessibleName('Pipeline: every pull request on its way — open, CI, merged, released — on the dashboard (⇧⌘B)')
    fireEvent.click(pipelineButton())
    await pipelinePage()
    expect(dashboardTab()).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(pipelineButton())
    await waitFor(() => expect(screen.getByRole('tab', { name: /Fix the login bug/ })).toHaveAttribute('aria-selected', 'true'))
    cmdB()
    expect(deck()).toBeInTheDocument()
    fireEvent.click(deck()!.querySelector('[data-deck-hide]')!)
    expect(deck()).toBeNull()
    expect(JSON.parse(localStorage.getItem(DECK_KEY) ?? '{}')).toMatchObject({ open: false })
    cmdB()
    fireEvent.click(deck()!.querySelector('[data-deck-expand]')!)
    await pipelinePage()
    expect(location.hash).toBe('#/pipeline?of=agent-1')
  })

  it('restores a Pipeline tab stored before it became a page as the Dashboard tab’s Pipeline', async () => {
    localStorage.setItem('caprock.app.workspace.v1', JSON.stringify({ version: 1, activeProject: '', activeByProject: {}, tabs: [
      { id: 'tab-p', projectId: 'p', root: { type: 'pane', id: 'pane-p', target: { kind: 'prs', sessionId: 'prs:agent-1', of: 'agent-1' } }, focusedPaneId: 'pane-p', title: 'Pipeline · app' },
    ] }))
    render(<AppShell />)
    await waitFor(() => expect(document.querySelector('[data-project-row]')).toBeTruthy())
    expect(screen.queryAllByRole('tab', { name: /Pipeline/ })).toHaveLength(0)
    fireEvent.click(dashboardTab())
    expect(location.hash).toBe('#/pipeline?of=agent-1')
    await pipelinePage()
  })

  it('is listed in the palette: Open Pipeline, and the bar on or off', async () => {
    await openAgent()
    act(() => { fireEvent.keyDown(window, { key: 'k', code: 'KeyK', metaKey: true }) })
    fireEvent.change(screen.getByRole('combobox', { name: 'Search' }), { target: { value: 'pipeline' } })
    const options = screen.getAllByRole('option').map((o) => o.textContent ?? '')
    expect(options.some((t) => t.startsWith('Open Pipeline') && t.includes('⇧⌘B'))).toBe(true)
    fireEvent.click(screen.getAllByRole('option').find((o) => o.textContent?.startsWith('Pipeline bar: On'))!)
    expect(await screen.findByRole('region', { name: 'Session deck' })).toBeInTheDocument()
  })
})
