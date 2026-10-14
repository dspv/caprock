/**
 * The sidebar's primary actions and the folded groups: New agent and Add
 * project at the top, quiet projects folded at the bottom, and a project
 * hidden by hand moving to Hidden and back, remembered across a reload.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@/lib/projects'
import type { SessionSummary, Summary } from '@/lib/api'
import { buildSidebar } from '@/lib/sidebar'
import { tabLabels } from '@/lib/tablabels'
import type { Tab } from '@/lib/tabs'
import { FOLDS_KEY, HIDDEN_KEY, Sidebar, type SidebarProps } from './Sidebar'
import { pipelineLabel, foldedKeys, splitModeRow } from './SidebarFooter'

const day = 24 * 60 * 60 * 1000
const proj = (id: string, lastDaysAgo: number, pinned = false): Project =>
  ({ id, root: `/w/${id}`, name: id, kind: 'folder', last_activity: Date.now() - lastDaysAgo * day, pinned })

// Pinned keeps alpha and beta in the list with nothing running in them.
const model = buildSidebar({
  projects: [proj('alpha', 1, true), proj('beta', 2, true), proj('stale', 30)],
  sessions: [],
  permissions: new Set(),
  costs: new Map(),
  openSessions: new Set(),
})

function renderSidebar(extra: Partial<SidebarProps> = {}) {
  const props: SidebarProps = {
    model,
    source: 'api',
    activeProjectId: '',
    dashboardActive: true,
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

const listed = () => [...document.querySelectorAll('[data-project-row]')].map((b) => b.getAttribute('data-project-row'))
/** The rows in the list above the folds. */
const top = () => [...document.querySelectorAll('.app-scroll > ul [data-project-row]')].map((b) => b.getAttribute('data-project-row'))

/** The project ids hidden by hand, as stored (id → when). */
const hiddenIds = () => Object.keys(JSON.parse(localStorage.getItem(HIDDEN_KEY)!) as Record<string, number>)

beforeEach(() => { localStorage.clear(); sessionStorage.clear() })

