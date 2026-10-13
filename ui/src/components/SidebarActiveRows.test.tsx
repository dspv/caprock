/**
 * Only active rows under a project (owner, 2026-10-13, FB-053: "way too much
 * stuff, I want only active sessions there", translated): what works, loops
 * or waits on you, and the tab in front. Idle, ended and hidden rows go
 * behind one quiet "+N more" line, which opens in place for this window's
 * life; a project with nothing active is its row alone.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@/lib/projects'
import type { SessionSummary } from '@/lib/api'
import { buildSidebar, type SessionNode } from '@/lib/sidebar'
import { tabLabels } from '@/lib/tablabels'
import type { Tab } from '@/lib/tabs'
import { HIDDEN_SESSIONS_KEY, Sidebar, type SidebarProps } from './Sidebar'
import { isActiveRow, MORE_KEY, moreBreakdown, type LeadItem } from './ProjectRow'

Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })

const proj = (id: string): Project => ({ id, root: `/w/${id}`, name: id, kind: 'folder', last_activity: Date.now(), pinned: true })
const recent = () => new Date(Date.now() - 60_000).toISOString()
const live = (p: Partial<SessionSummary>) => ({
  session_id: 's', cwd: '/w/alpha', project: 'alpha', model: '', started_at: 1, last_event_at: 1, status: 'active',
  git_branch: '', owned: true, activity: { phrase: '', at: '', health: 'working' }, ...p,
}) as SessionSummary
const idle = { phrase: '', at: '', health: 'idle' } as const
const pane = (id: string, kind: 'session' | 'shell', sessionId: string) => ({ type: 'pane' as const, id, target: { kind, sessionId } })

function setup(sessions: SessionSummary[], tabs: Tab[], extra: Partial<SidebarProps> = {}, permissions: ReadonlySet<string> = new Set()) {
  const open = new Set(tabs.map((t) => (t.root.type === 'pane' ? t.root.target.sessionId : '')))
  const model = buildSidebar({ projects: [proj('alpha'), proj('beta')], sessions, permissions, costs: new Map(), openSessions: open })
  const props: SidebarProps = {
    model,
    source: 'api',
    activeProjectId: 'alpha',
    dashboardActive: true,
    tabs,
    tabLabels: tabLabels(tabs, new Map(sessions.map((s) => [s.session_id, s])), new Set(), () => undefined),
    onActivateTab: vi.fn(),
    onCloseTab: vi.fn(),
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

const group = (projectId = 'alpha') => screen.queryByRole('group', { name: `${projectId}: open tabs` })
const rows = (projectId = 'alpha') => [...(group(projectId)?.querySelectorAll('[data-tab-row], [data-live-row]') ?? [])]
  .map((r) => r.getAttribute('data-tab-row') ?? r.getAttribute('data-live-row'))
const more = (projectId = 'alpha') => group(projectId)?.querySelector('[data-more-rows]') as HTMLElement | null

/** One of each: working, waiting, idle, ended, hidden (working), an idle shell and a busy one. */
const mix = () => [
  live({ session_id: 'w1', title: 'Busy', started_at: 1 }),
  live({ session_id: 'wt', title: 'Your turn', started_at: 2, activity: { phrase: '', at: recent(), health: 'waiting-on-you' } }),
  live({ session_id: 'i1', title: 'Idle one', started_at: 3, activity: idle }),
  live({ session_id: 'e1', title: 'Done one', started_at: 4, status: 'ended', activity: { phrase: '', at: '', health: 'ended' } }),
  live({ session_id: 'h1', title: 'Hidden busy', started_at: 5 }),
  live({ session_id: 'sh1', kind: 'shell', started_at: 6, activity: idle }),
  live({ session_id: 'sh2', kind: 'shell', program: 'npm', started_at: 7 }),
]
const hide = (...ids: string[]) => localStorage.setItem(HIDDEN_SESSIONS_KEY, JSON.stringify(Object.fromEntries(ids.map((id) => [id, Date.now()]))))

beforeEach(() => { localStorage.clear(); sessionStorage.clear() })

