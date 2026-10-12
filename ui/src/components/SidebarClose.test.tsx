/**
 * Closing things in the sidebar, with one sign (owner, 2026-10-09: "unclear
 * how to close projects on the left, or their parts", translated): a tab
 * row's ×, a project's ×, ■ on what Caprock started with no tab, the
 * right-click menus, and keys that must close nothing. Also what each row
 * says about its state, sessions from other terminals behind one line, and
 * an order that a status change never moves. Every row under a project can
 * be closed or hidden, and hidden rows come back (owner, 2026-10-11).
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@/lib/projects'
import type { SessionSummary } from '@/lib/api'

const signal = vi.fn(async () => undefined)
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, signal: (...a: unknown[]) => (signal as (...x: unknown[]) => Promise<void>)(...a) } }
})

import { buildSidebar } from '@/lib/sidebar'
import { branchLabel } from '@/lib/sessionLabels'
import { tabLabels } from '@/lib/tablabels'
import type { Tab } from '@/lib/tabs'
import { HIDDEN_KEY, HIDDEN_SESSIONS_KEY, Sidebar, type SidebarProps } from './Sidebar'
import { MORE_KEY } from './ProjectRow'

// These read the labels in their macOS spelling; lib/appkeys.test.ts covers
// Windows and Linux.
Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })

const proj = (id: string): Project => ({ id, root: `/w/${id}`, name: id, kind: 'folder', last_activity: Date.now(), pinned: true })
const live = (p: Partial<SessionSummary>) => ({
  session_id: 's', cwd: '/w/alpha', project: 'alpha', model: '', started_at: 1, last_event_at: 1, status: 'active',
  git_branch: '', owned: true, activity: { phrase: '', at: '', health: 'working' }, ...p,
}) as SessionSummary
const pane = (id: string, kind: 'session' | 'shell' | 'file', sessionId: string, path?: string) =>
  ({ type: 'pane' as const, id, target: { kind, sessionId, path } })

function setup(sessions: SessionSummary[], tabs: Tab[], extra: Partial<SidebarProps> = {}, permissions: ReadonlySet<string> = new Set()) {
  const open = new Set(tabs.map((t) => (t.root.type === 'pane' ? t.root.target.sessionId : '')))
  const model = buildSidebar({ projects: [proj('alpha'), proj('beta')], sessions, permissions, costs: new Map(), openSessions: open })
  const byId = new Map(sessions.map((s) => [s.session_id, s]))
  const props: SidebarProps = {
    model,
    source: 'api',
    activeProjectId: 'alpha',
    dashboardActive: false,
    tabs,
    tabLabels: tabLabels(tabs, byId, new Set(), () => undefined),
    activeTabId: tabs[0]?.id,
    onActivateTab: vi.fn(),
    onCloseTab: vi.fn(),
    onCloseProjectTabs: vi.fn(),
    onOpenLive: vi.fn(),
    onSelectProject: vi.fn(),
    onOpenInbox: vi.fn(),
    onNewAgent: vi.fn(),
    onNewShell: vi.fn(),
    onAddProject: vi.fn(),
    onDashboard: vi.fn(),
    onPalette: vi.fn(),
    ...extra,
  }
  return { ...render(<Sidebar {...props} />), props }
}

const agentTab: Tab = { id: 't1', projectId: 'alpha', root: pane('p1', 'session', 'a1'), focusedPaneId: 'p1', title: 'Fix the login' }
const shellTab: Tab = { id: 't2', projectId: 'alpha', root: pane('p2', 'shell', 'sh1'), focusedPaneId: 'p2', title: 'shell' }
const fileTab: Tab = { id: 't3', projectId: 'alpha', root: pane('p3', 'file', 'f1', 'src/app.ts'), focusedPaneId: 'p3', title: 'app.ts' }
const tabRow = (id: string) => document.querySelector(`[data-tab-row="${id}"]`) as HTMLElement

beforeEach(() => {
  localStorage.clear()
  // These are about each row's actions, so every row is out: alpha's
  // "+N more" open. The one row and the fold are tested at the end.
  localStorage.setItem(MORE_KEY, JSON.stringify(['alpha']))
  signal.mockClear()
})

describe('closing in the sidebar', () => {
  it("gives every tab row a × that closes the tab as the strip does, shown always on the tab in front, and says a shell's closes the shell", () => {
    const { props } = setup([live({ session_id: 'a1', title: 'Fix the login' }), live({ session_id: 'sh1', kind: 'shell' })], [agentTab, shellTab, fileTab])
    const agentX = screen.getByRole('button', { name: 'Close tab Fix the login' })
    expect(agentX).toHaveAttribute('title', 'Close tab (⌘W) — the agent keeps running')
    // On the tab in front always; on the others, on hover or focus.
    expect(agentX.parentElement!.className).toMatch(/^absolute .* flex$/)
    const shellX = screen.getByRole('button', { name: 'Close shell Shell 1' })
    expect(shellX).toHaveAttribute('title', 'Close shell (⌘W)')
    expect(shellX.parentElement!.className).toContain('hidden group-hover/row:flex')
    // No hover on a touch screen: the buttons are always there.
    expect(shellX.parentElement!.className).toContain('pointer-coarse:flex')
    expect(screen.getByRole('button', { name: 'Close tab app.ts' })).toHaveAttribute('title', 'Close tab (⌘W)')
    fireEvent.click(shellX)
    expect(props.onCloseTab).toHaveBeenCalledWith('t2')
    expect(props.onActivateTab).not.toHaveBeenCalled()
  })

  it('closes nothing on Delete or Backspace', () => {
    const { props } = setup([live({ session_id: 'a1' })], [agentTab])
    const row = tabRow('t1')
    row.focus()
    fireEvent.keyDown(row, { key: 'Delete' })
    fireEvent.keyDown(row, { key: 'Backspace' })
    fireEvent.keyDown(document.querySelector('[data-project-row="alpha"]')!, { key: 'Delete' })
    expect(props.onCloseTab).not.toHaveBeenCalled()
    expect(props.onCloseProjectTabs).not.toHaveBeenCalled()
    expect(localStorage.getItem(HIDDEN_KEY)).toBeNull()
  })

  it('opens a tab menu on a right-click: Close tab, Close and hide for an agent, and Stop… only for what Caprock started', async () => {
    const { props } = setup(
      [live({ session_id: 'a1', title: 'Fix the login' }), live({ session_id: 'x1', title: 'Theirs', owned: false })],
      [agentTab, { id: 't9', projectId: 'alpha', root: pane('p9', 'session', 'x1'), focusedPaneId: 'p9', title: 'Theirs' }, fileTab],
    )
    fireEvent.contextMenu(tabRow('t9'), { clientX: 10, clientY: 10 })
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['Close tab⌘W', 'Close tab and hide from the list'])
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    fireEvent.contextMenu(tabRow('t3'))
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['Close tab⌘W'])
    fireEvent.click(screen.getByRole('menuitem', { name: /Close tab/ }))
    expect(props.onCloseTab).toHaveBeenCalledWith('t3')
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.contextMenu(tabRow('t1'))
    expect(within(screen.getByRole('menu', { name: 'Fix the login: tab actions' })).getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['Close tab⌘W', 'Close tab and hide from the list', 'Stop the session…'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Stop the session…' }))
    // The cockpit's confirmation, nothing stopped yet.
    const confirm = screen.getByRole('alertdialog', { name: 'Confirm stop' })
    expect(confirm).toHaveTextContent('Stop this session? Its process ends; the conversation is kept and can be continued.')
    expect(signal).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(within(confirm).getByRole('button', { name: 'Stop session' })) })
    expect(signal).toHaveBeenCalledWith('a1', 'kill')
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('offers ■ on what Caprock started with no tab, after the same confirmation; what other terminals started comes last, with nothing to stop', () => {
    const sessions = [
      live({ session_id: 'a1', title: 'Fix the login' }),
      live({ session_id: 'sh2', kind: 'shell', started_at: 2 }),
      live({ session_id: 'x1', title: 'Context recovery', owned: false, started_at: 3 }),
      live({ session_id: 'x2', title: 'Elsewhere', owned: false, started_at: 4 }),
    ]
    const { props } = setup(sessions, [agentTab])
    const list = screen.getByRole('group', { name: 'alpha: open tabs' })
    expect([...list.querySelectorAll('[data-live-row]')].map((r) => r.getAttribute('data-live-row'))).toEqual(['sh2', 'x1', 'x2'])
    fireEvent.click(screen.getByRole('button', { name: 'Stop the shell…' }))
    const confirm = screen.getByRole('alertdialog', { name: 'Confirm stop' })
    expect(confirm).toHaveTextContent('Stop this shell? Its process ends; the shell is kept.')
    fireEvent.click(within(confirm).getByRole('button', { name: 'Keep it' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(signal).not.toHaveBeenCalled()

    // Rule 7: nothing to stop on a session Caprock did not start.
    expect(screen.getAllByRole('button', { name: /^Stop the/ })).toHaveLength(1)
    fireEvent.click(list.querySelector('[data-live-row="x1"]')!)
    expect(props.onOpenLive).toHaveBeenCalledWith(sessions[2], 'alpha')
  })

  it('closes a project with its ×: tabs close and it hides, the front moving to the next tab', () => {
    const betaTab: Tab = { id: 'tb', projectId: 'beta', root: pane('pb', 'shell', 'b1'), focusedPaneId: 'pb', title: 'shell' }
    const { props } = setup([], [agentTab, betaTab])
    const x = screen.getByRole('button', { name: 'Close project alpha' })
    expect(x.getAttribute('title')).toContain('moves under Hidden')
    fireEvent.click(x)
    expect(props.onCloseProjectTabs).toHaveBeenCalledWith('alpha')
    expect(JSON.parse(localStorage.getItem(HIDDEN_KEY)!)).toEqual(['alpha'])
    expect(props.onActivateTab).toHaveBeenCalledWith('tb')
  })

  it('ends the project\'s shells before closing it: Cancel closes nothing, stopped shells no longer keep it listed', async () => {
    const outcomes = [{ cancelled: true, stopped: 0 }, { cancelled: false, stopped: 0 }, { cancelled: false, stopped: 1 }]
    const onStopProjectShells = vi.fn(async () => outcomes.shift()!)
    const { props } = setup([live({ session_id: 'sh1', kind: 'shell' })], [shellTab], { onStopProjectShells })
    const x = screen.getByRole('button', { name: 'Close project alpha' })
    expect(x.getAttribute('title')).toBe('Close project: its tabs and shells close and it moves under Hidden. A shell running a program asks first.')
    // Cancelled at the question: no tab closes.
    await act(async () => { fireEvent.click(x) })
    expect(onStopProjectShells).toHaveBeenCalledWith('alpha')
    expect(props.onCloseProjectTabs).not.toHaveBeenCalled()
    // The busy shell kept running: the tabs close, the project stays listed.
    await act(async () => { fireEvent.click(x) })
    expect(props.onCloseProjectTabs).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(HIDDEN_KEY)).toBeNull()
    // The shell stopped: nothing runs there any more, so it hides.
    await act(async () => { fireEvent.click(x) })
    expect(props.onCloseProjectTabs).toHaveBeenCalledTimes(2)
    expect(JSON.parse(localStorage.getItem(HIDDEN_KEY)!)).toEqual(['alpha'])
  })

  it('keeps a project with live work listed: its × only closes the tabs', () => {
    const { props } = setup([live({ session_id: 'a1' })], [agentTab])
    const x = screen.getByRole('button', { name: 'Close project alpha' })
    expect(x.getAttribute('title')).toContain('Its agents keep running, so it stays in the list (1 running)')
    fireEvent.click(x)
    expect(props.onCloseProjectTabs).toHaveBeenCalledWith('alpha')
    expect(localStorage.getItem(HIDDEN_KEY)).toBeNull()
    expect(props.onActivateTab).not.toHaveBeenCalled()
    expect(props.onSelectProject).not.toHaveBeenCalled()
  })

  it('says each row\'s state in one word, a shell none, and never reorders rows when a state changes', () => {
    const sessions = [
      live({ session_id: 'a1', title: 'Fix the login' }),
      live({ session_id: 'a2', title: 'Write the docs', started_at: 2, activity: { phrase: '', at: '', health: 'waiting-on-you' } }),
      live({ session_id: 'a3', title: 'Older one', started_at: 3, activity: { phrase: '', at: '', health: 'idle' } }),
      live({ session_id: 'sh1', kind: 'shell' }),
    ]
    const { rerender, props } = setup(sessions, [agentTab, shellTab])
    const words = () => [...document.querySelectorAll('[data-tab-row], [data-live-row]')].map((r) => [
      r.querySelector('[data-row-title]')!.textContent,
      r.querySelector('[data-state]')?.textContent ?? '',
    ])
    expect(words()).toEqual([['Fix the login', 'working'], ['Shell 1', ''], ['Write the docs', 'waiting'], ['Older one', 'idle']])
    // The waiting one is the amber one.
    expect(document.querySelector('[data-state="waiting"]')!.className).toContain('text-accent')
    expect(document.querySelectorAll('.text-accent[data-state]')).toHaveLength(1)
    // A state flips and a newer session starts: rows keep their places, the new one lands last.
    const next = [
      { ...sessions[0]!, activity: { phrase: '', at: '', health: 'idle' } },
      { ...sessions[1]!, activity: { phrase: '', at: '', health: 'working' }, last_event_at: 99 },
      sessions[2]!,
      sessions[3]!,
      live({ session_id: 'a4', title: 'Brand new', started_at: 9 }),
    ] as SessionSummary[]
    const model = buildSidebar({ projects: [proj('alpha'), proj('beta')], sessions: next, permissions: new Set(), costs: new Map(), openSessions: new Set(['a1', 'sh1']) })
    rerender(<Sidebar {...props} model={model} tabLabels={tabLabels([agentTab, shellTab], new Map(next.map((s) => [s.session_id, s])), new Set(), () => undefined)} />)
    expect(words()).toEqual([['Fix the login', 'idle'], ['Shell 1', ''], ['Write the docs', 'working'], ['Older one', 'idle'], ['Brand new', 'working']])
  })

  it('names what a shell runs, on its tab row and on a running shell with no tab', () => {
    setup(
      [live({ session_id: 'sh1', kind: 'shell', program: 'claude' }), live({ session_id: 'sh2', kind: 'shell', program: 'npm', started_at: 2 })],
      [shellTab],
    )
    expect(tabRow('t2').querySelector('[data-row-title]')!.textContent).toBe('Shell 1 · claude')
    expect(document.querySelector('[data-live-row="sh2"] [data-row-title]')!.textContent).toBe('Shell · npm')
    expect(screen.getByRole('button', { name: 'Stop the shell…' })).toBeInTheDocument()
  })

  it('lets the title win over a long branch: the branch shrinks first, both are in the tooltip', () => {
    const branch = 'feature/an-extremely-long-branch-name-for-the-login-rework'
    setup([live({ session_id: 'x1', title: 'Context recovery', owned: false, git_branch: branch })], [])
    const row = document.querySelector('[data-live-row="x1"]')!
    const title = row.querySelector('[data-row-title]')!
    const tail = row.querySelector('[data-row-branch]')!
    expect(title.textContent).toBe('Context recovery')
    // Sized to its text and never shrunk while the branch has width; the
    // branch takes what is left and truncates to nothing first. (jsdom has no
    // layout, so the classes that make it so are what can be checked.)
    expect(title.className).toMatch(/\bshrink-0\b/)
    expect(title.className).toMatch(/\bmax-w-full\b/)
    expect(title.className).not.toMatch(/\bflex-1\b/)
    expect(tail.className).toMatch(/\bmin-w-0\b/)
    expect(tail.className).toMatch(/\btruncate\b/)
    expect(row.getAttribute('title')).toContain(`Context recovery · ${branchLabel(branch)}`)
  })

  it('hides a row with no tab from its ×, signalling nothing, and brings it back from "N hidden · show"', () => {
    const sessions = [
      live({ session_id: 'a2', title: 'Write the docs', started_at: 2 }),
      live({ session_id: 'x1', title: 'Context recovery', owned: false, started_at: 3 }),
    ]
    setup(sessions, [agentTab])
    const list = screen.getByRole('group', { name: 'alpha: open tabs' })
    const hide = screen.getByRole('button', { name: 'Hide Write the docs from the list' })
    expect(hide.getAttribute('title')).toContain('it keeps running')
    expect(hide.parentElement!.className).toContain('pointer-coarse:flex')
    fireEvent.click(hide)
    expect(list.querySelector('[data-live-row="a2"]')).toBeNull()
    expect(Object.keys(JSON.parse(localStorage.getItem(HIDDEN_SESSIONS_KEY)!))).toEqual(['a2'])
    expect(signal).not.toHaveBeenCalled()

    // One from another terminal: × hides it too, and it has nothing to stop (rule 7).
    expect(screen.queryByRole('button', { name: 'Stop the session…' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Hide Context recovery from the list' }))
    expect(list.querySelector('[data-live-row="x1"]')).toBeNull()
    // Nothing left to fold: no "+N more" line.
    expect(list.querySelector('[data-more-rows]')).toBeNull()
    expect(signal).not.toHaveBeenCalled()

    const more = within(list).getByRole('button', { name: /2 hidden · show/ })
    expect(more).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(more)
    expect([...list.querySelectorAll('[data-hidden-row]')].map((r) => r.getAttribute('data-live-row'))).toEqual(['a2', 'x1'])
    fireEvent.click(screen.getByRole('button', { name: 'Show Write the docs in the list again' }))
    expect(list.querySelector('[data-live-row="a2"]')).not.toHaveAttribute('data-hidden-row')
    expect(within(list).getByRole('button', { name: /1 hidden · hide again/ })).toBeInTheDocument()
    expect(Object.keys(JSON.parse(localStorage.getItem(HIDDEN_SESSIONS_KEY)!))).toEqual(['x1'])
  })

  it('offers the same from the keyboard: Shift+F10 on a row with no tab opens Open, Hide, Stop…', () => {
    setup([live({ session_id: 'a2', title: 'Write the docs' }), live({ session_id: 'x1', title: 'Theirs', owned: false, started_at: 3 })], [])
    const row = document.querySelector('[data-live-row="a2"]') as HTMLElement
    fireEvent.keyDown(row, { key: 'F10', shiftKey: true })
    expect(within(screen.getByRole('menu', { name: 'Write the docs: actions' })).getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['Open as a tab', 'Hide from the list', 'Stop the session…'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide from the list' }))
    expect(document.querySelector('[data-live-row="a2"]')).toBeNull()
    fireEvent.contextMenu(document.querySelector('[data-live-row="x1"]')!)
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['Open its details', 'Hide from the list'])
  })

  it("closes a tab and hides its agent from the tab's menu, so it does not come back as a muted row", () => {
    const { props } = setup([live({ session_id: 'a1', title: 'Fix the login' })], [agentTab])
    fireEvent.contextMenu(tabRow('t1'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close tab and hide from the list' }))
    expect(props.onCloseTab).toHaveBeenCalledWith('t1')
    expect(Object.keys(JSON.parse(localStorage.getItem(HIDDEN_SESSIONS_KEY)!))).toEqual(['a1'])
    expect(signal).not.toHaveBeenCalled()
  })

  it('marks what waits on you on its row, a session from another terminal included, and never hides one that asks', () => {
    const recent = new Date(Date.now() - 60_000).toISOString()
    const sessions = [
      live({ session_id: 'x1', title: 'Theirs waiting', owned: false, started_at: 3, activity: { phrase: '', at: recent, health: 'waiting-on-you' } }),
      live({ session_id: 'x2', title: 'Theirs asking', owned: false, started_at: 4 }),
      live({ session_id: 'x3', title: 'Theirs busy', owned: false, started_at: 5 }),
    ]
    // Hidden before either started waiting.
    localStorage.setItem(HIDDEN_SESSIONS_KEY, JSON.stringify({ x2: Date.now() - 1000, x1: Date.now() - 10 * 60_000 }))
    setup(sessions, [], {}, new Set(['x2']))
    const list = screen.getByRole('group', { name: 'alpha: open tabs' })
    // The one that asks leads; the other waiting one is under "+N more", which says so.
    expect([...list.querySelectorAll('[data-live-row][data-waiting]')].map((r) => r.getAttribute('data-live-row'))).toEqual(['x2', 'x1'])
    expect(list.querySelector('[data-more-rows]')!.textContent).toBe('+2 more · 1 waiting›')
    expect(list.querySelector('[data-live-row="x2"] [data-state]')!.textContent).toBe('asks')
    expect(list.querySelector('[data-live-row="x1"] [data-state]')!.textContent).toBe('waiting')
  })

  it('keeps a row hidden while what it waits on is older than the hiding', () => {
    const old = new Date(Date.now() - 60 * 60_000).toISOString()
    localStorage.setItem(HIDDEN_SESSIONS_KEY, JSON.stringify({ x1: Date.now() - 1000 }))
    setup([live({ session_id: 'x1', title: 'Theirs waiting', owned: false, activity: { phrase: '', at: old, health: 'waiting-on-you' } })], [])
    expect(document.querySelector('[data-live-row="x1"]')).toBeNull()
    expect(screen.getByRole('button', { name: /1 hidden · show/ })).toBeInTheDocument()
  })
})
