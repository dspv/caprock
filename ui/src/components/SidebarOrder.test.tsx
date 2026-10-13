/**
 * Rows keep their places (owner, 2026-10-13, translated: "when I pick a
 * session in a project from the list, it moves up. I want them to stay in
 * their places; only if moved by hand … fixed positions, I orient visually
 * by them"), and a project row carries its ⌘1–⌘9 key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { Project } from '@/lib/projects'
import type { SessionSummary } from '@/lib/api'
import { buildSidebar } from '@/lib/sidebar'
import { tabLabels } from '@/lib/tablabels'
import type { Tab } from '@/lib/tabs'
import { ROW_ORDER_KEY } from '@/lib/rowOrder'
import { Sidebar, type SidebarProps } from './Sidebar'
import { sessionStops } from './ProjectRow'

Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })

const proj = (id: string): Project => ({ id, root: `/w/${id}`, name: id, kind: 'folder', last_activity: Date.now(), pinned: true })
const live = (p: Partial<SessionSummary>) => ({
  session_id: 's', cwd: '/w/alpha', project: 'alpha', model: '', started_at: 1, last_event_at: 1, status: 'active',
  git_branch: '', owned: true, activity: { phrase: '', at: '', health: 'working' }, ...p,
}) as SessionSummary
const pane = (id: string, sessionId: string) => ({ type: 'pane' as const, id, target: { kind: 'session' as const, sessionId } })
const tabOf = (id: string, sessionId: string): Tab => ({ id, projectId: 'alpha', root: pane(`p-${id}`, sessionId), focusedPaneId: `p-${id}`, title: sessionId })

function props(sessions: SessionSummary[], tabs: Tab[], extra: Partial<SidebarProps> = {}): SidebarProps {
  const model = buildSidebar({ projects: [proj('alpha'), proj('beta'), proj('gamma')], sessions, permissions: new Set(), costs: new Map(), openSessions: new Set(tabs.map((t) => (t.root.type === 'pane' ? t.root.target.sessionId : ''))) })
  return {
    model,
    source: 'api',
    activeProjectId: 'alpha',
    dashboardActive: false,
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
}

/** The rows under alpha, by the session each shows. */
const rows = () => [...document.querySelectorAll('[data-row-project="alpha"]')].map((r) => r.getAttribute('data-row-key'))

const three = () => [
  live({ session_id: 'a', title: 'First', started_at: 1 }),
  live({ session_id: 'b', title: 'Second', started_at: 2 }),
  live({ session_id: 'c', title: 'Third', started_at: 3 }),
]

const original = document.elementFromPoint
beforeEach(() => { localStorage.clear(); sessionStorage.clear() })
afterEach(() => { document.elementFromPoint = original })

