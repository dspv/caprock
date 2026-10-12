/**
 * One row per project (owner, 2026-10-12: "there should be the project, but
 * only ONE card under it; hide the rest inside", translated): the row that
 * matters now, and everything else behind one quiet "+N more" line that says
 * what in it waits on you, opens in place and is remembered per project.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@/lib/projects'
import type { SessionSummary } from '@/lib/api'
import { buildSidebar, type SessionNode } from '@/lib/sidebar'
import { tabLabels } from '@/lib/tablabels'
import type { Tab } from '@/lib/tabs'
import { HIDDEN_SESSIONS_KEY, Sidebar, type SidebarProps } from './Sidebar'
import { MORE_KEY, pickLead, type LeadItem } from './ProjectRow'

Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })

const proj = (id: string): Project => ({ id, root: `/w/${id}`, name: id, kind: 'folder', last_activity: Date.now(), pinned: true })
const recent = () => new Date(Date.now() - 60_000).toISOString()
const live = (p: Partial<SessionSummary>) => ({
  session_id: 's', cwd: '/w/alpha', project: 'alpha', model: '', started_at: 1, last_event_at: 1, status: 'active',
  git_branch: '', owned: true, activity: { phrase: '', at: '', health: 'working' }, ...p,
}) as SessionSummary
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

const rows = (projectId = 'alpha') => [...screen.getByRole('group', { name: `${projectId}: open tabs` }).querySelectorAll('[data-tab-row], [data-live-row]')]
  .map((r) => r.getAttribute('data-tab-row') ?? r.getAttribute('data-live-row'))
const more = () => document.querySelector('[data-more-rows]') as HTMLElement | null

beforeEach(() => localStorage.clear())

describe('one row per project', () => {
  const five = () => [
    live({ session_id: 'a1', title: 'Old idle', started_at: 1, last_event_at: 10, activity: { phrase: '', at: '', health: 'idle' } }),
    live({ session_id: 'a2', title: 'Busy earlier', started_at: 2, last_event_at: 20 }),
    live({ session_id: 'a3', title: 'Busy now', started_at: 3, last_event_at: 30 }),
    live({ session_id: 'a4', title: 'Idle later', started_at: 4, last_event_at: 40, activity: { phrase: '', at: '', health: 'idle' } }),
    live({ session_id: 'sh1', kind: 'shell', started_at: 5, last_event_at: 50 }),
  ]

  it('shows the working one most recently active, and folds the rest into "+N more" with a breakdown in its tooltip', () => {
    setup(five(), [])
    expect(rows()).toEqual(['a3'])
    expect(more()!.textContent).toBe('+4 more›')
    expect(more()).toHaveAttribute('aria-expanded', 'false')
    expect(more()!.getAttribute('title')).toMatch(/^1 working · 2 idle · 1 shell\. Show them here\./)
    expect(more()!.className).toContain('text-fg-faint')
  })

  it('leads with the tab in front, whatever else works', () => {
    const tabs: Tab[] = [{ id: 't4', projectId: 'alpha', root: pane('p4', 'session', 'a4'), focusedPaneId: 'p4', title: 'Idle later' }]
    setup(five(), tabs, { dashboardActive: false, activeTabId: 't4' })
    expect(rows()).toEqual(['t4'])
    expect(document.querySelector('[data-tab-row="t4"]')).toHaveAttribute('aria-current', 'true')
  })

  it('leads with the project\'s tab last in front when it is not the one in front, so leaving it moves nothing', () => {
    const tabs: Tab[] = [
      { id: 't1', projectId: 'alpha', root: pane('p1', 'session', 'a1'), focusedPaneId: 'p1', title: 'Old idle' },
      { id: 't4', projectId: 'alpha', root: pane('p4', 'session', 'a4'), focusedPaneId: 'p4', title: 'Idle later' },
    ]
    setup(five(), tabs, { activeByProject: { alpha: 't4' } })
    expect(rows()).toEqual(['t4'])
    // Shown, not highlighted: the dashboard is in front.
    expect(document.querySelector('[data-tab-row="t4"]')).not.toHaveAttribute('aria-current')
  })

  it('leads with what asks before what waits, and says in amber what waits behind the fold', () => {
    const s = five()
    s[0] = { ...s[0]!, activity: { phrase: '', at: recent(), health: 'waiting-on-you' } }
    setup(s, [], {}, new Set(['a2']))
    expect(rows()).toEqual(['a2'])
    expect(document.querySelector('[data-live-row="a2"] [data-state]')!.textContent).toBe('asks')
    expect(more()!.textContent).toBe('+4 more · 1 waiting›')
    expect(more()).toHaveAttribute('data-waiting', 'true')
    expect(more()!.className).toContain('text-accent')
  })

  it('says "asks" on the fold when a hidden one asks', () => {
    const tabs: Tab[] = [{ id: 't3', projectId: 'alpha', root: pane('p3', 'session', 'a3'), focusedPaneId: 'p3', title: 'Busy now' }]
    setup(five(), tabs, { dashboardActive: false, activeTabId: 't3' }, new Set(['a1']))
    expect(rows()).toEqual(['t3'])
    expect(more()!.textContent).toBe('+4 more · 1 asks›')
  })

  it('opens in place, keeping the order, and remembers it per project across a reload', () => {
    const first = setup(five(), [])
    fireEvent.click(more()!)
    expect(rows()).toEqual(['a3', 'a1', 'a2', 'a4', 'sh1'])
    expect(more()).toHaveAttribute('aria-expanded', 'true')
    expect(more()!.getAttribute('title')).toContain('Fold them back')
    expect(JSON.parse(localStorage.getItem(MORE_KEY)!)).toEqual(['alpha'])
    first.unmount()
    setup(five(), [])
    expect(rows()).toEqual(['a3', 'a1', 'a2', 'a4', 'sh1'])
    fireEvent.click(more()!)
    expect(rows()).toEqual(['a3'])
    expect(JSON.parse(localStorage.getItem(MORE_KEY)!)).toEqual([])
  })

  it('has no fold when there is only one row', () => {
    setup([live({ session_id: 'a1', title: 'Only one' })], [])
    expect(rows()).toEqual(['a1'])
    expect(more()).toBeNull()
  })

  it('keeps × on the one row: a tab closes as the strip does', () => {
    const tabs: Tab[] = [{ id: 't3', projectId: 'alpha', root: pane('p3', 'session', 'a3'), focusedPaneId: 'p3', title: 'Busy now' }]
    const { props } = setup(five(), tabs, { dashboardActive: false, activeTabId: 't3' })
    fireEvent.click(screen.getByRole('button', { name: 'Close tab Busy now' }))
    expect(props.onCloseTab).toHaveBeenCalledWith('t3')
  })

  it('hides the row shown with its ×; the next leads, and hidden rows wait inside the fold', () => {
    setup(five(), [])
    fireEvent.click(screen.getByRole('button', { name: 'Hide Busy now from the list' }))
    expect(Object.keys(JSON.parse(localStorage.getItem(HIDDEN_SESSIONS_KEY)!))).toEqual(['a3'])
    expect(rows()).toEqual(['a2'])
    expect(more()!.textContent).toBe('+3 more›')
    expect(screen.queryByRole('button', { name: /1 hidden · show/ })).toBeNull()
    fireEvent.click(more()!)
    const list = screen.getByRole('group', { name: 'alpha: open tabs' })
    expect(within(list).getByRole('button', { name: /1 hidden · show/ })).toBeInTheDocument()
  })
})

describe('pickLead', () => {
  const node = (id: string, dot: SessionNode['dot'], at: number, extra: Partial<SessionNode> = {}): LeadItem =>
    ({ key: id, node: { session: live({ session_id: id, last_event_at: at }), dot, title: id, isShell: false, open: false, ...extra } })

  it('keeps the row shown before while nothing outranks it, so two busy sessions do not trade places', () => {
    const a = node('a', 'working', 10)
    const b = node('b', 'working', 20)
    expect(pickLead([a, b])!.key).toBe('b')
    expect(pickLead([a, b], undefined, 'a')!.key).toBe('a')
    // Something that waits outranks it.
    const w = node('w', 'waiting', 1, { waiting: true })
    expect(pickLead([a, b, w], undefined, 'a')!.key).toBe('w')
    // The previous one went idle: the working one leads.
    expect(pickLead([node('a', 'idle', 30), b], undefined, 'a')!.key).toBe('b')
    expect(pickLead([])).toBeUndefined()
  })
})
