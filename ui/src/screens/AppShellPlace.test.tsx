/**
 * The dashboard keeps its place (lib/screenPlace.ts; owner, 2026-10-14,
 * translated: "When I switch between the dashboard and tabs, I lose the
 * position … I want to continue from the same place"): what a screen showed
 * survives a terminal tab in front and another dashboard screen in front, a
 * hidden screen asks nothing, ⌘0 comes back where it was left and, pressed
 * again, goes to Home at its top.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useContext, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/lib/api'
import { ScreenShown } from '@/lib/refresh'
import { AppShell } from './AppShell'

vi.mock('@/components/TerminalPane', () => ({
  TerminalPane: ({ sessionId }: { sessionId: string }) => <div data-testid={`pane-${sessionId}`} />,
}))

// A screen with a fold of its own: open, it says so — until it is dropped.
function Folded({ name }: { name: string }) {
  const [open, setOpen] = useState(false)
  const shown = useContext(ScreenShown)
  return (
    <div data-testid={`screen-${name}`} data-shown={String(shown)}>
      <button type="button" onClick={() => setOpen(true)}>{`open ${name} row`}</button>
      {open && <p>{`${name} row opened`}</p>}
    </div>
  )
}
const mounts = vi.hoisted(() => ({ now: 0 }))
vi.mock('@/screens/Now', async () => {
  const { useEffect } = await import('react')
  return {
    NowScreen: () => {
      useEffect(() => { mounts.now++ }, [])
      return <Folded name="home" />
    },
  }
})
vi.mock('@/screens/Cost', () => ({ CostScreen: () => <Folded name="cost" /> }))

function sess(p: Partial<SessionSummary>): SessionSummary {
  return {
    session_id: 's', cwd: '/w/app', repo_root: '/w/app', project: 'app', model: 'claude-opus-5', started_at: 0, last_event_at: 1, status: 'active',
    transcript_path: '', has_hooks: true, has_transcript: true, git_branch: 'main', version: '', owned: true,
    stats: { session_id: 's', turns: 3, tool_calls: 5, files_touched: 1, tokens_in: 10, tokens_out: 20, cache_read: 0, cache_write: 0, cost_usd: 0.42 },
    activity: { phrase: '', at: '', health: 'idle' },
    savings: { billed_with: 0, billed_without: 0, saved: 0, hit_rate: 0, cut_pct: 0 },
    ...p,
  } as SessionSummary
}

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      status: async () => ({ version: 'v0.0.0', claude_available: true }),
      sessions: async () => [sess({ session_id: 'agent-1', title: 'Fix the login bug' })],
      summary: async () => ({ cost_usd: 0, projects: [] }),
      permission: async () => ({ permission: null }),
      diff: async () => ({ root: '/w/app', branch: 'main', files: [], stat: '' }),
      editors: async () => ({ editors: [], preferred: '' }),
      recentEvents: async () => [],
    },
  }
})

beforeEach(() => {
  mounts.now = 0
  localStorage.clear()
  localStorage.setItem('caprock.app.sidebar-grouped', 'on')
  sessionStorage.clear()
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
  location.hash = '#/app'
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

const cmd = (key: string, extra: Partial<KeyboardEventInit> = {}) =>
  act(() => { fireEvent.keyDown(window, { key, code: /^\d$/.test(key) ? `Digit${key}` : `Key${key.toUpperCase()}`, metaKey: true, ...extra }) })

/** The dashboard's scroll box, laid out as a browser would: jsdom has no layout. */
function scrollBox(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-dashboard-view]')!
  if (!Object.getOwnPropertyDescriptor(el, 'clientHeight')) {
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => (el.hidden ? 0 : 600) })
  }
  return el
}
function scrollTo(top: number) {
  const el = scrollBox()
  el.scrollTop = top
  fireEvent.scroll(el)
}

async function openDashboard() {
  render(<AppShell />)
  await waitFor(() => expect(document.querySelector('[data-project-row]')).toBeTruthy())
  await cmd('0')
  // The dashboard is a lazy chunk: on a busy machine it takes more than a second.
  await screen.findByTestId('screen-home', {}, { timeout: 8000 })
}

/** A terminal tab in front: the agent's, from the sidebar. */
async function toTerminal() {
  act(() => { location.hash = '#/app' })
  await waitFor(() => expect(scrollBox().hidden).toBe(true))
}

describe('the dashboard keeps its place', () => {
  it('keeps an opened row and the scroll across a terminal tab in front, and asks nothing while hidden', async () => {
    await openDashboard()
    fireEvent.click(screen.getByRole('button', { name: 'open home row' }))
    scrollTo(840)
    await toTerminal()
    // Mounted behind the terminals, told it is out of sight.
    expect(screen.getByTestId('screen-home')).toHaveAttribute('data-shown', 'false')
    await cmd('0')
    await waitFor(() => expect(scrollBox().hidden).toBe(false))
    expect(screen.getByText('home row opened')).toBeInTheDocument()
    expect(screen.getByTestId('screen-home')).toHaveAttribute('data-shown', 'true')
    expect(scrollBox().scrollTop).toBe(840)
    expect(mounts.now).toBe(1)
  }, 20_000)

  it('keeps each screen’s place: Home → Cost → Home', async () => {
    await openDashboard()
    fireEvent.click(screen.getByRole('button', { name: 'open home row' }))
    scrollTo(500)
    act(() => { location.hash = '#/cost' })
    await screen.findByTestId('screen-cost')
    // A screen never opened before starts at its top.
    expect(scrollBox().scrollTop).toBe(0)
    expect(screen.getByTestId('screen-home')).toHaveAttribute('data-shown', 'false')
    scrollTo(120)
    act(() => { location.hash = '#/' })
    await waitFor(() => expect(screen.getByTestId('screen-home')).toHaveAttribute('data-shown', 'true'))
    expect(scrollBox().scrollTop).toBe(500)
    expect(screen.getByText('home row opened')).toBeInTheDocument()
    act(() => { location.hash = '#/cost' })
    await waitFor(() => expect(scrollBox().scrollTop).toBe(120))
    expect(mounts.now).toBe(1)
  }, 20_000)

  it('⌘0 comes back to the screen left; again, Home at its top; at Home’s top, back to the terminals', async () => {
    await openDashboard()
    fireEvent.click(screen.getByRole('button', { name: 'open home row' }))
    scrollTo(700)
    act(() => { location.hash = '#/cost' })
    await screen.findByTestId('screen-cost')
    await toTerminal()
    await cmd('0')
    await waitFor(() => expect(location.hash).toBe('#/cost'))
    await cmd('0')
    await waitFor(() => expect(location.hash).toBe('#/'))
    expect(scrollBox().scrollTop).toBe(0)
    // Home's opened row is still open: only the scroll goes back to the top.
    expect(screen.getByText('home row opened')).toBeInTheDocument()
    await cmd('0')
    await waitFor(() => expect(location.hash).toBe('#/app'))
  }, 20_000)

  it('⌘0 on Home scrolled down goes to its top, not away', async () => {
    await openDashboard()
    scrollTo(900)
    await cmd('0')
    expect(location.hash).toBe('#/')
    expect(scrollBox().scrollTop).toBe(0)
  }, 20_000)

  it('opens #/home and the older #/now on Home', async () => {
    await openDashboard()
    for (const h of ['#/home', '#/now']) {
      act(() => { location.hash = h })
      await waitFor(() => expect(screen.getByTestId('screen-home')).toHaveAttribute('data-shown', 'true'))
      expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page')
    }
  }, 20_000)
})
