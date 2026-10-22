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
import { saveSidebarMode } from '@/lib/sidebarMode'
import { FIND_EVENT } from '@/lib/appkeys'
import { SETTINGS_FIND_EVENT } from '@/lib/settingsSearch'
import { CLOSE_TAB_EVENT } from '@/lib/shell'
import { forgetDevServers, noteDevServer, requestPhonePreview } from '@/lib/devservers'
import { PHONE_PREFS_KEY } from '@/lib/phonemode'
// Imported here rather than inside each test: the first dynamic import
// transformed the whole app inside the first test's 5 s budget, and on a busy
// machine that alone timed it out. vi.mock is hoisted above this.
import { AppShell, nextWaiting, worktreeSlug } from './AppShell'
// The dashboard AppShell loads lazily, loaded with this file for the same
// reason: whichever test opens it first must not pay for transforming it.
import '@/App'

vi.mock('@/components/TerminalPane', () => ({
  // The program's exit, pressed by hand: what /exit or Ctrl+D does to a pane.
  TerminalPane: ({ sessionId, active, onExit }: { sessionId: string; active: boolean; onExit?: (code: number) => void }) => (
    <div data-testid={`pane-${sessionId}`} data-active={String(active)}>
      <button type="button" data-testid={`exit-${sessionId}`} onClick={() => onExit?.(0)} />
    </div>
  ),
}))

// Settings in full needs the whole status; its own test renders it
// (StatusClose.test.tsx). Here only its way out matters: the × it renders
// calls what the app shell provides.
vi.mock('@/screens/Status', async () => {
  const { useCloseSettings } = await import('@/lib/settingsClose')
  return {
    StatusScreen: () => {
      const close = useCloseSettings()
      return <button type="button" aria-label="Close settings" onClick={close}>×</button>
    },
  }
})

// Mail's own test renders it (screens/mail); here only where it opens.
vi.mock('@/screens/mail/MailScreen', () => ({
  MailScreen: ({ fill }: { fill?: boolean }) => <div data-testid="mail-screen" data-fill={String(!!fill)} />,
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
  sess({ session_id: 'theirs', title: 'Started elsewhere', owned: false, cwd: '/w/other', repo_root: '/w/other', project: 'other', resume: { ok: true, command: 'claude --resume theirs' } }),
]

const editorCalls = vi.hoisted(() => [] as { path: string; line?: number; editor?: string }[])
// Every quick chat starts as chat-1, chat-2, … in its own dated folder, as
// the daemon makes one (internal/agents newChatDir).
const spawned = vi.hoisted(() => ({ n: 0, shells: 0, health: 'idle' as 'idle' | 'working', signals: [] as [string, string][], reqs: [] as Record<string, unknown>[] }))
const chatSession = (id: string) => sess({
  session_id: id, cwd: `/data/caprock/chats/2026-10-12-00515${id.slice(-1)}`, repo_root: '', project: 'chat · Oct 12, 00:51', model: '', title: undefined,
  activity: { phrase: '', at: '', health: spawned.health },
})

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      status: async () => ({ version: 'v0.0.0', claude_available: true, events: 0 }),
      sessions: async () => sessions,
      spawn: async (req: Record<string, unknown>) => {
        spawned.reqs.push(req)
        spawned.n += 1
        const id = `chat-${spawned.n}`
        sessions.push(chatSession(id))
        return { session_id: id, cwd: chatSession(id).cwd }
      },
      summary: async () => ({ cost_usd: 1.25, savings: { billed_with: 0, billed_without: 0, saved: 0, hit_rate: 0, cut_pct: 0 }, projects: [{ project: 'app', dir: '/w/app', cost_usd: 1.25, tokens: 0, sessions: 2 }], rate_limits: { five_hour: { used_percentage: 40, resets_at: 0 } } }),
      signal: async (id: string, action: string) => { spawned.signals.push([id, action]) },
      permission: async () => ({ permission: null }),
      diff: async () => ({ root: '/w/app', branch: 'main', files: [], stat: '' }),
      editors: async () => ({ editors: [{ id: 'zed', name: 'Zed' }, { id: 'vscode', name: 'VS Code' }], preferred: 'zed' }),
      openInEditor: async (req: { path: string; line?: number; editor?: string }) => { editorCalls.push(req); return { editor: { id: 'zed', name: 'Zed' } } },
      recentEvents: async () => [{ id: 1, ts: '2026-10-05T10:00:00Z', session_id: 'agent-1', source: 'hook', kind: 'turn.user', payload: { prompt: 'Fix it, please' } }],
    },
  }
})

const fetchMock = vi.fn(async (_url?: unknown) => new Response('', { status: 404 }))