describe('only active rows under a project', () => {
  it('lists what works and waits, in order, and folds idle and hidden rows into "+N more"; ended ones nowhere', () => {
    hide('h1')
    setup(mix(), [])
    expect(rows()).toEqual(['w1', 'wt', 'sh2'])
    expect(document.querySelector('[data-live-row="wt"]')).toHaveAttribute('data-waiting', 'true')
    // i1, sh1 and the hidden h1. No line of its own for the hidden one.
    expect(more()!.textContent).toBe('+3 more›')
    expect(more()).toHaveAttribute('aria-expanded', 'false')
    expect(more()!.className).toContain('text-fg-faint')
    expect(more()!.getAttribute('title')).toMatch(/^1 idle · 1 shell · 1 hidden\. Show them here, each in its place\./)
    expect(document.querySelector('[data-hidden-rows]')).toBeNull()
    expect(screen.queryByText(/hidden · (show|hide again)/)).toBeNull()
    expect(document.querySelector('[data-live-row="e1"]')).toBeNull()
  })

  it('lists what asks permission, marked "asks"', () => {
    setup([live({ session_id: 'a1', title: 'Asks', activity: idle }), live({ session_id: 'i1', title: 'Idle one', started_at: 2, activity: idle })], [], {}, new Set(['a1']))
    expect(rows()).toEqual(['a1'])
    expect(document.querySelector('[data-live-row="a1"] [data-state]')!.textContent).toBe('asks')
    expect(more()!.textContent).toBe('+1 more›')
  })

  it('lists a looping session', () => {
    setup([live({ session_id: 'l1', title: 'Loops', activity: { phrase: '', at: '', health: 'looping' } })], [])
    expect(rows()).toEqual(['l1'])
  })

  it('does not list a turn that ended more than 12 hours ago: it no longer waits', () => {
    const old = new Date(Date.now() - 13 * 3600_000).toISOString()
    setup([live({ session_id: 'o1', title: 'Old turn', activity: { phrase: '', at: old, health: 'waiting-on-you' } })], [])
    expect(rows()).toEqual([])
    expect(more()!.getAttribute('title')).toMatch(/^1 idle\./)
  })

  it('always lists the tab in front, idle or not, highlighted; out of front, an idle tab folds', () => {
    const tabs: Tab[] = [{ id: 't1', projectId: 'alpha', root: pane('p1', 'session', 'i1'), focusedPaneId: 'p1', title: 'Idle one' }]
    const first = setup(mix(), tabs, { dashboardActive: false, activeTabId: 't1' })
    // In its place by when its session started, not first (lib/rowOrder.ts).
    expect(rows()).toEqual(['w1', 'wt', 't1', 'h1', 'sh2'])
    expect(document.querySelector('[data-tab-row="t1"]')).toHaveAttribute('aria-current', 'true')
    first.unmount()
    setup(mix(), tabs)
    expect(rows()).toEqual(['w1', 'wt', 'h1', 'sh2'])
    expect(document.querySelector('[data-tab-row="t1"]')).toBeNull()
  })

  it('lists a working session\'s tab out of front, and a file tab only in front', () => {
    const tabs: Tab[] = [
      { id: 'tw', projectId: 'alpha', root: pane('pw', 'session', 'w1'), focusedPaneId: 'pw', title: 'Busy' },
      { id: 'tf', projectId: 'alpha', root: { type: 'pane', id: 'pf', target: { kind: 'file', sessionId: 'file:a.ts', path: 'a.ts' } }, focusedPaneId: 'pf', title: 'a.ts' },
    ]
    setup([live({ session_id: 'w1', title: 'Busy' })], tabs)
    expect(rows()).toEqual(['tw'])
    expect(more()!.getAttribute('title')).toMatch(/^1 file\./)
  })

  it('opens "+N more" in place: every row in its fixed place, then the hidden ones muted with an eye; kept for the window, not for good', () => {
    hide('h1')
    const first = setup(mix(), [])
    fireEvent.click(more()!)
    // The folded rows among the active ones, where they started; the line
    // that folds them goes last and says so.
    expect(rows()).toEqual(['w1', 'wt', 'i1', 'sh1', 'sh2', 'h1'])
    expect(more()!.textContent).toBe('Fold 3 back›')
    expect(document.querySelector('[data-live-row="h1"]')).toHaveAttribute('data-hidden-row', 'true')
    expect(within(group()!).getByRole('button', { name: 'Show Hidden busy in the list again' })).toBeInTheDocument()
    expect(more()).toHaveAttribute('aria-expanded', 'true')
    expect(more()!.getAttribute('title')).toContain('Fold them back')
    expect(JSON.parse(sessionStorage.getItem(MORE_KEY)!)).toEqual(['alpha'])
    expect(localStorage.getItem(MORE_KEY)).toBeNull()
    first.unmount()
    setup(mix(), [])
    expect(rows()).toEqual(['w1', 'wt', 'i1', 'sh1', 'sh2', 'h1'])
    fireEvent.click(more()!)
    expect(rows()).toEqual(['w1', 'wt', 'sh2'])
  })

  it('hides a working row with its ×: it leaves the list for the fold and stays hidden while it works', () => {
    setup(mix(), [])
    fireEvent.click(screen.getByRole('button', { name: 'Hide Busy from the list' }))
    expect(Object.keys(JSON.parse(localStorage.getItem(HIDDEN_SESSIONS_KEY)!))).toEqual(['w1'])
    expect(rows()).toEqual(['wt', 'h1', 'sh2'])
    expect(more()!.textContent).toBe('+3 more›')
  })

  it('brings a hidden row back to the list when it asks', () => {
    hide('h1')
    setup(mix(), [], {}, new Set(['h1']))
    expect(rows()).toEqual(['w1', 'wt', 'h1', 'sh2'])
  })

  it('shows a project with nothing active as its row alone; its chevron opens the rest', () => {
    setup([
      live({ session_id: 'b1', cwd: '/w/beta', project: 'beta', title: 'Beta idle', activity: idle }),
      live({ session_id: 'w1', title: 'Busy' }),
    ], [])
    expect(group('beta')).toBeNull()
    const chevron = document.querySelector('[data-project="beta"] [data-project-fold]') as HTMLElement
    expect(chevron).toHaveAttribute('aria-expanded', 'false')
    expect(chevron.getAttribute('title')).toMatch(/^1 idle\. Show them here\./)
    fireEvent.click(chevron)
    expect(rows('beta')).toEqual(['b1'])
    expect(more('beta')).toBeNull()
    expect(chevron).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(chevron)
    expect(group('beta')).toBeNull()
  })

  it('has no chevron on a project with nothing in it at all', () => {
    setup([live({ session_id: 'w1', title: 'Busy' })], [])
    expect(document.querySelector('[data-project="beta"] [data-project-fold]')).toBeNull()
    expect(group('beta')).toBeNull()
  })

  it('keeps "+N more" under the project in front when nothing in it is active', () => {
    setup([live({ session_id: 'i1', title: 'Idle one', activity: idle })], [])
    expect(rows()).toEqual([])
    expect(more()!.textContent).toBe('+1 more›')
  })

  it('folded by hand, an active project lists only what waits', () => {
    setup(mix(), [])
    fireEvent.click(screen.getByRole('button', { name: 'Fold alpha' }))
    expect(rows()).toEqual(['wt'])
    expect(more()).toBeNull()
  })

  it('moves between the rows and "+N more" with the arrow keys', () => {
    setup(mix(), [])
    const project = document.querySelector('[data-project-row="alpha"]') as HTMLElement
    project.focus()
    fireEvent.keyDown(project, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(document.querySelector('[data-live-row="w1"]'))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(more())
  })
})

describe('isActiveRow', () => {
  const node = (dot: SessionNode['dot'], extra: Partial<SessionNode> = {}): LeadItem =>
    ({ key: 'k', node: { session: live({ session_id: 'k' }), dot, title: 'k', isShell: false, open: false, ...extra } })

  it('is true for working, looping, waiting now and the tab in front; false for idle, ended and a stale turn', () => {
    expect(isActiveRow(node('working'))).toBe(true)
    expect(isActiveRow(node('looping'))).toBe(true)
    expect(isActiveRow(node('waiting', { waiting: true }))).toBe(true)
    expect(isActiveRow(node('waiting'))).toBe(false)
    expect(isActiveRow(node('idle'))).toBe(false)
    expect(isActiveRow(node('ended'))).toBe(false)
    const tab = { id: 't', projectId: 'alpha', root: pane('p', 'session', 'k'), focusedPaneId: 'p', title: 'k' } as Tab
    expect(isActiveRow({ ...node('idle'), tab }, 't')).toBe(true)
    expect(isActiveRow({ ...node('idle'), tab }, 'other')).toBe(false)
  })

  it('says in the fold\'s tooltip what it holds, hidden rows included', () => {
    expect(moreBreakdown([node('idle'), node('idle'), node('ended')], 2)).toBe('2 idle · 1 done · 2 hidden')
  })
})
