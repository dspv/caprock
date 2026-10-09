/**
 * Closing things in the sidebar, with one sign (owner, 2026-10-09: "unclear
 * how to close projects on the left, or their parts", translated): a tab
 * row's ×, a project's ×, ■ on what Caprock started with no tab, the
 * right-click menus, and keys that must close nothing. Also what each row
 * says about its state, sessions from other terminals behind one line, and
 * an order that a status change never moves.
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
import { tabLabels } from '@/lib/tablabels'
import type { Tab } from '@/lib/tabs'
import { HIDDEN_KEY, Sidebar, type SidebarProps } from './Sidebar'

const proj = (id: string): Project => ({ id, root: `/w/${id}`, name: id, kind: 'folder', last_activity: Date.now(), pinned: true })
const live = (p: Partial<SessionSummary>) => ({
  session_id: 's', cwd: '/w/alpha', project: 'alpha', model: '', started_at: 1, last_event_at: 1, status: 'active',
  git_branch: '', owned: true, activity: { phrase: '', at: '', health: 'working' }, ...p,
}) as SessionSummary
const pane = (id: string, kind: 'session' | 'shell' | 'file', sessionId: string, path?: string) =>
  ({ type: 'pane' as const, id, target: { kind, sessionId, path } })

function setup(sessions: SessionSummary[], tabs: Tab[], extra: Partial<SidebarProps> = {}) {
  const open = new Set(tabs.map((t) => (t.root.type === 'pane' ? t.root.target.sessionId : '')))
  const model = buildSidebar({ projects: [proj('alpha'), proj('beta')], sessions, permissions: new Set(), costs: new Map(), openSessions: open })
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

  it('opens a tab menu on a right-click: Close tab, and Stop… only for what Caprock started', async () => {
    const { props } = setup(
      [live({ session_id: 'a1', title: 'Fix the login' }), live({ session_id: 'x1', title: 'Theirs', owned: false })],
      [agentTab, { id: 't9', projectId: 'alpha', root: pane('p9', 'session', 'x1'), focusedPaneId: 'p9', title: 'Theirs' }, fileTab],
    )
    fireEvent.contextMenu(tabRow('t9'), { clientX: 10, clientY: 10 })
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['Close tab⌘W'])
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    fireEvent.contextMenu(tabRow('t3'))
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['Close tab⌘W'])
    fireEvent.click(screen.getByRole('menuitem', { name: /Close tab/ }))
    expect(props.onCloseTab).toHaveBeenCalledWith('t3')
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.contextMenu(tabRow('t1'))
    expect(within(screen.getByRole('menu', { name: 'Fix the login: tab actions' })).getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['Close tab⌘W', 'Stop the session…'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Stop the session…' }))
    // The cockpit's confirmation, nothing stopped yet.
    const confirm = screen.getByRole('alertdialog', { name: 'Confirm stop' })
    expect(confirm).toHaveTextContent('Stop this session? Its process ends; the conversation is kept and can be continued.')
    expect(signal).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(within(confirm).getByRole('button', { name: 'Stop session' })) })
    expect(signal).toHaveBeenCalledWith('a1', 'kill')
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('offers ■ on what Caprock started with no tab, after the same confirmation; what other terminals started sits behind one line', () => {
    const sessions = [
      live({ session_id: 'a1', title: 'Fix the login' }),
      live({ session_id: 'sh2', kind: 'shell', started_at: 2 }),
      live({ session_id: 'x1', title: 'Context recovery', owned: false, started_at: 3 }),
      live({ session_id: 'x2', title: 'Elsewhere', owned: false, started_at: 4 }),
    ]
    const { props } = setup(sessions, [agentTab])
    const list = screen.getByRole('group', { name: 'alpha: open tabs' })
    expect([...list.querySelectorAll('[data-live-row]')].map((r) => r.getAttribute('data-live-row'))).toEqual(['sh2'])
    expect(within(list).queryByText('Context recovery')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Stop the shell…' }))
    const confirm = screen.getByRole('alertdialog', { name: 'Confirm stop' })
    expect(confirm).toHaveTextContent('Stop this shell? Its process ends; the shell is kept.')
    fireEvent.click(within(confirm).getByRole('button', { name: 'Keep it' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(signal).not.toHaveBeenCalled()

    const others = within(list).getByRole('button', { name: /Running in other terminals · 2/ })
    expect(others).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(others)
    expect([...list.querySelectorAll('[data-live-row]')].map((r) => r.getAttribute('data-live-row'))).toEqual(['sh2', 'x1', 'x2'])
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
})