beforeEach(() => {
  spawned.n = 0
  spawned.shells = 0
  spawned.health = 'idle'
  spawned.signals = []
  spawned.reqs = []
  sessions.splice(3)
  localStorage.clear()
  // Most of these were written for the Tree sidebar; Flat, a new viewer's default, has its own tests.
  localStorage.setItem('caprock.app.sidebar-grouped', 'on')
  sessionStorage.clear()
  // A test may give the daemon a project list (daemonProjects); the rest have none.
  fetchMock.mockImplementation(async () => new Response('', { status: 404 }))
  vi.stubGlobal('fetch', fetchMock)
  location.hash = '#/app'
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function renderApp() {
  const view = render(<AppShell />)
  // The sidebar lists projects; what waits on you is a marked row under its
  // project (there is no separate Waiting on you block).
  await waitFor(() => expect(document.querySelector('[data-project-row]')).toBeTruthy())
  await waitFor(() => expect(waitingRow('Waiting one')).toBeTruthy())
  return view
}

/** The sidebar row of a session waiting on you, by its title: what waits is always listed, never folded. */
function waitingRow(title: string): HTMLElement {
  return [...document.querySelectorAll<HTMLElement>('[data-waiting]')].find((r) => r.textContent?.includes(title))!
}

const cmd = (key: string, extra: Partial<KeyboardEventInit> = {}) =>
  act(() => { fireEvent.keyDown(window, { key, code: /^\d$/.test(key) ? `Digit${key}` : `Key${key.toUpperCase()}`, metaKey: true, ...extra }) })

/** Opens a session the way a person does when it is not in a tab: ⌘K, its name, Enter. */
async function openFromPalette(text: string) {
  await cmd('k')
  const input = screen.getByRole('combobox', { name: 'Search' })
  fireEvent.change(input, { target: { value: text } })
  const option = screen.getAllByRole('option').find((o) => o.textContent?.startsWith(text))!
  fireEvent.click(option)
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull())
}

describe('the app workspace', () => {
  it('lists projects from sessions, what waits on you marked on its own row', async () => {
    await renderApp()
    expect(screen.queryByRole('region', { name: 'Waiting on you' })).toBeNull()
    expect(waitingRow('Waiting one')).toHaveAttribute('data-live-row', 'agent-2')
    expect(within(waitingRow('Waiting one')).getByText('waiting')).toBeInTheDocument()
    const projects = [...document.querySelectorAll('[data-project-row]')].map((b) => b.querySelector('span.truncate')?.textContent)
    expect(projects.sort()).toEqual(['app', 'other'])
    // Today, in the sidebar's Today strip; the status strip leaves it out
    // while the sidebar shows it.
    const today = screen.getByRole('region', { name: 'Today' })
    expect(await within(today).findByText('$1.25')).toBeInTheDocument()
    expect(within(document.querySelector('footer')!).queryByText('$1.25')).toBeNull()
    expect(screen.getByLabelText('1 waiting on you')).toBeInTheDocument()
    // A project's row: what runs in it, nothing else.
    expect(screen.getByLabelText('2 running')).toBeInTheDocument()
    // With the sidebar closed the status strip carries them again.
    await act(() => { fireEvent.keyDown(window, { key: '\\', code: 'Backslash', metaKey: true }) })
    expect(screen.queryByRole('region', { name: 'Today' })).toBeNull()
    expect(within(document.querySelector('footer')!).getByText('$1.25')).toBeInTheDocument()
    expect(within(document.querySelector('footer')!).getByText('40%')).toBeInTheDocument()
  })

  it('tells the desktop shell it lays out around the title bar itself, and stops saying so when gone', async () => {
    const view = await renderApp()
    expect(document.documentElement.hasAttribute('data-caprock-chrome')).toBe(true)
    view.unmount()
    expect(document.documentElement.hasAttribute('data-caprock-chrome')).toBe(false)
  })

  it('opens a session as a tab, and ⌘W then Enter closes the tab without stopping anything', async () => {
    await renderApp()
    await openFromPalette('Fix the login bug')
    const tab = await screen.findByRole('tab', { name: /Fix the login bug/ })
    expect(tab).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('pane-agent-1')).toHaveAttribute('data-active', 'true')
    await cmd('w')
    // An agent Caprock started, still working: one short line and two
    // buttons with a few words each, Keep recommended (filled) and in focus,
    // no checkbox (owner, 2026-10-17).
    const sheet = await screen.findByRole('dialog', { name: "Close an agent's tab" })
    expect(within(sheet).getByText(/^“Fix the login bug” is still working\.$/)).toBeInTheDocument()
    const keep = within(sheet).getByRole('button', { name: 'Keep it running' })
    expect(keep).toHaveFocus()
    expect(keep).toHaveAccessibleDescription(/^It works on in the background\.$/)
    const stop = within(sheet).getByRole('button', { name: 'Stop it' })
    expect(stop).toHaveAccessibleDescription(/^Continue later from History\.$/)
    // Keep is the recommended one: drawn filled, Stop outlined.
    expect(keep.className).toMatch(/bg-accent/)
    expect(stop.className).not.toMatch(/bg-accent/)
    expect(within(sheet).queryByRole('checkbox')).toBeNull()
    expect(within(sheet).queryAllByRole('button').map((b) => b.textContent).filter((t) => t !== '')).toEqual(['Keep it running', 'Stop it'])
    fireEvent.click(keep)
    await waitFor(() => expect(screen.queryByRole('tab')).not.toBeInTheDocument())
    // An agent's tab is not its process: closing it stops nothing.
    await act(async () => { await Promise.resolve() })
    expect(spawned.signals).toEqual([])
    expect(localStorage.getItem('caprock.app.agent-close')).toBeNull()
  })

  // Owner, 2026-10-16 (translated): "Cmd+W must close tabs." In the macOS
  // app the menu's Close Tab holds ⌘W, so the page never sees the key: it
  // hears CLOSE_TAB_EVENT, and closes exactly as the key and the × do.
  it('closes the tab in front, with the same confirm, when the app menu’s Close Tab asks; on the Dashboard nothing', async () => {
    await renderApp()
    await openFromPalette('Fix the login bug')
    await screen.findByRole('tab', { name: /Fix the login bug/ })
    act(() => { window.dispatchEvent(new Event(CLOSE_TAB_EVENT)) })
    const sheet = await screen.findByRole('dialog', { name: "Close an agent's tab" })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Keep it running' }))
    await waitFor(() => expect(screen.queryByRole('tab')).not.toBeInTheDocument())
    // No tab left, the Dashboard in front: Close Tab closes nothing and asks nothing.
    const hash = location.hash
    act(() => { window.dispatchEvent(new Event(CLOSE_TAB_EVENT)) })
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByRole('dialog', { name: "Close an agent's tab" })).toBeNull()
    expect(location.hash).toBe(hash)
    expect(spawned.signals).toEqual([])
  })

  // Owner, 2026-10-15 (translated): "I never understand whether data is
  // kept and which button to pick. It must be very simple — one button."
  it('ends an idle agent Caprock started with its tab, no question, and says the conversation is saved', async () => {
    const was = sessions[0]!
    sessions[0] = { ...was, activity: { phrase: '', at: '', health: 'idle' } }
    try {
      await renderApp()
      await openFromPalette('Fix the login bug')
      await screen.findByRole('tab', { name: /Fix the login bug/ })
      await cmd('w')
      // `end`: asked to stop first, so the transcript is written and --resume works.
      await waitFor(() => expect(spawned.signals).toEqual([['agent-1', 'end']]))
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(screen.queryByRole('tab')).not.toBeInTheDocument()
      expect(await screen.findByText('Closed. The conversation is saved — reopen it from History or the sidebar.')).toBeInTheDocument()
      expect(localStorage.getItem('caprock.app.agent-close')).toBeNull()
    } finally {
      sessions[0] = was
    }
  })

  it('stops an agent that is still working from its own button, in one step', async () => {
    await renderApp()
    await openFromPalette('Fix the login bug')
    await screen.findByRole('tab', { name: /Fix the login bug/ })
    await cmd('w')
    const sheet = await screen.findByRole('dialog', { name: "Close an agent's tab" })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Stop it' }))
    await waitFor(() => expect(spawned.signals).toEqual([['agent-1', 'end']]))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
    expect(await screen.findByText('Closed. The conversation is saved — reopen it from History or the sidebar.')).toBeInTheDocument()
  })

  it('cancels on Escape: the tab stays and nothing is stopped', async () => {
    await renderApp()
    await openFromPalette('Fix the login bug')
    await screen.findByRole('tab', { name: /Fix the login bug/ })
    await cmd('w')
    await screen.findByRole('dialog', { name: "Close an agent's tab" })
    await act(() => { fireEvent.keyDown(window, { key: 'Escape' }) })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByRole('tab', { name: /Fix the login bug/ })).toBeInTheDocument()
    expect(spawned.signals).toEqual([])
  })

  it('asks once more before ending an agent that is still answering, and Keep leaves it running', async () => {
    localStorage.setItem('caprock.app.agent-close', 'end')
    await renderApp()
    await openFromPalette('Fix the login bug')
    await screen.findByRole('tab', { name: /Fix the login bug/ })
    await cmd('w')
    const sheet = await screen.findByRole('dialog', { name: 'End an agent that is answering' })
    expect(within(sheet).getByText('End the agent? It is still answering.')).toBeInTheDocument()
    fireEvent.click(within(sheet).getByRole('button', { name: 'Keep it running, close tab' }))
    await waitFor(() => expect(screen.queryByRole('tab')).not.toBeInTheDocument())
    await act(async () => { await Promise.resolve() })
    expect(spawned.signals).toEqual([])
  })

  it('never asks about, or signals, an agent another terminal started: its tab just closes (rule 7)', async () => {
    localStorage.setItem('caprock.app.agent-close', 'end')
    await renderApp()
    await openFromPalette('Started elsewhere')
    await screen.findByRole('tab', { name: /Started elsewhere/ })
    await cmd('w')
    await waitFor(() => expect(screen.queryByRole('tab')).not.toBeInTheDocument())
    expect(screen.queryByRole('dialog')).toBeNull()
    await act(async () => { await Promise.resolve() })
    expect(spawned.signals).toEqual([])
  })

  /** What the page asked the daemon to change: any request but a read. */
  const writes = () => fetchMock.mock.calls.filter((c) => {
    const init = (c as unknown[])[1] as RequestInit | undefined
    return !!init?.method && init.method !== 'GET'
  })

  it('shows an agent tab as its chat, over the terminal that stays mounted, from its one view icon', async () => {
    await renderApp()
    await openFromPalette('Fix the login bug')
    await screen.findByRole('tab', { name: /Fix the login bug/ })
    // A project session opens on its terminal; the icon offers the other view.
    const toChat = screen.getByRole('button', { name: 'Show as chat' })
    expect(toChat).toHaveAttribute('data-view-switch')
    expect(toChat).toHaveAttribute('title', 'Show as chat')
    expect(toChat.textContent).toBe('')
    expect(screen.queryByRole('button', { name: 'Show as terminal' })).toBeNull()
    fetchMock.mockClear()
    fireEvent.click(toChat)
    expect(await screen.findByText('Fix it, please')).toBeInTheDocument()
    // One icon, flipped: now it offers the terminal.
    const toTerminal = screen.getByRole('button', { name: 'Show as terminal' })
    expect(screen.queryByRole('button', { name: 'Show as chat' })).toBeNull()
    expect(document.querySelectorAll('[data-view-switch]')).toHaveLength(1)
    // Still mounted, but out of view under the cover as on a tab switch, so
    // it comes back the same way (owner, 2026-10-14).
    const pane = screen.getByTestId('pane-agent-1')
    expect(pane).toHaveAttribute('data-active', 'false')
    expect(pane.closest('[data-tab-panel]')).toHaveAttribute('hidden')
    fireEvent.click(toTerminal)
    expect(screen.queryByRole('log')).not.toBeInTheDocument()
    expect(pane).toHaveAttribute('data-active', 'true')
    expect(pane.closest('[data-tab-panel]')).not.toHaveAttribute('hidden')
    expect(screen.getByRole('button', { name: 'Show as chat' })).toBeInTheDocument()
    // The same pane all along: never restarted, signalled or typed into.
    expect(screen.getByTestId('pane-agent-1')).toBe(pane)
    await act(async () => { await Promise.resolve() })
    expect(spawned.signals).toEqual([])
    expect(writes()).toEqual([])
  })

  it('remembers the view per session: a reopened tab, and a new window, open the way it was left', async () => {
    const view = await renderApp()
    await openFromPalette('Fix the login bug')
    await screen.findByRole('tab', { name: /Fix the login bug/ })
    fireEvent.click(screen.getByRole('button', { name: 'Show as chat' }))
    expect(JSON.parse(localStorage.getItem('caprock.app.session-view') ?? '{}')).toEqual({ 'agent-1': 'chat' })
    // Another session keeps its own default.
    fireEvent.click(waitingRow('Waiting one'))
    await screen.findByRole('tab', { name: /Waiting one/ })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Show as chat' })).toBeInTheDocument())
    view.unmount()
    await renderApp()
    fireEvent.click(await screen.findByRole('tab', { name: /Fix the login bug/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Show as terminal' })).toBeInTheDocument())
    expect(await screen.findByText('Fix it, please')).toBeInTheDocument()
  })

  // Every way a terminal comes back into view is its pane going active
  // false -> true, which re-sends its glyphs before the first frame
  // (TerminalPane): the owner saw garbage after closing a tab and after the
  // chat (2026-10-14). Closing the tab in front shows its neighbour; the
  // dashboard hides every terminal, and coming back shows the one in front.
  it('shows the neighbour when the tab in front closes, and every terminal goes out of view under the dashboard and back', async () => {
    await renderApp()
    await openFromPalette('Fix the login bug')
    fireEvent.click(waitingRow('Waiting one'))
    await screen.findByRole('tab', { name: /Waiting one/ })
    const active = (id: string) => screen.getByTestId(`pane-${id}`).getAttribute('data-active')
    expect([active('agent-1'), active('agent-2')]).toEqual(['false', 'true'])
    await cmd('d', { shiftKey: true })
    await screen.findByRole('tab', { name: /Dashboard/ })
    expect([active('agent-1'), active('agent-2')]).toEqual(['false', 'false'])
    fireEvent.click(screen.getByRole('tab', { name: /Waiting one/ }))
    await waitFor(() => expect(active('agent-2')).toBe('true'))
    expect(active('agent-1')).toBe('false')
    await cmd('w')
    fireEvent.click(within(await screen.findByRole('dialog', { name: "Close an agent's tab" })).getByRole('button', { name: 'Keep it running' }))
    await waitFor(() => expect(screen.queryByTestId('pane-agent-2')).not.toBeInTheDocument())
    expect(active('agent-1')).toBe('true')
  })

  it('opens a session it does not own in a tab of its own, read-only, never as a terminal (rule 7; owner, 2026-10-13)', async () => {
    await renderApp()
    await openFromPalette('Started elsewhere')
    const tab = await screen.findByRole('tab', { name: /Started elsewhere/ })
    expect(tab).toHaveAttribute('aria-selected', 'true')
    expect(location.hash).not.toBe('#/session/theirs')
    expect(document.querySelector('[data-observe-pane="theirs"]')).toBeInTheDocument()
    expect(screen.getByText(/Started in another terminal — Caprock watches it, it can’t type into it/)).toBeInTheDocument()
    expect(screen.queryByTestId('pane-theirs')).not.toBeInTheDocument()
    // Open in dashboard is the way to the session's page, on demand.
    fireEvent.click(document.querySelector<HTMLElement>('[data-observe-dashboard]')!)
    expect(location.hash).toBe('#/session/theirs')
    expect(spawned.signals).toEqual([])
  })

  it('a click on a sidebar row from another terminal opens its tab, not the Dashboard tab (owner, 2026-10-13)', async () => {
    await renderApp()
    const row = await waitFor(() => {
      const r = [...document.querySelectorAll<HTMLElement>('button[title]')].find((b) => b.title.startsWith('Started elsewhere') && b.title.includes('started in another terminal'))
      if (!r) throw new Error('no row')
      return r
    })
    fireEvent.click(row)
    expect(await screen.findByRole('tab', { name: /Started elsewhere/ })).toHaveAttribute('aria-selected', 'true')
    expect(location.hash).not.toBe('#/session/theirs')
    expect(document.querySelector('[data-observe-pane="theirs"]')).toBeInTheDocument()
  })

  it('Continue here on a session from another terminal starts a copy in a new tab, and leaves the original alone', async () => {
    await renderApp()
    await openFromPalette('Started elsewhere')
    await screen.findByRole('tab', { name: /Started elsewhere/ })
    spawned.reqs.length = 0
    fireEvent.click(await screen.findByRole('button', { name: 'Continue here' }))
    await waitFor(() => expect(spawned.reqs).toHaveLength(1))
    expect(spawned.reqs[0]).toMatchObject({ cwd: '/w/other', resume: 'theirs', fork: true })
    const id = `chat-${spawned.n}`
    // A loaded CI runner took longer than waitFor's one second (2026-10-19),
    // then longer than three (the v0.140.2 release run, 2026-10-21).
    await waitFor(() => expect(screen.getByTestId(`pane-${id}`)).toHaveAttribute('data-active', 'true'), { timeout: 10000 })
    // The watched tab stays; nothing was sent to the other terminal's process.
    expect(screen.getByRole('tab', { name: /Started elsewhere/ })).toBeInTheDocument()
    expect(spawned.signals).toEqual([])
  }, 15000)

  it('hides a watched session from its tab’s menu: the tab closes and the row is unlisted', async () => {
    await renderApp()
    await openFromPalette('Started elsewhere')
    await screen.findByRole('tab', { name: /Started elsewhere/ })
    fireEvent.click(screen.getByRole('button', { name: 'More for Started elsewhere' }))
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Hide from the list' }))
    await waitFor(() => expect(screen.queryByRole('tab', { name: /Started elsewhere/ })).not.toBeInTheDocument())
    expect(Object.keys(JSON.parse(localStorage.getItem('caprock.app.hidden-sessions') ?? '{}'))).toContain('theirs')
    expect(spawned.signals).toEqual([])
  })

  it('lists the current project’s tabs in the sidebar as the strip shows them, and one click brings a project back (tester, 2026-10-09)', async () => {
    await renderApp()
    await openFromPalette('Fix the login bug')
    await screen.findByRole('tab', { name: /Fix the login bug/ })
    const appRow = () => [...document.querySelectorAll<HTMLElement>('[data-project-row]')].find((b) => b.textContent?.startsWith('app'))!
    const otherRow = () => [...document.querySelectorAll<HTMLElement>('[data-project-row]')].find((b) => b.textContent?.startsWith('other'))!
    // The sidebar's list under the current project is the strip, word for word.
    const list = screen.getByRole('group', { name: 'app: sessions' })
    expect(within(list).getByText('Fix the login bug')).toBeInTheDocument()
    expect(document.querySelectorAll('[aria-current="true"]')).toHaveLength(1)
    // Another project: its empty state, the app's tab still in the strip with
    // its project's chip (Vova, 2026-10-09: tabs must never vanish), and the
    // app's row still open with its running count: a project where something
    // runs stays expanded (owner, 2026-10-11).
    fireEvent.click(otherRow())
    await waitFor(() => expect(screen.getByRole('tab', { name: /Fix the login bug/ })).toHaveAttribute('aria-selected', 'false'))
    // Named by its session; its project in the name read out and the tooltip.
    expect(screen.getByRole('tab', { name: 'Fix the login bug · app' }).getAttribute('title')).toContain('· app')
    expect(screen.getByTestId('pane-agent-1')).toBeInTheDocument()
    expect(within(screen.getByRole('group', { name: 'app: sessions' })).getByText('Fix the login bug')).toBeInTheDocument()
    expect(within(appRow()).getByLabelText(/running/)).toBeInTheDocument()
    expect(document.querySelectorAll('[aria-current="true"]')).toHaveLength(0)
    // One click back on the tab, and its project is current again.
    fireEvent.click(screen.getByRole('tab', { name: /Fix the login bug/ }))
    expect(screen.getByRole('tab', { name: /Fix the login bug/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('group', { name: 'app: sessions' })).toBeInTheDocument()
  })

  it('opens the dashboard as a tab beside the terminals, and one click comes back', async () => {
    await renderApp()
    await openFromPalette('Fix the login bug')
    await screen.findByRole('tab', { name: /Fix the login bug/ })
    await cmd('d', { shiftKey: true })
    const dash = await screen.findByRole('tab', { name: /Dashboard/ })
    expect(dash).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: /Fix the login bug/ })).toHaveAttribute('aria-selected', 'false')
    fireEvent.click(screen.getByRole('tab', { name: /Fix the login bug/ }))
    await waitFor(() => expect(location.hash).toBe('#/app'))
    expect(screen.getByRole('tab', { name: /Fix the login bug/ })).toHaveAttribute('aria-selected', 'true')
    // Still in the strip, and it closes like any tab.
    const back = screen.getByRole('tab', { name: /Dashboard/ })
    fireEvent.click(within(back).getByRole('button', { name: 'Close tab Dashboard' }))
    expect(screen.queryByRole('tab', { name: /Dashboard/ })).not.toBeInTheDocument()
  })

  // Owner, 2026-10-14 (translated): "a button ... in the left bottom ... opens
  // another system tab with its own key combo, and Mail is there. It's not
  // there until you click it."
  it('opens Mail in a tab of its own from the sidebar and ⇧⌘M, beside the Dashboard tab, and closes it', async () => {
    await renderApp()
    expect(screen.queryByRole('tab', { name: 'Mail' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Mail/ }))
    const mail = await screen.findByRole('tab', { name: 'Mail' })
    expect(mail).toHaveAttribute('aria-selected', 'true')
    expect(location.hash).toBe('#/mail')
    expect(await screen.findByTestId('mail-screen')).toHaveAttribute('data-fill', 'true')
    // Not the Dashboard tab's: that one is not opened by Mail.
    expect(screen.queryByRole('tab', { name: /Dashboard/ })).not.toBeInTheDocument()
    // ⌘0 to the dashboard: the Mail tab stays, behind.
    await cmd('0')
    expect(await screen.findByRole('tab', { name: /Dashboard/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Mail' })).toHaveAttribute('aria-selected', 'false')
    // ⇧⌘M brings it back to the front, once.
    await cmd('m', { shiftKey: true })
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Mail' })).toHaveAttribute('aria-selected', 'true'))
    expect(screen.getAllByRole('tab', { name: 'Mail' })).toHaveLength(1)
    fireEvent.click(within(screen.getByRole('tab', { name: 'Mail' })).getByRole('button', { name: 'Close tab Mail' }))
    await waitFor(() => expect(location.hash).toBe('#/app'))
    expect(screen.queryByRole('tab', { name: 'Mail' })).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Dashboard/ })).toBeInTheDocument()
  })

  // Owner, 2026-10-15 (translated): "Mail still launches in a crappy way; it
  // should be native — either call the installed app, or show a big banner
  // to go there."
  it('puts a banner over the browser’s Mail tab that opens Mail alone in a window, as ⇧⌘M there does', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    await renderApp()
    fireEvent.click(screen.getByRole('button', { name: /^Mail/ }))
    const banner = await waitFor(() => {
      const b = document.querySelector<HTMLElement>('[data-banner="mail-window"]')
      expect(b).toBeTruthy()
      return b!
    })
    expect(banner.textContent).toContain('Mail works best in its own window')
    expect(banner.textContent).toContain('⇧⌘M')
    fireEvent.click(within(banner).getByRole('button', { name: /Open in its own window/ }))
    expect(open).toHaveBeenLastCalledWith(`${location.origin}/?mail=1`, 'caprock-mail', expect.any(String))
    await cmd('m', { shiftKey: true })
    expect(open).toHaveBeenCalledTimes(2)
    expect(screen.getAllByRole('tab', { name: 'Mail' })).toHaveLength(1)
  })

  describe('in the desktop app', () => {
    const calls: string[] = []
    let answers: Record<string, boolean | Error> = {}
    beforeEach(() => {
      calls.length = 0
      ;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
        invoke: async (c: string) => {
          if (c === 'open_mail_app' || c === 'open_mail_window') {
            calls.push(c)
            const a = answers[c]
            if (a instanceof Error) throw a
            return a
          }
          throw new Error(c)
        },
      }
    })
    afterEach(() => { delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ })

    it('opens the installed Caprock Mail and no tab', async () => {
      answers = { open_mail_app: true, open_mail_window: true }
      await renderApp()
      fireEvent.click(screen.getByRole('button', { name: /^Mail/ }))
      await waitFor(() => expect(calls).toEqual(['open_mail_app']))
      await cmd('m', { shiftKey: true })
      await waitFor(() => expect(calls).toEqual(['open_mail_app', 'open_mail_app']))
      expect(location.hash).toBe('#/app')
      expect(screen.queryByRole('tab', { name: 'Mail' })).not.toBeInTheDocument()
      expect(document.querySelector('[data-banner="mail-window"]')).toBeNull()
    })

    it('opens its own Mail window when the preview is not installed, and goes back from #/mail', async () => {
      answers = { open_mail_app: false, open_mail_window: true }
      await renderApp()
      fireEvent.click(screen.getByRole('button', { name: /^Mail/ }))
      await waitFor(() => expect(calls).toEqual(['open_mail_app', 'open_mail_window']))
      expect(screen.queryByRole('tab', { name: 'Mail' })).not.toBeInTheDocument()
      // A link to #/mail (the dashboard's Mail) does the same and returns.
      act(() => { location.hash = '#/mail' })
      await waitFor(() => expect(calls).toHaveLength(4))
      await waitFor(() => expect(location.hash).toBe('#/app'))
      expect(screen.queryByRole('tab', { name: 'Mail' })).not.toBeInTheDocument()
    })

    it('falls back to the Mail tab in a shell without the commands', async () => {
      answers = { open_mail_app: new Error('unknown command'), open_mail_window: new Error('unknown command') }
      await renderApp()
      fireEvent.click(screen.getByRole('button', { name: /^Mail/ }))
      expect(await screen.findByRole('tab', { name: 'Mail' })).toHaveAttribute('aria-selected', 'true')
      expect(location.hash).toBe('#/mail')
      expect(document.querySelector('[data-banner="mail-window"]')).toBeNull()
    })
  })

  // Owner, 2026-10-10: Settings had no way out on the page. Its × closes the
  // tab, as the strip's × does, and the tab stays closed (it used to reopen
  // in the render before the hash change arrived).
  it('closes Settings from the page’s own ×, and from the strip’s, for good', async () => {
    await renderApp()
    for (const how of ['page', 'strip'] as const) {
      await cmd(',')
      // The dashboard is a lazy chunk: on a busy machine it takes more than a second.
      const x = await screen.findByRole('button', { name: 'Close settings' }, { timeout: 8000 })
      expect(screen.getByRole('tab', { name: /Settings/ })).toHaveAttribute('aria-selected', 'true')
      if (how === 'page') fireEvent.click(x)
      else fireEvent.click(within(screen.getByRole('tab', { name: /Settings/ })).getByRole('button', { name: 'Close tab Settings' }))
      await waitFor(() => expect(location.hash).toBe('#/app'))
      expect(screen.queryByRole('tab', { name: /Settings|Dashboard/ }), how).not.toBeInTheDocument()
    }
  }, 20_000)

  // One keystroke, one chat (ADR-071; owner, 2026-10-16): the sidebar's
  // Quick chat and ⌥⌘N start one at once on the vendor and model used last,
  // and its tab opens on the conversation, not on a terminal. The chooser
  // of 2026-10-12 stays one step away, as Quick chat with….
  it('starts a quick chat at once from the sidebar, on its conversation, without leaving the workspace', async () => {
    await renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Quick chat' }))
    const tab = await screen.findByRole('tab', { name: /Quick chat/ })
    expect(screen.queryByRole('dialog', { name: 'Quick chat' })).toBeNull()
    expect(tab).toHaveAttribute('aria-selected', 'true')
    expect(location.hash).toBe('#/app')
    expect(screen.getByTestId('pane-chat-1')).toBeInTheDocument()
    expect(spawned.reqs[0]).toMatchObject({ chat: true })
    await waitFor(() => expect(document.querySelector('[data-chat-view]')).toBeTruthy())
    // A chat opens on Chat; its terminal is a switch away, and back.
    expect(screen.getByRole('button', { name: 'Show as terminal' })).toBeInTheDocument()
    fetchMock.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Show as terminal' }))
    await waitFor(() => expect(document.querySelector('[data-chat-view]')).toBeNull())
    expect(screen.getByTestId('pane-chat-1')).toHaveAttribute('data-active', 'true')
    expect(JSON.parse(localStorage.getItem('caprock.app.session-view') ?? '{}')).toEqual({ 'chat-1': 'terminal' })
    fireEvent.click(screen.getByRole('button', { name: 'Show as chat' }))
    await waitFor(() => expect(document.querySelector('[data-chat-view]')).toBeTruthy())
    await act(async () => { await Promise.resolve() })
    expect(spawned.signals).toEqual([])
    expect(writes()).toEqual([])
  })

  it('starts on ⌥⌘N at once, on the agent and model picked last', async () => {
    localStorage.setItem('caprock.quickchat', JSON.stringify({ agent: 'claude', model: 'claude-sonnet-5-5' }))
    await renderApp()
    await cmd('n', { altKey: true })
    const tab = await screen.findByRole('tab', { name: /Quick chat/ })
    expect(tab).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('dialog', { name: 'Quick chat' })).toBeNull()
    expect(spawned.reqs[0]).toMatchObject({ chat: true, model: 'claude-sonnet-5-5' })
    expect(screen.getByTestId('pane-chat-1')).toBeInTheDocument()
  })

  it('asks which agent and model from Quick chat with…, and Esc starts nothing', async () => {
    localStorage.setItem('caprock.quickchat', JSON.stringify({ agent: 'claude', model: 'claude-sonnet-5-5' }))
    await renderApp()
    fireEvent.click(screen.getAllByRole('button', { name: 'New' })[0]!)
    fireEvent.click(await screen.findByRole('menuitem', { name: /Quick chat with/ }))
    const chooser = await screen.findByRole('dialog', { name: 'Quick chat' })
    const list = within(chooser).getByRole('listbox')
    expect(list).toHaveFocus()
    expect(within(list).getByRole('option', { selected: true })).toHaveTextContent(/Sonnet 5\.5/)
    fireEvent.keyDown(list, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Quick chat' })).toBeNull())
    expect(spawned.n).toBe(0)
    expect(screen.queryByRole('tab')).toBeNull()
  })

  /** Starts a quick chat on Opus 5.5 the way the owner does, and waits for its tab. */
  async function startChat() {
    localStorage.setItem('caprock.quickchat', JSON.stringify({ agent: 'claude', model: 'claude-opus-5-5' }))
    await renderApp()
    await cmd('n', { altKey: true })
    return screen.findByRole('tab', { name: /Quick chat/ })
  }

  // Owner, 2026-10-12: the tab said "Outside projects", the group it sits in.
  it('names a quick chat’s tab, sidebar row and inspector after the chat, not its group', async () => {
    const tab = await startChat()
    await waitFor(() => expect(tab).toHaveTextContent('Quick chat · Opus 5.5'))
    expect(tab).not.toHaveTextContent('Outside projects')
    // The sidebar lists tabs by the strip's own labels (lib/tablabels.ts); nothing says "new session".
    expect(screen.queryByText('new session')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Quick chat · Opus 5.5' })).toBeInTheDocument()
  })

  it('says in the chat how to leave it, until the hint is dismissed for good', async () => {
    await startChat()
    const hint = await screen.findByRole('note', { name: 'Quick chat' })
    expect(hint).toHaveTextContent('Quick chat with Claude · Opus 5.5 — ⌘W or /exit ends it')
    fireEvent.click(within(hint).getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('note', { name: 'Quick chat' })).toBeNull()
    expect(localStorage.getItem('caprock.quickchat.hint')).toBe('dismissed')
  })

  // Owner, 2026-10-12: after /exit the tab turned into a login shell in the
  // chat's hidden folder, looking just like before, and only a reload got
  // him out. An ended chat says so in place, with the two ways on.
  it('leaves an ended quick chat in its tab with Close tab and Start again, not a shell', async () => {
    await startChat()
    fetchMock.mockClear()
    fireEvent.click(screen.getByTestId('exit-chat-1'))
    const ended = await screen.findByRole('group', { name: 'The chat ended' })
    expect(screen.getByRole('tab', { name: /Quick chat/ })).toBeInTheDocument()
    expect(screen.getByTestId('pane-chat-1')).toBeInTheDocument()
    // No shell is started in its place: no POST to /shells (a background GET
    // of the list may land here and is not the point).
    expect(fetchMock.mock.calls.some((c) => {
      const [url, init] = c as unknown as [unknown, RequestInit | undefined]
      return String(url).includes('/shells') && (init?.method ?? 'GET').toUpperCase() === 'POST'
    })).toBe(false)
    expect(within(ended).getByRole('button', { name: 'Close tab' })).toHaveFocus()
    // Start again: a new chat on the same agent and model, in the same tab.
    fireEvent.click(within(ended).getByRole('button', { name: 'Start again' }))
    await waitFor(() => expect(screen.getByTestId('pane-chat-2')).toBeInTheDocument())
    expect(screen.queryByTestId('pane-chat-1')).toBeNull()
    expect(screen.getAllByRole('tab')).toHaveLength(1)
    expect(screen.queryByRole('group', { name: 'The chat ended' })).toBeNull()
    // And Close tab closes it.
    fireEvent.click(screen.getByTestId('exit-chat-2'))
    fireEvent.click(within(await screen.findByRole('group', { name: 'The chat ended' })).getByRole('button', { name: 'Close tab' }))
    await waitFor(() => expect(screen.queryByRole('tab')).toBeNull())
  })

  it('closes a quick chat with ⌘W from inside it, and ⌘0 goes to the dashboard', async () => {
    await startChat()
    await cmd('0')
    await waitFor(() => expect(location.hash).not.toBe('#/app'))
    fireEvent.click(screen.getByRole('tab', { name: /Quick chat/ }))
    await waitFor(() => expect(location.hash).toBe('#/app'))
    await cmd('w')
    expect(screen.queryByRole('tab', { name: /Quick chat/ })).toBeNull()
  })

  // Owner, 2026-10-12: closed chats piled up as idle sessions under Outside projects.
  it('ends an idle quick chat with its tab, without asking', async () => {
    await startChat()
    await cmd('w')
    await waitFor(() => expect(spawned.signals).toEqual([['chat-1', 'end']]))
    expect(screen.queryByRole('tab', { name: /Quick chat/ })).toBeNull()
    expect(screen.queryByRole('dialog', { name: /Close a chat/ })).toBeNull()
  })

  it('asks once before ending a quick chat that is still answering', async () => {
    spawned.health = 'working'
    // The close reads the session list: wait until it has the chat, answering.
    await startChat()
    await screen.findByRole('heading', { name: 'Quick chat · Opus 5.5' })
    await waitFor(() => expect(screen.getAllByText('Working').length).toBeGreaterThan(0))
    await cmd('w')
    const ask = await screen.findByRole('dialog', { name: 'Close a chat that is answering' })
    expect(ask).toHaveTextContent('Stop the chat? It is still answering.')
    expect(spawned.signals).toEqual([])
    fireEvent.click(within(ask).getByRole('button', { name: 'Stop and close' }))
    await waitFor(() => expect(spawned.signals).toEqual([['chat-1', 'end']]))
    expect(screen.queryByRole('tab', { name: /Quick chat/ })).toBeNull()
  })

  it('keeps a busy quick chat running when told to, and closes only its tab', async () => {
    spawned.health = 'working'
    // The close reads the session list: wait until it has the chat, answering.
    await startChat()
    await screen.findByRole('heading', { name: 'Quick chat · Opus 5.5' })
    await waitFor(() => expect(screen.getAllByText('Working').length).toBeGreaterThan(0))
    await cmd('w')
    const ask = await screen.findByRole('dialog', { name: 'Close a chat that is answering' })
    fireEvent.click(within(ask).getByRole('button', { name: 'Keep it running, close tab' }))
    await waitFor(() => expect(screen.queryByRole('tab', { name: /Quick chat/ })).toBeNull())
    expect(spawned.signals).toEqual([])
  })

  // Owner, 2026-10-20: a chat whose tab was closed from its project's menu
  // kept running with no tab, listed under "Running, no tab" for good.
  // Outside projects, where a chat's tab sits, closes its tabs by Hide. It
  // is there once the daemon keeps a project list (the chat is in none).
  async function closeOutsideTabs() {
    fireEvent.click(await screen.findByRole('button', { name: /^Hide Outside projects/ }))
  }

  const daemonProjects = () => fetchMock.mockImplementation(async (url: unknown) => String(url).endsWith('/v1/projects')
    ? new Response(JSON.stringify({ projects: [{ id: 1, name: 'app', root: '/w/app', kind: 'folder' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    : new Response('', { status: 404 }))

  it('ends an idle quick chat when its group’s tabs are closed in bulk, as ⌘W does', async () => {
    daemonProjects()
    await startChat()
    await screen.findByRole('heading', { name: 'Quick chat · Opus 5.5' })
    await closeOutsideTabs()
    await waitFor(() => expect(spawned.signals).toEqual([['chat-1', 'end']]))
    expect(screen.queryByRole('tab', { name: /Quick chat/ })).toBeNull()
  })

  it('asks once before a bulk close ends a quick chat still answering; Keep running leaves it be', async () => {
    daemonProjects()
    spawned.health = 'working'
    await startChat()
    await screen.findByRole('heading', { name: 'Quick chat · Opus 5.5' })
    await waitFor(() => expect(screen.getAllByText('Working').length).toBeGreaterThan(0))
    await closeOutsideTabs()
    const ask = await screen.findByRole('dialog', { name: 'Stop chats that are answering' })
    expect(ask).toHaveTextContent('Stop the chat? It is still answering.')
    expect(screen.queryByRole('tab', { name: /Quick chat/ })).toBeNull()
    fireEvent.click(within(ask).getByRole('button', { name: 'Keep running' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Stop chats that are answering' })).toBeNull())
    expect(spawned.signals).toEqual([])
  })

  it('stops a quick chat still answering when a bulk close is told to', async () => {
    daemonProjects()
    spawned.health = 'working'
    await startChat()
    await screen.findByRole('heading', { name: 'Quick chat · Opus 5.5' })
    await waitFor(() => expect(screen.getAllByText('Working').length).toBeGreaterThan(0))
    await closeOutsideTabs()
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Stop chats that are answering' })).getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(spawned.signals).toEqual([['chat-1', 'end']]))
  })

  // Owner, 2026-10-14 (translated): "I just want to switch between them
  // with key combos … not every tab shows the key combination". Tabs are
  // the navigation: ⌘N is the Nth tab in the order the tabs were opened, a
  // new tab goes last with the next number, only a close or a drag changes
  // the numbers, every tab shows its N (the one in front too) and so does
  // its sidebar row, in Flat and in Tree.
  const strip = () => screen.getAllByRole('tab').filter((t) => t.hasAttribute('data-tab-index'))
  const stripNames = () => strip().map((t) => t.getAttribute('aria-label'))
  const stripKeys = () => strip().map((t) => t.querySelector('[data-tab-key]')?.textContent)
  const rowKey = (title: string) => [...document.querySelectorAll('[data-tab-row]')].find((r) => r.textContent?.includes(title))?.querySelector('[data-row-key-digit]')?.textContent
  const frontPane = () => ['agent-1', 'agent-2'].filter((id) => screen.queryByTestId(`pane-${id}`)?.getAttribute('data-active') === 'true')
  const openRowOf = async (id: string, tab: RegExp) => {
    await waitFor(() => expect(document.querySelector(`[data-live-row="${id}"]`)).toBeTruthy())
    fireEvent.click(document.querySelector(`[data-live-row="${id}"]`)!)
    await screen.findByRole('tab', { name: tab })
  }

  it.each([['Tree', 'on'], ['Flat', 'off']])('numbers the tabs in the order opened, %s: every tab and its row show ⌘N, ⌘N opens it, ⌘9 the last', async (_, mode) => {
    localStorage.setItem('caprock.app.sidebar-grouped', mode!)
    render(<AppShell />)
    // Opened in this order, listed in this order — whatever the sidebar's own order.
    await openRowOf('agent-2', /Waiting one/)
    await openRowOf('agent-1', /Fix the login bug/)
    await waitFor(() => expect(stripNames()).toEqual(['Waiting one · app', 'Fix the login bug · app']))
    // Every tab carries its key, the one in front too, and its row the same.
    expect(stripKeys()).toEqual(['⌘1', '⌘2'])
    expect(strip().every((t) => !t.querySelector('[data-tab-key]')!.className.split(' ').includes('invisible'))).toBe(true)
    expect(rowKey('Waiting one')).toBe('⌘1')
    expect(rowKey('Fix the login bug')).toBe('⌘2')
    // The project is on the tab, short, after the session's name.
    expect(strip()[0]!.querySelector('[data-tab-project]')!.textContent).toBe('app')
    await cmd('1')
    expect(frontPane()).toEqual(['agent-2'])
    await cmd('2')
    expect(frontPane()).toEqual(['agent-1'])
    await cmd('9')
    expect(frontPane()).toEqual(['agent-1'])
    // Past the end, nothing moves.
    await cmd('5')
    expect(frontPane()).toEqual(['agent-1'])
  })

  it('puts a tab opened from another project last, as ⌘3; a close renumbers; the order survives a restart', async () => {
    localStorage.setItem('caprock.app.sidebar-grouped', 'off')
    // Closing an agent's tab without the question (lib/agentClose.ts).
    localStorage.setItem('caprock.app.agent-close', 'keep')
    const first = render(<AppShell />)
    await openRowOf('agent-1', /Fix the login bug/)
    await openRowOf('agent-2', /Waiting one/)
    await openRowOf('theirs', /Started elsewhere/)
    await waitFor(() => expect(stripNames()).toEqual(['Fix the login bug · app', 'Waiting one · app', 'Started elsewhere · other']))
    expect(stripKeys()).toEqual(['⌘1', '⌘2', '⌘3'])
    expect(rowKey('Started elsewhere')).toBe('⌘3')
    // The Flat list is the strip, in its order.
    const list = screen.getByRole('group', { name: 'Sessions' })
    expect([...list.querySelectorAll('[data-tab-row]')].map((r) => r.querySelector('[data-row-title]')?.textContent ?? r.textContent)).toEqual([
      expect.stringContaining('Fix the login bug'), expect.stringContaining('Waiting one'), expect.stringContaining('Started elsewhere'),
    ])
    await waitFor(() => expect(localStorage.getItem(WORKSPACE_KEY)).toContain('theirs'))
    first.unmount()
    render(<AppShell />)
    await waitFor(() => expect(stripNames()).toEqual(['Fix the login bug · app', 'Waiting one · app', 'Started elsewhere · other']))
    expect(stripKeys()).toEqual(['⌘1', '⌘2', '⌘3'])
    // Closing the first moves the others up one.
    fireEvent.click(within(strip()[0]!).getByRole('button', { name: /^Close/ }))
    await waitFor(() => expect(stripNames()).toEqual(['Waiting one · app', 'Started elsewhere · other']))
    expect(stripKeys()).toEqual(['⌘1', '⌘2'])
  })

  it('moves a tab in the strip when its row is moved in the Flat list, and the numbers follow', async () => {
    localStorage.setItem('caprock.app.sidebar-grouped', 'off')
    render(<AppShell />)
    await openRowOf('agent-1', /Fix the login bug/)
    await openRowOf('agent-2', /Waiting one/)
    await waitFor(() => expect(stripNames()).toEqual(['Fix the login bug · app', 'Waiting one · app']))
    const row = [...document.querySelectorAll<HTMLElement>('[data-tab-row]')].find((r) => r.textContent?.includes('Waiting one'))!
    fireEvent.keyDown(row, { key: 'ArrowUp', altKey: true, shiftKey: true })
    await waitFor(() => expect(stripNames()).toEqual(['Waiting one · app', 'Fix the login bug · app']))
    expect(stripKeys()).toEqual(['⌘1', '⌘2'])
    expect(rowKey('Waiting one')).toBe('⌘1')
  })

  it('lists Flat for a new viewer, Tree once chosen (Settings → Appearance or the Projects | Tabs switch), and a click on a project opens its page', async () => {
    localStorage.clear()
    render(<AppShell />)
    await screen.findByRole('heading', { name: 'Sessions' })
    expect(document.querySelector('[data-project-row]')).toBeNull()
    act(() => saveSidebarMode('tree'))
    await waitFor(() => expect(document.querySelector('[data-project-row]')).toBeTruthy())
    // No digit on a project, ever.
    expect(document.querySelector('[data-project-key]')).toBeNull()
    await openRowOf('agent-1', /Fix the login bug/)
    expect(frontPane()).toEqual(['agent-1'])
    const appRow = [...document.querySelectorAll<HTMLElement>('[data-project-row]')].find((b) => b.textContent?.startsWith('app'))!
    fireEvent.click(appRow)
    await waitFor(() => expect(frontPane()).toEqual([]))
    expect(screen.getByRole('tab', { name: /Fix the login bug/ })).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByRole('radio', { name: 'Projects' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('radio', { name: 'Tabs' }))
    await waitFor(() => expect(document.querySelector('[data-project-row]')).toBeNull())
    expect(localStorage.getItem('caprock.app.sidebar-grouped')).toBe('off')
    expect(screen.getByRole('radio', { name: 'Tabs' })).toHaveAttribute('aria-checked', 'true')
  })

  // A user, 2026-10-14 (translated): "a project folder with its worktrees
  // inside is more convenient". 0.116.0 had moved her to Flat unasked.
  it('keeps Tree for a viewer who used the app before and never chose, and writes it down', async () => {
    localStorage.clear()
    localStorage.setItem('caprock.app.workspace.v1', JSON.stringify({ version: 1, tabs: [], activeByProject: {}, activeProject: '' }))
    render(<AppShell />)
    await waitFor(() => expect(document.querySelector('[data-project-row]')).toBeTruthy())
    expect(localStorage.getItem('caprock.app.sidebar-grouped')).toBe('on')
  })

  // Owner, 2026-10-13 (translated): "… and there I can Command+Up/Down to
  // move". ⌥⌘↑ ⌥⌘↓ walk the sessions of the front tab's project and ⌥⌘←
  // ⌥⌘→ the projects, round the end, every terminal staying mounted.
  it('walks its sessions with ⌥⌘↑ ⌥⌘↓ and the projects with ⌥⌘← ⌥⌘→', async () => {
    await renderApp()
    await openFromPalette('Fix the login bug')
    fireEvent.click(waitingRow('Waiting one'))
    await screen.findAllByRole('tab')
    const arrow = (key: string, mods: Partial<KeyboardEventInit> = { metaKey: true, altKey: true }) =>
      act(() => { fireEvent.keyDown(window, { key, code: key, ...mods }) })
    const front = () => ['agent-1', 'agent-2'].filter((id) => screen.getByTestId(`pane-${id}`).getAttribute('data-active') === 'true')
    const currentProject = () => document.querySelector('[data-project-row][data-current]')?.textContent ?? ''
    expect(front()).toEqual(['agent-2'])
    await arrow('ArrowUp')
    expect(front()).toEqual(['agent-1'])
    await arrow('ArrowDown')
    expect(front()).toEqual(['agent-2'])
    // Round the end.
    await arrow('ArrowDown')
    expect(front()).toEqual(['agent-1'])
    // The other project, then back: the first brings its tab last in front.
    expect(currentProject()).toMatch(/^app/)
    await arrow('ArrowRight')
    expect(currentProject()).toMatch(/^other/)
    await arrow('ArrowRight')
    expect(currentProject()).toMatch(/^app/)
    expect(front()).toEqual(['agent-1'])
    await arrow('ArrowLeft')
    expect(currentProject()).toMatch(/^other/)
    await arrow('ArrowLeft')
    // ⌃⌘ digits are no project chords: nothing moves, the key is not taken.
    const ctrlDigit = new KeyboardEvent('keydown', { key: '2', code: 'Digit2', metaKey: true, ctrlKey: true, bubbles: true, cancelable: true })
    act(() => { window.dispatchEvent(ctrlDigit) })
    expect(ctrlDigit.defaultPrevented).toBe(false)
    expect(currentProject()).toMatch(/^app/)
    // ⌥← ⌥→ and ⌘↑ ⌘↓ are the terminal's: not taken, nothing moves.
    for (const [key, mods] of [['ArrowLeft', { altKey: true }], ['ArrowRight', { altKey: true }], ['ArrowUp', { metaKey: true }], ['ArrowDown', { metaKey: true }]] as const) {
      const ev = new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true, ...mods })
      act(() => { window.dispatchEvent(ev) })
      expect(ev.defaultPrevented, key).toBe(false)
    }
    expect(front()).toEqual(['agent-1'])
    // In a text field the chord selects there: the field keeps it.
    const field = document.createElement('input')
    document.body.append(field)
    field.focus()
    const inField = new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', metaKey: true, altKey: true, bubbles: true, cancelable: true })
    act(() => { field.dispatchEvent(inField) })
    expect(inField.defaultPrevented).toBe(false)
    expect(front()).toEqual(['agent-1'])
    field.remove()
  })

  it('says once how to move around, with a way to every key, and never again after Got it', async () => {
    const first = await renderApp()
    expect(screen.queryByRole('status', { name: 'Keys to move around' })).toBeNull()
    await openFromPalette('Fix the login bug')
    const hint = await screen.findByRole('status', { name: 'Keys to move around' })
    expect(hint).toHaveTextContent('⌘1–9 switch tabs in the order you opened them · double-click a tab to rename')
    fireEvent.click(within(hint).getByRole('button', { name: 'All keys' }))
    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toHaveTextContent('The Nth tab, in the order opened')
    expect(localStorage.getItem('caprock.app.keysHint')).toBe('seen')
    first.unmount()
    await renderApp()
    await screen.findByRole('tab', { name: /Fix the login bug/ })
    expect(screen.queryByRole('status', { name: 'Keys to move around' })).toBeNull()
  })

  // Owner, 2026-10-14, translated: "Send feedback should also open with a key combo".
  it('opens Send feedback on ⇧⌘F from anywhere, and lists the key among all keys', async () => {
    await renderApp()
    act(() => { fireEvent.keyDown(window, { key: 'F', code: 'KeyF', metaKey: true, shiftKey: true }) })
    const dialog = await screen.findByRole('dialog', { name: 'Feedback' })
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Feedback' })).toBeNull())
    await openFromPalette('Keyboard shortcuts')
    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toHaveTextContent('⇧⌘FSend feedback')
  })

  it('restores its tabs after a reload', async () => {
    const first = await renderApp()
    await openFromPalette('Fix the login bug')
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

  it('⌘J jumps to the session waiting on you', async () => {
    await renderApp()
    await cmd('j')
    expect(await screen.findByRole('tab', { name: /Waiting one/ })).toHaveAttribute('aria-selected', 'true')
  })

  it('⇧Enter in the palette opens a session beside the one in front, and ⌘W closes just that pane', async () => {
    localStorage.setItem('caprock.app.agent-close', 'keep')
    await renderApp()
    await openFromPalette('Fix the login bug')
    await screen.findByRole('tab')
    await cmd('k')
    const input = screen.getByRole('combobox', { name: 'Search' })
    fireEvent.change(input, { target: { value: 'waiting one' } })
    const options = screen.getAllByRole('option')
    // The waiting row first, then the same session under Sessions, which can split.
    expect(options[0]).toHaveTextContent('Waiting one')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    await waitFor(() => expect(screen.getByTestId('pane-agent-2')).toBeInTheDocument())
    expect(screen.getAllByRole('tab')).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: /Close pane/ })).toHaveLength(2)
    await cmd('w')
    expect(screen.queryByTestId('pane-agent-2')).not.toBeInTheDocument()
    expect(screen.getByTestId('pane-agent-1')).toBeInTheDocument()
    expect(screen.getAllByRole('tab')).toHaveLength(1)
  })

  // ADR-075: the in-app browser is the desktop app's, and off until Settings
  // turns it on; until then a link asked for in Caprock opens in the browser.
  it('sends a page to your browser while the in-app browser is off, and opens no tab', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    await renderApp()
    act(() => { window.dispatchEvent(new CustomEvent('caprock:open-browser', { detail: { url: 'https://example.com/' } })) })
    expect(open).toHaveBeenCalledWith('https://example.com/', '_blank', 'noopener')
    expect(screen.queryByRole('tab', { name: /^Browser · / })).toBeNull()
    act(() => { window.dispatchEvent(new CustomEvent('caprock:open-browser', { detail: {} })) })
    expect(await screen.findByText('Turn on the in-app browser in Settings first.')).toBeTruthy()
    expect(screen.queryByRole('tab', { name: /^Browser · / })).toBeNull()
  })

  // Owner, 2026-10-22: a dev server's address in a terminal, one click, and
  // the page is beside it as a phone shows it — with the in-app browser
  // setting never touched.
  describe('phone preview, in the desktop app', () => {
    const acts: { id: string; act: { do: string } }[] = []
    beforeEach(() => {
      acts.length = 0
      forgetDevServers()
      ;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
        invoke: async (c: string, args: { id: string; act: { do: string } }) => {
          if (c === 'browser_tab') { acts.push(args); return null }
          throw new Error(c)
        },
      }
    })
    afterEach(() => { delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ })

    it('opens the page split beside the terminal it was printed in, in Phone mode with Touch on, the setting left off', async () => {
      localStorage.setItem(PHONE_PREFS_KEY, JSON.stringify({ device: 'pixel9', touch: false }))
      await renderApp()
      await openFromPalette('Fix the login bug')
      await screen.findByRole('tab')
      act(() => { requestPhonePreview({ url: 'http://localhost:5173/', sessionId: 'agent-1' }) })
      const view = await waitFor(() => { const v = document.querySelector('[data-browser-view]'); expect(v).toBeTruthy(); return v as HTMLElement })
      // One tab, two panes: the agent's terminal and the page beside it.
      expect(screen.getAllByRole('tab')).toHaveLength(1)
      expect(screen.getByTestId('pane-agent-1')).toBeInTheDocument()
      expect(view.closest('[data-pane]')).toBeTruthy()
      expect(within(view).getByRole('button', { name: /Phone/ })).toHaveAttribute('aria-pressed', 'true')
      expect(view.querySelector('[data-phone-stage]')).toBeTruthy()
      // The device used last, now with Touch on.
      expect(within(view).getByRole('combobox', { name: /Device/i })).toHaveValue('pixel9')
      expect(JSON.parse(localStorage.getItem(PHONE_PREFS_KEY)!)).toMatchObject({ device: 'pixel9', touch: true })
      expect(localStorage.getItem('caprock.app.in-app-browser')).toBeNull()
      expect(within(view).queryByText(/The in-app browser is off/)).toBeNull()
      // The same address again brings it forward rather than opening it twice.
      act(() => { requestPhonePreview({ url: 'http://localhost:5173/', sessionId: 'agent-1' }) })
      expect(document.querySelectorAll('[data-browser-view]')).toHaveLength(1)
      // Its × closes the pane, not the agent's tab.
      fireEvent.click(within(view).getByRole('button', { name: 'Close the tab' }))
      await waitFor(() => expect(document.querySelector('[data-browser-view]')).toBeNull())
      expect(screen.getByTestId('pane-agent-1')).toBeInTheDocument()
      expect(screen.getAllByRole('tab')).toHaveLength(1)
    })

    it('⌘K → Preview on phone… lists the servers seen, then asks for an address', async () => {
      noteDevServer('http://localhost:3000/', 'agent-1', Date.now() - 120_000)
      noteDevServer('http://localhost:5173/', undefined, Date.now())
      await renderApp()
      await cmd('k')
      fireEvent.change(screen.getByRole('combobox', { name: 'Search' }), { target: { value: 'preview on phone' } })
      fireEvent.click(screen.getAllByRole('option').find((o) => o.textContent?.startsWith('Preview on phone…'))!)
      const sheet = await screen.findByRole('dialog', { name: 'Preview on phone' })
      const rows = within(sheet).getAllByRole('option').map((o) => o.textContent)
      expect(rows[0]).toContain('localhost:5173')
      expect(rows[1]).toContain('localhost:3000')
      expect(rows[1]).toContain('seen in Fix the login bug · 2 min ago')
      expect(rows[2]).toContain('Preview a URL on phone…')
      fireEvent.click(within(sheet).getAllByRole('option')[2]!)
      const ask = await screen.findByRole('dialog', { name: 'Preview a URL on phone' })
      expect(within(ask).getByText('Type the address of the page to see on a phone.')).toBeInTheDocument()
      fireEvent.change(within(ask).getByRole('combobox', { name: 'Search' }), { target: { value: 'localhost:8080' } })
      expect(within(ask).getByRole('option')).toHaveTextContent('Preview localhost:8080 on phone')
      fireEvent.keyDown(within(ask).getByRole('combobox', { name: 'Search' }), { key: 'Enter' })
      const view = await waitFor(() => { const v = document.querySelector('[data-browser-view]'); expect(v).toBeTruthy(); return v as HTMLElement })
      expect(within(view).getByRole('button', { name: /Phone/ })).toHaveAttribute('aria-pressed', 'true')
    })
  })

  it('offers no phone preview outside the desktop app', async () => {
    await renderApp()
    await cmd('k')
    fireEvent.change(screen.getByRole('combobox', { name: 'Search' }), { target: { value: 'preview on phone' } })
    expect(screen.queryAllByRole('option').some((o) => o.textContent?.startsWith('Preview on phone…'))).toBe(false)
  })

  it('text the palette cannot match starts an agent on it, in a worktree named after it', async () => {
    await renderApp()
    await cmd('k')
    const input = screen.getByRole('combobox', { name: 'Search' })
    fireEvent.change(input, { target: { value: 'Add dark mode toggle' } })
    expect(screen.getByRole('option')).toHaveTextContent('New agent on “Add dark mode toggle”')
    fireEvent.keyDown(input, { key: 'Enter' })
    const sheet = await screen.findByRole('dialog', { name: 'New agent' })
    expect(await within(sheet).findByDisplayValue('add-dark-mode-toggle')).toBeInTheDocument()
    expect(within(sheet).getByDisplayValue('Add dark mode toggle')).toBeInTheDocument()
  })
})

describe('workspace helpers', () => {
  it('names a worktree after a task', async () => {
    expect(worktreeSlug('Fix the login bug!')).toBe('fix-the-login-bug')
    expect(worktreeSlug('  ***  ')).toBe('')
    expect(worktreeSlug('one two three four five six seven eight').split('-')).toHaveLength(6)
  })

  it('cycles through what waits, from the one in front', async () => {
    const item = (id: string) => ({ session: sess({ session_id: id }), projectId: 'p', projectName: 'p', reason: 'waiting' as const, title: id, since: 0, stale: false })
    const inbox = [item('a'), item('b'), item('c')]
    expect(nextWaiting([], 'a')).toBeUndefined()
    expect(nextWaiting(inbox, 'x')?.title).toBe('a')
    expect(nextWaiting(inbox, 'a')?.title).toBe('b')
    expect(nextWaiting(inbox, 'c')?.title).toBe('a')
    // A turn put down long ago is not jumped to.
    expect(nextWaiting([{ ...item('old'), stale: true }, item('b')], 'b')?.title).toBe('b')
    expect(nextWaiting([{ ...item('old'), stale: true }])).toBeUndefined()
  })

  it('⌘F asks the focused pane to open its find bar, and the palette offers it', async () => {
    let heard = 0
    const on = () => { heard++ }
    window.addEventListener(FIND_EVENT, on)
    await renderApp()
    await openFromPalette('Fix the login bug')
    await screen.findByRole('tab')
    await cmd('f')
    expect(heard).toBe(1)
    await cmd('k')
    fireEvent.click(await screen.findByText('Find in the terminal'))
    await waitFor(() => expect(heard).toBe(2))
    window.removeEventListener(FIND_EVENT, on)
  })

  it('⌘F with Settings in front goes to its search, not to a terminal', async () => {
    let term = 0
    let settings = 0
    const onTerm = () => { term++ }
    const onSettings = () => { settings++ }
    window.addEventListener(FIND_EVENT, onTerm)
    window.addEventListener(SETTINGS_FIND_EVENT, onSettings)
    await renderApp()
    await cmd(',')
    await waitFor(() => expect(location.hash).toMatch(/^#\/settings/))
    await cmd('f')
    expect(settings).toBe(1)
    expect(term).toBe(0)
    window.removeEventListener(FIND_EVENT, onTerm)
    window.removeEventListener(SETTINGS_FIND_EVENT, onSettings)
  })

  it('opens a project in the default editor from its right-click menu and the palette', async () => {
    editorCalls.length = 0
    await renderApp()
    const row = document.querySelector('[data-project-row="dir:/w/app"], [data-project-row]') as HTMLElement
    await waitFor(() => {
      fireEvent.contextMenu(row)
      expect(screen.getByRole('menu')).toBeInTheDocument()
    })
    // The project menu: hide, close its tabs, the editors (the default first), remove.
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem').filter((b) => b.textContent?.startsWith('Open in'))
    expect(items.map((b) => b.textContent)).toEqual(['Open in Zeddefault', 'Open in VS Code'])
    fireEvent.click(items[1]!)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    await waitFor(() => expect(editorCalls).toHaveLength(1))
    expect(editorCalls[0]).toMatchObject({ editor: 'vscode' })
    expect(editorCalls[0]!.path).toMatch(/^\/w\//)
    await cmd('k')
    fireEvent.click(await screen.findByText('Open app in Zed'))
    await waitFor(() => expect(editorCalls).toHaveLength(2))
    expect(editorCalls[1]).toMatchObject({ path: '/w/app' })
  })
})
