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

beforeEach(() => localStorage.clear())

describe('the sidebar', () => {
  it('opens only the current project, listing its tabs as the strip names them, the tab in front the one highlighted row', () => {
    const pane = (id: string, kind: 'session' | 'shell', sessionId: string) => ({ type: 'pane' as const, id, target: { kind, sessionId } })
    const tabs: Tab[] = [
      { id: 't1', projectId: 'alpha', root: pane('p1', 'session', 'a1'), focusedPaneId: 'p1', title: 'Fix the login' },
      { id: 't2', projectId: 'beta', root: pane('p2', 'shell', 'b1'), focusedPaneId: 'p2', title: 'shell' },
      { id: 't3', projectId: 'alpha', root: pane('p3', 'shell', 'a2'), focusedPaneId: 'p3', title: 'shell' },
      { id: 't4', projectId: 'alpha', root: pane('p4', 'shell', 'a3'), focusedPaneId: 'p4', title: 'shell' },
    ]
    const labels = tabLabels(tabs, new Map(), new Set(), () => undefined)
    const onActivateTab = vi.fn()
    const { rerender, props } = renderSidebar({ tabs, tabLabels: labels, activeProjectId: 'alpha', activeTabId: 't3', dashboardActive: false, onActivateTab })
    const list = screen.getByRole('group', { name: 'alpha: open tabs' })
    expect([...list.querySelectorAll('[data-tab-row] span.flex-1')].map((b) => b.textContent)).toEqual(['Fix the login', 'Shell 1', 'Shell 2'])
    // One highlighted row, and no chevrons to manage.
    expect(document.querySelectorAll('[aria-current="true"]')).toHaveLength(1)
    expect(document.querySelector('[data-tab-row="t3"]')).toHaveAttribute('aria-current', 'true')
    expect(document.querySelector('[data-project-row="alpha"]')).toHaveAttribute('aria-expanded', 'true')
    expect(document.querySelector('[data-project-row="beta"]')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('group', { name: 'beta: open tabs' })).toBeNull()
    fireEvent.click(within(list).getByText('Fix the login'))
    expect(onActivateTab).toHaveBeenCalledWith('t1')
    fireEvent.click(document.querySelector('[data-project-row="beta"]')!)
    expect(props.onSelectProject).toHaveBeenCalledWith('beta')
    // Beta current: alpha folds, beta opens on its own tab list.
    rerender(<Sidebar {...props} activeProjectId="beta" activeTabId="t2" />)
    expect(screen.queryByRole('group', { name: 'alpha: open tabs' })).toBeNull()
    expect(within(screen.getByRole('group', { name: 'beta: open tabs' })).getByText('Shell 1')).toBeInTheDocument()
    // Nothing waits: no Waiting on you block at all.
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

  it('above eight projects, folds the ones not in play under More projects, closed until opened, and remembers it open', () => {
    const many = buildSidebar({
      projects: [proj('alpha', 1, true), proj('beta', 2, true), ...['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'].map((id) => proj(id, 30))],
      sessions: [],
      permissions: new Set(),
      costs: new Map(),
      openSessions: new Set(),
    })
    const rest = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']
    const first = renderSidebar({ model: many })
    expect(listed()).toEqual(['alpha', 'beta'])
    const fold = screen.getByRole('button', { name: /More projects · 7/ })
    expect(fold).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(fold)
    expect(listed()).toEqual(['alpha', 'beta', ...rest])
    expect(JSON.parse(localStorage.getItem(FOLDS_KEY)!)).toEqual(['more'])
    first.unmount()
    renderSidebar({ model: many })
    expect(listed()).toEqual(['alpha', 'beta', ...rest])
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
    const list = screen.getByRole('group', { name: 'alpha: open tabs' })
    expect([...list.querySelectorAll('[data-tab-row]')].map((b) => b.getAttribute('data-tab-row'))).toEqual(['t1'])
    // Agents first, the most recent first; the ended one is not listed.
    expect([...list.querySelectorAll('[data-live-row] span.flex-1')].map((b) => b.textContent)).toEqual(['Write the docs', 'Shell'])
    expect(within(list).queryByText('No tabs open.')).toBeNull()
    expect(document.querySelectorAll('[aria-current="true"]')).toHaveLength(1)
    fireEvent.click(list.querySelector('[data-live-row="a3"]')!)
    expect(onOpenLive).toHaveBeenCalledWith(sessions[2], 'alpha')
  })

  it('says no tabs are open only when nothing of the project runs', () => {
    renderSidebar({ activeProjectId: 'alpha', dashboardActive: false })
    expect(within(screen.getByRole('group', { name: 'alpha: open tabs' })).getByText('No tabs open.')).toBeInTheDocument()
  })

  it('closes a project into Hidden with its × and shows it again from there, across a reload', () => {
    const first = renderSidebar()
    fireEvent.click(screen.getByRole('button', { name: 'Close project beta' }))
    expect(listed()).toEqual(['alpha', 'stale'])
    expect(JSON.parse(localStorage.getItem(HIDDEN_KEY)!)).toEqual(['beta'])
    first.unmount()

    renderSidebar()
    expect(listed()).toEqual(['alpha', 'stale'])
    const hidden = screen.getByRole('region', { name: 'Hidden' })
    fireEvent.click(within(hidden).getByRole('button', { name: /Hidden · 1/ }))
    fireEvent.click(within(hidden).getByRole('button', { name: 'Show beta in the list again' }))
    expect(listed()).toEqual(['alpha', 'beta', 'stale'])
    expect(screen.queryByRole('region', { name: 'Hidden' })).not.toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem(HIDDEN_KEY)!)).toEqual([])
  })

  it('keeps the project in front listed even when hidden', () => {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(['beta']))
    renderSidebar({ activeProjectId: 'beta', dashboardActive: false })
    expect(listed()).toEqual(['alpha', 'beta', 'stale'])
    expect(screen.getByRole('button', { name: 'Show beta in the list again' })).toBeInTheDocument()
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
    expect(items.map((b) => b.textContent)).toEqual(['Hide from the sidebarunder Hidden', 'Close its tabnone open', 'Remove from Caprock…files stay'])
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
    expect(JSON.parse(localStorage.getItem(HIDDEN_KEY)!)).toEqual(['alpha'])
    // From Hidden, the same menu shows it again.
    fireEvent.click(screen.getByRole('button', { name: /Hidden · 1/ }))
    fireEvent.contextMenu(document.querySelector('[data-project-row="alpha"]')!)
    fireEvent.click(screen.getByRole('menuitem', { name: /Show in the sidebar again/ }))
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
    expect(onRoute).toHaveBeenLastCalledWith('#/now')
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

  it('shows no Waiting on you block when only turns put down more than 12h ago wait, and folds them under a current one', () => {
    const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()
    const waiting = (id: string, msAgo: number) => ({
      session_id: id, cwd: '/w/alpha', project: 'alpha', model: '', started_at: 1, last_event_at: 1, status: 'active', git_branch: '', owned: true,
      title: id, activity: { phrase: '', at: iso(msAgo), health: 'waiting-on-you' },
    }) as unknown as SessionSummary
    const build = (sessions: SessionSummary[]) => buildSidebar({ projects: [proj('alpha', 1, true)], sessions, permissions: new Set(), costs: new Map(), openSessions: new Set() })
    const { rerender, props } = renderSidebar({ model: build([waiting('old1', 2 * day), waiting('old2', day)]) })
    expect(screen.queryByRole('region', { name: 'Waiting on you' })).toBeNull()
    expect(screen.queryByText(/Older, put down/)).toBeNull()
    rerender(<Sidebar {...props} model={build([waiting('old1', 2 * day), waiting('now1', 60_000)])} />)
    const block = screen.getByRole('region', { name: 'Waiting on you' })
    expect(within(block).getByText('now1')).toBeInTheDocument()
    expect(within(block).getByText(/Older, put down more than 12h ago \(1\)/)).toBeInTheDocument()
  })
})
