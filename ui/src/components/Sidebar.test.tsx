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
import { FOLDS_KEY, HIDDEN_KEY, Sidebar, type SidebarProps } from './Sidebar'

const day = 24 * 60 * 60 * 1000
const proj = (id: string, lastDaysAgo: number): Project =>
  ({ id, root: `/w/${id}`, name: id, kind: 'folder', last_activity: Date.now() - lastDaysAgo * day })

const model = buildSidebar({
  projects: [proj('alpha', 1), proj('beta', 2), proj('stale', 30)],
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
    onOpenSession: vi.fn(),
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
  it('leads with New agent and Add project', () => {
    const { props } = renderSidebar({ activeProjectId: 'beta' })
    fireEvent.click(screen.getByRole('button', { name: 'New agent' }))
    expect(props.onNewAgent).toHaveBeenCalledWith('beta')
    fireEvent.click(screen.getByRole('button', { name: 'Add project' }))
    expect(props.onAddProject).toHaveBeenCalled()
  })

  it('folds a project quiet for a week under Quiet, closed until opened, and remembers it open', () => {
    const first = renderSidebar()
    expect(listed()).toEqual(['alpha', 'beta'])
    const fold = screen.getByRole('button', { name: /Quiet · 1/ })
    expect(fold).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(fold)
    expect(listed()).toEqual(['alpha', 'beta', 'stale'])
    expect(JSON.parse(localStorage.getItem(FOLDS_KEY)!)).toEqual(['quiet'])
    first.unmount()
    renderSidebar()
    expect(listed()).toEqual(['alpha', 'beta', 'stale'])
  })

  it('hides a project into Hidden and shows it again from there, across a reload', () => {
    const first = renderSidebar()
    fireEvent.click(screen.getByRole('button', { name: 'Hide beta from the list' }))
    expect(listed()).toEqual(['alpha'])
    expect(JSON.parse(localStorage.getItem(HIDDEN_KEY)!)).toEqual(['beta'])
    first.unmount()

    renderSidebar()
    expect(listed()).toEqual(['alpha'])
    const hidden = screen.getByRole('region', { name: 'Hidden' })
    fireEvent.click(within(hidden).getByRole('button', { name: /Hidden · 1/ }))
    fireEvent.click(within(hidden).getByRole('button', { name: 'Show beta in the list again' }))
    expect(listed()).toEqual(['alpha', 'beta'])
    expect(screen.queryByRole('region', { name: 'Hidden' })).not.toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem(HIDDEN_KEY)!)).toEqual([])
  })

  it('keeps the project in front listed even when hidden', () => {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(['beta']))
    renderSidebar({ activeProjectId: 'beta', dashboardActive: false })
    expect(listed()).toEqual(['alpha', 'beta'])
    expect(screen.getByRole('button', { name: 'Show beta in the list again' })).toBeInTheDocument()
  })

  it('survives unreadable storage', () => {
    localStorage.setItem(HIDDEN_KEY, '{not json')
    localStorage.setItem(FOLDS_KEY, '"quiet"')
    renderSidebar()
    expect(listed()).toEqual(['alpha', 'beta'])
  })

  it('opens the project menu from its ⋯, from a right-click and from Shift+F10, and closes on Esc with focus back', async () => {
    renderSidebar({ activeProjectId: 'beta', dashboardActive: false, onRemoveProject: vi.fn() })
    // On the project in front the ⋯ is there without hovering.
    const more = screen.getByRole('button', { name: /More for beta/ })
    expect(more.parentElement!.className).toMatch(/(^| )flex( |$)/)
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
    expect(listed()).toEqual(['beta'])
    expect(JSON.parse(localStorage.getItem(HIDDEN_KEY)!)).toEqual(['alpha'])
    // From Hidden, the same menu shows it again.
    fireEvent.click(screen.getByRole('button', { name: /Hidden · 1/ }))
    fireEvent.contextMenu(document.querySelector('[data-project-row="alpha"]')!)
    fireEvent.click(screen.getByRole('menuitem', { name: /Show in the sidebar again/ }))
    expect(listed()).toEqual(['alpha', 'beta'])
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

  it('shows the running count and today\'s spend on a row only when there is some', () => {
    const live = (id: string, cwd: string, health: 'working' | 'idle') => ({
      session_id: id, cwd, project: '', model: '', started_at: 0, last_event_at: Date.now(), status: 'active', owned: true,
      activity: { phrase: '', at: '', health },
    }) as unknown as SessionSummary
    const m = buildSidebar({
      projects: [proj('alpha', 1), proj('beta', 2)],
      sessions: [live('a1', '/w/alpha', 'working'), live('a2', '/w/alpha', 'idle')],
      permissions: new Set(),
      costs: new Map([['/w/alpha', 3.5]]),
      openSessions: new Set(),
    })
    renderSidebar({ model: m })
    const alpha = document.querySelector('[data-project-row="alpha"]') as HTMLElement
    const beta = document.querySelector('[data-project-row="beta"]') as HTMLElement
    expect(within(alpha).getByLabelText('2 agents running · 1 working')).toHaveTextContent('2')
    expect(within(alpha).getByLabelText('$3.50 today')).toBeInTheDocument()
    expect(within(beta).queryByLabelText(/running/)).toBeNull()
    expect(within(beta).queryByLabelText(/today/)).toBeNull()
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
})