describe('rows keep their places', () => {
  it('does not move a row picked from the list: opened as a tab and brought to the front, it stays where it was', () => {
    const sessions = three()
    const p = props(sessions, [tabOf('t1', 'a')], { activeTabId: 't1' })
    const { rerender } = render(<Sidebar {...p} />)
    expect(rows()).toEqual(['a', 'b', 'c'])
    fireEvent.click(screen.getByText('Third'))
    expect(p.onOpenLive).toHaveBeenCalled()
    // What the app does next: a tab for it, in front, appended to the strip.
    const tabs = [tabOf('t1', 'a'), tabOf('t3', 'c')]
    rerender(<Sidebar {...props(sessions, tabs, { activeTabId: 't3' })} />)
    expect(rows()).toEqual(['a', 'b', 'c'])
    expect(document.querySelector('[data-tab-row="t3"]')).toHaveAttribute('aria-current', 'true')
  })

  it('does not move a row on a new event or a state change, and puts a new session last', () => {
    const sessions = three()
    const { rerender } = render(<Sidebar {...props(sessions, [])} />)
    expect(rows()).toEqual(['a', 'b', 'c'])
    const next = [
      { ...sessions[2]!, last_event_at: 99, activity: { phrase: '', at: new Date().toISOString(), health: 'waiting-on-you' } },
      sessions[1]!,
      { ...sessions[0]!, last_event_at: 50 },
      live({ session_id: 'n', title: 'New', started_at: 9 }),
    ] as SessionSummary[]
    rerender(<Sidebar {...props(next, [])} />)
    expect(rows()).toEqual(['a', 'b', 'c', 'n'])
  })

  it('moves a row dragged onto another, keeps it across a restart, and opens nothing on the release', () => {
    const p = props(three(), [])
    const first = render(<Sidebar {...p} />)
    const li = (k: string) => document.querySelector(`[data-row-key="${k}"]`) as HTMLElement
    document.elementFromPoint = () => li('a')
    fireEvent.pointerDown(li('c'), { button: 0, clientX: 20, clientY: 100 })
    fireEvent.pointerMove(window, { clientX: 20, clientY: 60 })
    fireEvent.pointerUp(window, { clientX: 20, clientY: 40 })
    fireEvent.click(li('c').querySelector('button')!)
    expect(p.onOpenLive).not.toHaveBeenCalled()
    expect(rows()).toEqual(['c', 'a', 'b'])
    expect(JSON.parse(localStorage.getItem(ROW_ORDER_KEY)!)).toEqual({ alpha: ['c', 'a', 'b'] })
    first.unmount()
    render(<Sidebar {...props(three(), [])} />)
    expect(rows()).toEqual(['c', 'a', 'b'])
  })

  it('moves a focused row with ⌥⇧↑ and ⌥⇧↓, focus staying on it; a plain ↓ still only moves focus', () => {
    render(<Sidebar {...props(three(), [])} />)
    const btn = (k: string) => document.querySelector(`[data-row-key="${k}"] [data-nav-row]`) as HTMLElement
    btn('b').focus()
    fireEvent.keyDown(btn('b'), { key: 'ArrowUp', altKey: true, shiftKey: true })
    expect(rows()).toEqual(['b', 'a', 'c'])
    expect(document.activeElement).toBe(btn('b'))
    fireEvent.keyDown(btn('b'), { key: 'ArrowDown', altKey: true, shiftKey: true })
    fireEvent.keyDown(btn('b'), { key: 'ArrowDown', altKey: true, shiftKey: true })
    expect(rows()).toEqual(['a', 'c', 'b'])
    // At the end it stays.
    fireEvent.keyDown(btn('b'), { key: 'ArrowDown', altKey: true, shiftKey: true })
    expect(rows()).toEqual(['a', 'c', 'b'])
    fireEvent.keyDown(btn('a'), { key: 'ArrowDown' })
    expect(rows()).toEqual(['a', 'c', 'b'])
  })

  it('draws ⌘1–⌘9 on the project rows in the sidebar order, and marks the project in front', () => {
    render(<Sidebar {...props(three(), [], { activeProjectId: 'beta' })} />)
    const keyOf = (id: string) => document.querySelector(`[data-project-row="${id}"] [data-project-key]`)?.textContent
    expect(['alpha', 'beta', 'gamma'].map(keyOf)).toEqual(['⌘1', '⌘2', '⌘3'])
    expect(document.querySelectorAll('[data-project-row][data-current]')).toHaveLength(1)
    expect(document.querySelector('[data-project-row="beta"]')).toHaveAttribute('data-current', 'true')
    expect(document.querySelector('[data-project-row="beta"]')!.getAttribute('title')).toContain('⌘2')
  })
})

describe('the rows ⌥⌘↑ ⌥⌘↓ walk', () => {
  it('are the project\'s tabs and its active sessions with no tab, in the fixed order; idle and hidden ones with no tab are not stops', () => {
    const sessions = [
      live({ session_id: 'a', started_at: 1 }),
      live({ session_id: 'i', started_at: 2, activity: { phrase: '', at: '', health: 'idle' } }),
      live({ session_id: 'b', started_at: 3 }),
      live({ session_id: 'h', started_at: 4 }),
      live({ session_id: 'c', started_at: 5, activity: { phrase: '', at: '', health: 'idle' } }),
    ]
    const tabs = [tabOf('tc', 'c'), tabOf('ta', 'a')]
    const p = props(sessions, tabs)
    const node = p.model.projects.find((n) => n.project.id === 'alpha')
    const hidden = new Map([['h', Date.now()]])
    expect(sessionStops(node, tabs, p.tabLabels!, undefined, hidden).map((s) => s.key)).toEqual(['a', 'b', 'c'])
    expect(sessionStops(node, tabs, p.tabLabels!, ['c', 'b'], hidden).map((s) => [s.key, s.tabId ?? s.session?.session_id])).toEqual([['c', 'tc'], ['b', 'b'], ['a', 'ta']])
  })
})