describe('the sidebar', () => {
  it('lists every agent session under its project and no shells, the tab in front the one highlighted row', () => {
    const pane = (id: string, kind: 'session' | 'shell', sessionId: string) => ({ type: 'pane' as const, id, target: { kind, sessionId } })
    const tabs: Tab[] = [
      { id: 't1', projectId: 'alpha', root: pane('p1', 'session', 'a1'), focusedPaneId: 'p1', title: 'Fix the login' },
      { id: 't2', projectId: 'beta', root: pane('p2', 'shell', 'b1'), focusedPaneId: 'p2', title: 'shell' },
      { id: 't3', projectId: 'alpha', root: pane('p3', 'shell', 'a2'), focusedPaneId: 'p3', title: 'shell' },
      { id: 't5', projectId: 'alpha', root: pane('p5', 'session', 'a5'), focusedPaneId: 'p5', title: 'Write the docs' },
    ]
    const labels = tabLabels(tabs, new Map(), new Set(), () => undefined)
    const onActivateTab = vi.fn()
    const { rerender, props } = renderSidebar({ tabs, tabLabels: labels, activeProjectId: 'alpha', activeTabId: 't5', dashboardActive: false, onActivateTab })
    const list = screen.getByRole('group', { name: 'alpha: sessions' })
    const titles = () => [...list.querySelectorAll('[data-tab-row] [data-row-title]')].map((b) => b.textContent)
    // Every agent session, in its fixed place; no shell, no "+N more".
    expect(titles()).toEqual(['Fix the login', 'Write the docs'])
    expect(document.querySelector('[data-more-rows]')).toBeNull()
    // One highlighted row.
    expect(document.querySelectorAll('[aria-current="true"]')).toHaveLength(1)
    expect(document.querySelector('[data-tab-row="t5"]')).toHaveAttribute('aria-current', 'true')
    expect(document.querySelector('[data-project-row="alpha"]')).toHaveAttribute('aria-expanded', 'true')
    // Beta has only a shell: its row alone.
    expect(screen.queryByRole('group', { name: 'beta: sessions' })).toBeNull()
    fireEvent.click(within(list).getByText('Fix the login'))
    expect(onActivateTab).toHaveBeenCalledWith('t1')
    fireEvent.click(document.querySelector('[data-project-row="beta"]')!)
    expect(props.onSelectProject).toHaveBeenCalledWith('beta')
    // Beta current: alpha's sessions stay listed, nothing moves.
    rerender(<Sidebar {...props} activeProjectId="beta" activeTabId="t2" />)
    expect(titles()).toEqual(['Fix the login', 'Write the docs'])
    expect(document.querySelectorAll('[aria-current="true"]')).toHaveLength(0)
    // No Waiting on you block: what waits is marked on its own row.
    expect(screen.queryByRole('region', { name: 'Waiting on you' })).toBeNull()
  })

  it('leads with New agent and Add project', () => {
    const { props } = renderSidebar({ activeProjectId: 'beta' })
    fireEvent.click(screen.getByRole('button', { name: 'New agent' }))
    expect(props.onNewAgent).toHaveBeenCalledWith('beta')
    fireEvent.click(screen.getByRole('button', { name: 'Add project' }))
    expect(props.onAddProject).toHaveBeenCalled()
  })

  it('lists every project while there are eight or fewer, and never reorders on a click', () => {
    const { props, rerender } = renderSidebar({ activeProjectId: 'alpha', dashboardActive: false })
    expect(listed()).toEqual(['alpha', 'beta', 'stale'])
    expect(screen.queryByRole('button', { name: /More projects/ })).toBeNull()
    fireEvent.click(document.querySelector('[data-project-row="stale"]')!)
    rerender(<Sidebar {...props} activeProjectId="stale" />)
    expect(listed()).toEqual(['alpha', 'beta', 'stale'])
  })

  it('above eight projects, keeps the ones not in play behind one More…, which opens them as a list', () => {
    const many = buildSidebar({
      projects: [proj('alpha', 1, true), proj('beta', 2, true), ...['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'].map((id) => proj(id, 30))],
      sessions: [],
      permissions: new Set(),
      costs: new Map(),
      openSessions: new Set(),
    })
    const { props } = renderSidebar({ model: many })
    expect(listed()).toEqual(['alpha', 'beta'])
    expect(screen.queryByRole('button', { name: /More projects/ })).toBeNull()
    const more = document.querySelector('[data-sidebar-more]') as HTMLElement
    expect(more.textContent).toBe('More…')
    expect(more.getAttribute('title')).toBe('7 more projects')
    fireEvent.click(more)
    const menu = screen.getByRole('menu', { name: 'More projects and hidden rows' })
    expect(within(menu).getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'].map((id) => `${id}open`))
    fireEvent.click(within(menu).getByRole('menuitem', { name: /^p3/ }))
    expect(props.onSelectProject).toHaveBeenCalledWith('p3')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('lists, after the current project\'s tabs, what of it still runs with no tab, muted; a click opens it', () => {
    const live = (p: Partial<SessionSummary>) => ({
      session_id: 's', cwd: '/w/alpha', project: 'alpha', model: '', started_at: 0, last_event_at: 1, status: 'active',
      git_branch: '', owned: true, activity: { phrase: '', at: '', health: 'working' }, ...p,
    }) as SessionSummary
    const sessions = [
      live({ session_id: 'a1', title: 'Fix the login' }),
      live({ session_id: 'a2', title: 'Write the docs', last_event_at: 5 }),
      live({ session_id: 'a3', kind: 'shell' }),
      live({ session_id: 'a4', title: 'Done long ago', status: 'ended' }),
    ]
    const withLive = buildSidebar({
      projects: [proj('alpha', 1, true), proj('beta', 2, true)],
      sessions,
      permissions: new Set(),
      costs: new Map(),
      openSessions: new Set(['a1']),
    })
    const tabs: Tab[] = [{ id: 't1', projectId: 'alpha', root: { type: 'pane', id: 'p1', target: { kind: 'session', sessionId: 'a1' } }, focusedPaneId: 'p1', title: 'Fix the login' }]
    const onOpenLive = vi.fn()
    renderSidebar({ model: withLive, tabs, tabLabels: tabLabels(tabs, new Map(), new Set(), () => undefined), activeProjectId: 'alpha', activeTabId: 't1', dashboardActive: false, onOpenLive })
    const list = screen.getByRole('group', { name: 'alpha: sessions' })
    // All of it works: nothing is folded.
    expect(list.querySelector('[data-more-rows]')).toBeNull()
    expect([...list.querySelectorAll('[data-tab-row]')].map((b) => b.getAttribute('data-tab-row'))).toEqual(['t1'])
    // The agent with no tab; not the shell, not the ended one.
    expect([...list.querySelectorAll('[data-live-row] [data-row-title]')].map((b) => b.textContent)).toEqual(['Write the docs'])
    expect(within(list).queryByText('No tabs open.')).toBeNull()
    expect(document.querySelectorAll('[aria-current="true"]')).toHaveLength(1)
    fireEvent.click(list.querySelector('[data-live-row="a2"]')!)
    expect(onOpenLive).toHaveBeenCalledWith(sessions[1], 'alpha')
  })

  it('draws no list under a project with no agent session, and no filler line', () => {
    renderSidebar({ activeProjectId: 'alpha', dashboardActive: false })
    expect(screen.queryByRole('group', { name: 'alpha: sessions' })).toBeNull()
    expect(screen.queryByText('No tabs open.')).toBeNull()
  })

  it('closes a project with its × into More… and shows it again from there, across a reload', () => {
    const first = renderSidebar()
    fireEvent.click(screen.getByRole('button', { name: 'Close project beta' }))
    expect(listed()).toEqual(['alpha', 'stale'])
    expect(hiddenIds()).toEqual(['beta'])
    first.unmount()

    renderSidebar()
    expect(listed()).toEqual(['alpha', 'stale'])
    fireEvent.click(document.querySelector('[data-sidebar-more]')!)
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /^beta/ }))
    expect(listed()).toEqual(['alpha', 'beta', 'stale'])
    expect(document.querySelector('[data-sidebar-more]')).toBeNull()
    expect(hiddenIds()).toEqual([])
  })

  it('hides the project in front: it stays listed, last, until it is shown again from its own row', () => {
    renderSidebar({ activeProjectId: 'beta', dashboardActive: false })
    fireEvent.click(screen.getByRole('button', { name: /^Hide beta/ }))
    expect(hiddenIds()).toEqual(['beta'])
    expect(top()).toEqual(['alpha', 'stale', 'beta'])
    expect(document.querySelector('[data-project-row="beta"]')).toHaveAttribute('data-current')
    // Not in More… while it is in front: it is on screen already.
    expect(document.querySelector('[data-sidebar-more]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show beta in the list again' }))
    expect(listed()).toEqual(['alpha', 'beta', 'stale'])
  })

  // The owner's bug on 0.112.0 (2026-10-13): Hide did nothing on a project
  // whose agent had finished its turn. Every path wrote the id; the project
  // stayed where it was.
  it('hides a project whose agent finished its turn, from its eye, its ⋯ menu and a right-click, Outside projects too', () => {
    const ended = new Date(Date.now() - 60_000).toISOString()
    const s = (id: string, cwd: string) => ({
      session_id: id, cwd, project: 'p', model: '', started_at: 0, last_event_at: 0, status: 'active', transcript_path: '',
      has_hooks: true, has_transcript: true, git_branch: 'main', version: '', owned: false,
      stats: { session_id: id, turns: 1, tool_calls: 0, files_touched: 0, tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, cost_usd: 0 },
      activity: { phrase: '', at: ended, health: 'waiting-on-you' },
      savings: { billed_with: 0, billed_without: 0, saved: 0, hit_rate: 0, cut_pct: 0 },
    }) as unknown as SessionSummary
    const waiting = buildSidebar({
      projects: [proj('alpha', 1, true), proj('beta', 2, true), proj('stale', 30)],
      sessions: [s('a1', '/w/alpha'), s('b1', '/w/beta'), s('s1', '/w/stale'), s('o1', '/elsewhere')],
      permissions: new Set(),
      costs: new Map(),
      openSessions: new Set(),
    })
    expect(waiting.projects.every((n) => n.waiting === 1)).toBe(true)
    renderSidebar({ model: waiting })
    expect(top()).toEqual(['alpha', 'beta', 'stale', 'other-folders'])
    fireEvent.click(screen.getByRole('button', { name: /^Hide alpha/ }))
    expect(top()).toEqual(['beta', 'stale', 'other-folders'])
    fireEvent.click(screen.getByRole('button', { name: /More for beta/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Hide from the sidebar/ }))
    expect(top()).toEqual(['stale', 'other-folders'])
    fireEvent.contextMenu(document.querySelector('[data-project-row="stale"]')!)
    fireEvent.click(screen.getByRole('menuitem', { name: /Hide from the sidebar/ }))
    expect(top()).toEqual(['other-folders'])
    fireEvent.click(screen.getByRole('button', { name: /^Hide Outside projects/ }))
    expect(top()).toEqual([])
    expect(document.querySelector('[data-sidebar-more]')!.getAttribute('title')).toBe('4 hidden')
  })

  it('reads the older list of hidden ids', () => {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(['beta']))
    renderSidebar()
    expect(listed()).toEqual(['alpha', 'stale'])
  })

  it('survives unreadable storage', () => {
    localStorage.setItem(HIDDEN_KEY, '{not json')
    localStorage.setItem(FOLDS_KEY, '"quiet"')
    renderSidebar()
    expect(listed()).toEqual(['alpha', 'beta', 'stale'])
  })

  it('opens the project menu from its ⋯, from a right-click and from Shift+F10, and closes on Esc with focus back', async () => {
    renderSidebar({ activeProjectId: 'beta', dashboardActive: false, onRemoveProject: vi.fn() })
    const more = screen.getByRole('button', { name: /More for beta/ })
    fireEvent.click(more)
    const menu = screen.getByRole('menu', { name: 'beta: project actions' })
    const items = within(menu).getAllByRole('menuitem')
    expect(items.map((b) => b.textContent)).toEqual(['Hide from the sidebarunder More…', 'Close its tabnone open', 'Remove from Caprock…files stay'])
    // Nothing open: the close item says so and cannot be picked.
    expect(items[1]).toBeDisabled()
    expect(document.activeElement).toBe(items[0])
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[2])
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[0])
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(more))

    const row = document.querySelector('[data-project-row="alpha"]') as HTMLElement
    fireEvent.contextMenu(row, { clientX: 40, clientY: 60 })
    expect(screen.getByRole('menu', { name: 'alpha: project actions' })).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Tab' })
    expect(screen.queryByRole('menu')).toBeNull()
    row.focus()
    fireEvent.keyDown(row, { key: 'F10', shiftKey: true })
    expect(screen.getByRole('menu', { name: 'alpha: project actions' })).toBeInTheDocument()
  })

  it('hides a project and closes its tabs from the menu', () => {
    const onCloseProjectTabs = vi.fn()
    renderSidebar({ tabCounts: new Map([['alpha', 3]]), onCloseProjectTabs })
    fireEvent.contextMenu(document.querySelector('[data-project-row="alpha"]')!)
    fireEvent.click(screen.getByRole('menuitem', { name: /Close its 3 tabs/ }))
    expect(onCloseProjectTabs).toHaveBeenCalledWith('alpha')
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.contextMenu(document.querySelector('[data-project-row="alpha"]')!)
    fireEvent.click(screen.getByRole('menuitem', { name: /Hide from the sidebar/ }))
    expect(listed()).toEqual(['beta', 'stale'])
    expect(hiddenIds()).toEqual(['alpha'])
    // More… shows it again.
    fireEvent.click(document.querySelector('[data-sidebar-more]')!)
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /^alpha/ }))
    expect(listed()).toEqual(['alpha', 'beta', 'stale'])
  })

  it('opens the folder in an editor, the default first', () => {
    const onOpenInEditor = vi.fn()
    renderSidebar({ editors: { editors: [{ id: 'vscode', name: 'VS Code' }, { id: 'zed', name: 'Zed' }], preferred: 'zed' } as SidebarProps['editors'], onOpenInEditor })
    fireEvent.contextMenu(document.querySelector('[data-project-row="beta"]')!)
    const open = screen.getAllByRole('menuitem').filter((b) => b.textContent!.startsWith('Open in'))
    expect(open.map((b) => b.textContent)).toEqual(['Open in Zeddefault', 'Open in VS Code'])
    fireEvent.click(open[1]!)
    expect(onOpenInEditor).toHaveBeenCalledWith('/w/beta', 'beta', 'vscode')
  })

  it('removes a project from Caprock only after a confirmation, and says why it could not', async () => {
    const onRemoveProject = vi.fn().mockRejectedValueOnce(new Error('daemon away')).mockResolvedValueOnce(undefined)
    renderSidebar({ onRemoveProject })
    fireEvent.contextMenu(document.querySelector('[data-project-row="beta"]')!)
    fireEvent.click(screen.getByRole('menuitem', { name: /Remove from Caprock/ }))
    expect(onRemoveProject).not.toHaveBeenCalled()
    const confirm = screen.getByRole('group', { name: 'Remove beta from Caprock' })
    expect(confirm).toHaveTextContent('Its folder and files stay where they are')
    // Cancel is the safe default, and takes focus.
    expect(document.activeElement).toHaveTextContent('Cancel')
    await act(async () => { fireEvent.click(within(confirm).getByRole('button', { name: 'Remove' })) })
    expect(onRemoveProject).toHaveBeenCalledWith('beta')
    expect(screen.getByRole('alert')).toHaveTextContent('Could not remove beta: daemon away')
    await act(async () => { fireEvent.click(within(confirm).getByRole('button', { name: 'Remove' })) })
    expect(onRemoveProject).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('shows on a row only what runs and what waits: no branch, no changes, no spend', () => {
    const live = (id: string, cwd: string, health: 'working' | 'idle') => ({
      session_id: id, cwd, project: '', model: '', started_at: 0, last_event_at: Date.now(), status: 'active', owned: true,
      activity: { phrase: '', at: '', health },
    }) as unknown as SessionSummary
    const m = buildSidebar({
      projects: [proj('alpha', 1), proj('beta', 2, true)],
      sessions: [live('a1', '/w/alpha', 'working'), live('a2', '/w/alpha', 'idle')],
      permissions: new Set(),
      costs: new Map([['/w/alpha', 3.5]]),
      openSessions: new Set(),
    })
    renderSidebar({ model: m })
    const alpha = document.querySelector('[data-project-row="alpha"]') as HTMLElement
    const beta = document.querySelector('[data-project-row="beta"]') as HTMLElement
    expect(within(alpha).getByLabelText('2 running')).toHaveTextContent('2')
    expect(within(alpha).queryByLabelText(/today/)).toBeNull()
    expect(within(beta).queryByLabelText(/running/)).toBeNull()
  })

  it('leads with the Today strip, each figure a way in', () => {
    const onRoute = vi.fn()
    const summary = { cost_usd: 48.2, rate_limits: { five_hour: { used_percentage: 62, resets_at: Date.now() / 1000 + 3600 } } } as unknown as Summary
    const { props } = renderSidebar({ onRoute, summary, loaded: true })
    const today = screen.getByRole('region', { name: 'Today' })
    fireEvent.click(within(today).getByRole('button', { name: /Spent today, every agent: \$48\.20/ }))
    expect(onRoute).toHaveBeenLastCalledWith('#/cost')
    fireEvent.click(within(today).getByRole('button', { name: /Claude 5-hour window: 62% used/ }))
    expect(onRoute).toHaveBeenLastCalledWith('#/cost?section=limits')
    fireEvent.click(within(today).getByRole('button', { name: /0 agents running/ }))
    expect(onRoute).toHaveBeenLastCalledWith('#/home')
    // Nothing waits: the cell is a figure, not a button that does nothing.
    expect(within(today).getByRole('button', { name: 'Nothing is waiting on you' })).toBeDisabled()
    expect(props.onOpenInbox).not.toHaveBeenCalled()
    // No weekly window reported: no weekly bar, rather than an empty one.
    expect(within(today).queryByRole('meter', { name: 'Weekly window used' })).toBeNull()
  })

  it('shows a dash for spend until the summary answers', () => {
    renderSidebar({ onRoute: vi.fn(), loaded: false })
    const today = screen.getByRole('region', { name: 'Today' })
    expect(within(today).getByRole('button', { name: /not known yet/ })).toHaveTextContent('—')
    expect(within(today).queryByRole('meter')).toBeNull()
  })

  it('has no Waiting on you block: a session waiting now is marked on its own row, one put down more than 12h ago is not', () => {
    const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()
    const waiting = (id: string, msAgo: number, started: number) => ({
      session_id: id, cwd: '/w/alpha', project: 'alpha', model: '', started_at: started, last_event_at: 1, status: 'active', git_branch: '', owned: true,
      title: id, activity: { phrase: '', at: iso(msAgo), health: 'waiting-on-you' },
    }) as unknown as SessionSummary
    const m = buildSidebar({ projects: [proj('alpha', 1, true)], sessions: [waiting('old1', 2 * day, 1), waiting('now1', 60_000, 2)], permissions: new Set(), costs: new Map(), openSessions: new Set() })
    renderSidebar({ model: m })
    expect(screen.queryByRole('region', { name: 'Waiting on you' })).toBeNull()
    expect(screen.queryByText(/Older, put down/)).toBeNull()
    // Both are listed; only the one waiting now is marked.
    expect(document.querySelector('[data-live-row="now1"]')).toHaveAttribute('data-waiting', 'true')
    expect(document.querySelector('[data-live-row="old1"]')).not.toHaveAttribute('data-waiting')
    // The project row still counts only what waits now.
    expect(screen.getByLabelText('1 waiting on you')).toBeInTheDocument()
  })

  it('keeps what waits under a project folded by hand, and nothing else', () => {
    const iso = new Date(Date.now() - 60_000).toISOString()
    const s = (id: string, health: string, started: number) => ({
      session_id: id, cwd: '/w/alpha', project: 'alpha', model: '', started_at: started, last_event_at: 1, status: 'active', git_branch: '', owned: true,
      title: id, activity: { phrase: '', at: iso, health },
    }) as unknown as SessionSummary
    const m = buildSidebar({ projects: [proj('alpha', 1, true)], sessions: [s('busy', 'working', 1), s('asking', 'waiting-on-you', 2)], permissions: new Set(), costs: new Map(), openSessions: new Set() })
    renderSidebar({ model: m })
    fireEvent.click(screen.getByRole('button', { name: 'Fold alpha' }))
    expect(document.querySelector('[data-project-row="alpha"]')).toHaveAttribute('aria-expanded', 'false')
    expect([...document.querySelectorAll('[data-live-row]')].map((r) => r.getAttribute('data-live-row'))).toEqual(['asking'])
  })

  it('draws a project’s last hour, offers a new agent at rest, and folds a working project by hand', () => {
    const live = { session_id: 'a1', cwd: '/w/alpha', project: 'alpha', model: '', started_at: 1, last_event_at: Date.now(), status: 'active', git_branch: '', owned: true, title: 'Fix the login', activity: { phrase: '', at: '', health: 'working' } } as unknown as SessionSummary
    const ended = { ...live, session_id: 'a0', status: 'ended', title: 'old' } as unknown as SessionSummary
    const m = buildSidebar({
      projects: [proj('alpha', 1, true)], sessions: [live, ended], permissions: new Set(), costs: new Map(), openSessions: new Set(),
      activity: { a1: [0, 2, 3], a0: [1, 0, 0] },
    })
    expect(m.projects.find((n) => n.project.id === 'alpha')?.activity).toEqual([1, 2, 3])
    const { props } = renderSidebar({ model: m })
    expect(document.querySelector('[data-project-spark]')).not.toBeNull()
    fireEvent.click(document.querySelector('[data-project-new]')!)
    expect(props.onNewAgent).toHaveBeenCalledWith('alpha')
    const row = () => document.querySelector('[data-project-row="alpha"]')!
    expect(row().getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Fold alpha' }))
    expect(row().getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'Unfold alpha' }))
    expect(row().getAttribute('aria-expanded')).toBe('true')
  })

  it('counts the projects in the heading, and hides Outside projects like any project', () => {
    const stray = { session_id: 'x1', cwd: '/elsewhere', project: 'elsewhere', model: '', started_at: 1, last_event_at: Date.now(), status: 'active', git_branch: '', owned: true, title: 'stray' } as unknown as SessionSummary
    const live = { ...stray, session_id: 'a1', cwd: '/w/alpha', project: 'alpha', title: 'work' } as unknown as SessionSummary
    const m = buildSidebar({ projects: [proj('alpha', 1, true), proj('beta', 2, true)], sessions: [stray, live], permissions: new Set(), costs: new Map(), openSessions: new Set() })
    renderSidebar({ model: m })
    expect(screen.getByTitle('2 projects, 1 with something running').textContent).toBe('1 of 2')
    expect(listed()).toContain('other-folders')
    fireEvent.click(screen.getByRole('button', { name: /^Hide Outside projects/ }))
    expect(listed()).not.toContain('other-folders')
  })

  it('folds the bottom block to a row of icons and back, remembered across a reload', () => {
    const onSettings = vi.fn()
    const first = renderSidebar({ onSettings })
    expect(screen.getByText('Dashboard')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse to icons' }))
    expect(screen.queryByText('Dashboard')).toBeNull()
    expect(JSON.parse(localStorage.getItem(FOLDS_KEY)!)).toContain('footer')
    fireEvent.click(screen.getByRole('button', { name: /^Settings/ }))
    expect(onSettings).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /^Dashboard/ }))
    expect(first.props.onDashboard).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Send feedback' })).toBeTruthy()
    first.unmount()

    renderSidebar({ onSettings })
    expect(screen.queryByText('Dashboard')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }))
    expect(screen.getByText('Dashboard')).toBeTruthy()
  })

  // Owner, 2026-10-14, translated: "move them onto a separate row and split
  // it into two parts — two buttons in one row, neat, so it's clear what's there".
  it('gives Dashboard its own row and puts Pipeline and the theme under it as two named halves', () => {
    const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
    try {
      localStorage.removeItem(FOLDS_KEY)
      const onPipeline = vi.fn()
      renderSidebar({ onSettings: vi.fn(), onPipeline })
      const dash = screen.getByRole('button', { name: /^Dashboard/ })
      expect(dash.textContent).toBe('Dashboard⌘0')
      expect(dash.parentElement!.hasAttribute('data-sidebar-footer')).toBe(true)
      const row = document.querySelector('[data-mode-row]') as HTMLElement
      expect(row).toHaveClass('grid-cols-2')
      const bar = within(row).getByRole('button', { name: /^Pipeline: every pull request/ })
      const theme = within(row).getByRole('button', { name: /^Theme:/ })
      // The words over the chip: the key is in the tooltip (pipelineLabel).
      expect(bar.textContent).toBe('Pipeline')
      expect(bar.querySelector('kbd')).toBeNull()
      expect(theme.textContent).toMatch(/^(Dark|Light|Book)/)
      for (const b of [dash, bar, theme]) expect(b).toHaveClass('h-[32px]')
      // The theme on the right, so its picker stays inside the sidebar.
      expect(row.lastElementChild!.contains(theme)).toBe(true)
      fireEvent.click(bar)
      expect(onPipeline).toHaveBeenCalledTimes(1)
    } finally { platform.mockRestore() }
  })

  it('stacks Pipeline and the theme off macOS, where Ctrl+Alt+Shift+B fills a half', () => {
    const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32')
    try {
      localStorage.removeItem(FOLDS_KEY)
      renderSidebar({ onPipeline: vi.fn() })
      const row = document.querySelector('[data-mode-row]') as HTMLElement
      expect(row).not.toHaveClass('grid-cols-2')
      expect(within(row).getByRole('button', { name: /^Pipeline: every pull request/ }).textContent).toBe('PipelineCtrl+Alt+Shift+B')
    } finally { platform.mockRestore() }
    expect(splitModeRow(true)).toBe(true)
    expect(splitModeRow(false)).toBe(false)
  })

  // Owner, 2026-10-14, translated: "I'd put the key combos above them, and
  // the icons can be one size bigger".
  it('draws each folded icon’s key above it on a Mac, the theme’s slot empty', () => {
    const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
    try {
      localStorage.setItem(FOLDS_KEY, JSON.stringify(['footer']))
      renderSidebar({ onSettings: vi.fn(), onMail: vi.fn(), onPipeline: vi.fn() })
      const footer = document.querySelector('[data-sidebar-footer]')!
      expect(footer.getAttribute('data-folded-keys')).toBe('shown')
      const chips = [...footer.querySelectorAll('[data-key-slot] > kbd')]
      expect(chips.map((k) => k.textContent)).toEqual(['⇧⌘F', '⇧⌘M', '⌘0', '⌘,', '⇧⌘B', '·'])
      expect(chips[5]).toHaveClass('invisible')
      for (const b of footer.querySelectorAll('[data-key-slot] button')) expect(b).toHaveClass('h-[32px]')
      expect(footer.querySelector('[data-key-slot] svg')!.getAttribute('width')).toBe('18')
    } finally { platform.mockRestore() }
  })

  it('spells the folded keys for Windows and Linux and shows them on hover there', () => {
    const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Linux x86_64')
    try {
      localStorage.setItem(FOLDS_KEY, JSON.stringify(['footer']))
      renderSidebar({ onSettings: vi.fn(), onMail: vi.fn(), onPipeline: vi.fn() })
      const footer = document.querySelector('[data-sidebar-footer]')!
      expect(footer.getAttribute('data-folded-keys')).toBe('hover')
      const chips = [...footer.querySelectorAll('[data-key-slot] > kbd')]
      expect(chips.map((k) => k.textContent)).toEqual(['Ctrl+Alt+Shift+F', 'Ctrl+Shift+M', 'Ctrl+Shift+0', 'Ctrl+Shift+,', 'Ctrl+Alt+Shift+B'])
      for (const k of chips) expect(k).toHaveClass('invisible', 'group-hover:visible', 'group-focus-within:visible')
    } finally { platform.mockRestore() }
    expect(foldedKeys(true)).toBe('shown')
    expect(foldedKeys(false)).toBe('hover')
  })

  it('shows the Pipeline button folded too, marked while the page is in front, and none when the shell offers no Pipeline', () => {
    localStorage.setItem(FOLDS_KEY, JSON.stringify(['footer']))
    const first = renderSidebar({ onPipeline: vi.fn(), pipelineActive: true })
    expect(document.querySelector('[data-pipeline-button]')).toHaveAttribute('aria-current', 'true')
    first.unmount()
    localStorage.removeItem(FOLDS_KEY)
    renderSidebar()
    expect(document.querySelector('[data-pipeline-button]')).toBeNull()
  })

  it('names the Pipeline button’s key as each OS spells it', () => {
    expect(pipelineLabel(false, true)).toBe('Pipeline: every pull request on its way — open, CI, merged, released — in a tab (⇧⌘B)')
    expect(pipelineLabel(true, false)).toBe('Pipeline is in front — click to go back to the tab before it (Ctrl+Alt+Shift+B)')
  })

  // Owner, 2026-10-14 (translated): "put it on the main screen as a button —
  // in the left bottom too — and it opens another system tab with its own key combo".
  it('has a Mail row with its key that opens Mail, marked while Mail is in front, and an icon when folded', () => {
    localStorage.removeItem(FOLDS_KEY)
    const onMail = vi.fn()
    const first = renderSidebar({ onMail, mailActive: true, dashboardActive: true })
    const mail = screen.getByRole('button', { name: /^Mail/ })
    expect(mail.textContent).toMatch(/(⇧⌘M|Ctrl\+Shift\+M)$/)
    expect(mail.getAttribute('aria-current')).toBe('true')
    // Mail in front is not the Dashboard in front.
    expect(screen.getByRole('button', { name: /^Dashboard/ }).getAttribute('aria-current')).toBeNull()
    fireEvent.click(mail)
    expect(onMail).toHaveBeenCalledTimes(1)
    first.unmount()

    localStorage.setItem(FOLDS_KEY, JSON.stringify(['footer']))
    const folded = renderSidebar({ onMail })
    fireEvent.click(screen.getByRole('button', { name: /^Mail \((⇧⌘M|Ctrl\+Shift\+M)\)$/ }))
    expect(onMail).toHaveBeenCalledTimes(2)
    folded.unmount()

    localStorage.removeItem(FOLDS_KEY)
    renderSidebar()
    expect(screen.queryByRole('button', { name: /^Mail/ })).toBeNull()
  })

  it('shows Send feedback’s key on its row', () => {
    localStorage.removeItem(FOLDS_KEY)
    renderSidebar()
    expect(screen.getByRole('button', { name: 'Send feedback' }).textContent).toMatch(/(⇧⌘F|Ctrl\+Alt\+Shift\+F)$/)
  })

  it('lands on the phone or Telegram from the Settings row\'s own words', () => {
    localStorage.removeItem(FOLDS_KEY)
    const onSettings = vi.fn()
    const onSettingsSection = vi.fn()
    renderSidebar({ onSettings, onSettingsSection })
    fireEvent.click(screen.getByRole('button', { name: 'phone' }))
    expect(onSettingsSection).toHaveBeenLastCalledWith('phone')
    fireEvent.click(screen.getByRole('button', { name: 'Telegram' }))
    expect(onSettingsSection).toHaveBeenLastCalledWith('telegram')
    // The row itself, while it names them, goes to the phone too.
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(onSettingsSection).toHaveBeenCalledTimes(3)
    expect(onSettingsSection).toHaveBeenLastCalledWith('phone')
    expect(onSettings).not.toHaveBeenCalled()
  })
})
