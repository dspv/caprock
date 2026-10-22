/**
 * Rows keep their places (owner, 2026-10-13, translated: "when I pick a
 * session in a project from the list, it moves up. I want them to stay in
 * their places; only if moved by hand … fixed positions, I orient visually
 * by them"), and a project row carries its ⌘1–⌘9 key.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
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

beforeEach(() => { localStorage.clear(); sessionStorage.clear() })

const li = (k: string) => document.querySelector(`[data-row-key="${k}"]`) as HTMLElement

/**
 * jsdom lays nothing out: under alpha, row a spans 0..38, b 38..76 and c,
 * a taller one, 76..126, in a list 240 wide from 0 to 130.
 */
function layout() {
  const rect = (left: number, top: number, width: number, height: number) =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect
  const tops: Record<string, [number, number]> = { a: [0, 38], b: [38, 38], c: [76, 50] }
  for (const [k, [top, h]] of Object.entries(tops)) li(k).getBoundingClientRect = () => rect(0, top, 240, h)
  li('a').parentElement!.getBoundingClientRect = () => rect(0, 0, 240, 130)
}

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

  it('drags a row under the pointer, the others making room by its own height, and drops it in that slot', () => {
    const p = props(three(), [])
    const first = render(<Sidebar {...p} />)
    layout()
    fireEvent.pointerDown(li('c'), { button: 0, clientX: 20, clientY: 100 })
    fireEvent.pointerMove(window, { clientX: 20, clientY: 98 })
    // Under the 4px threshold: still a click.
    expect(li('c').dataset.dragging).toBeUndefined()
    fireEvent.pointerMove(window, { clientX: 20, clientY: 90 })
    expect(li('c').dataset.dragging).toBe('true')
    expect(li('c').style.transform).toBe('translateY(-10px)')
    expect(li('c').style.zIndex).toBe('10')
    expect(li('b').style.transform).toBe('')
    // Its top past b's middle: b slides down by c's height (50), not its own.
    fireEvent.pointerMove(window, { clientX: 20, clientY: 60 })
    expect(li('c').style.transform).toBe('translateY(-40px)')
    expect(li('b').style.transform).toBe('translateY(50px)')
    expect(li('a').style.transform).toBe('')
    // Far up: held at the list's top, both others moved down.
    fireEvent.pointerMove(window, { clientX: 20, clientY: -10 })
    expect(li('c').style.transform).toBe('translateY(-76px)')
    expect(li('a').style.transform).toBe('translateY(50px)')
    expect(li('b').style.transform).toBe('translateY(50px)')
    fireEvent.pointerUp(window, { clientX: 20, clientY: 5 })
    fireEvent.click(li('c').querySelector('button')!)
    expect(p.onOpenLive).not.toHaveBeenCalled()
    expect(rows()).toEqual(['c', 'a', 'b'])
    expect(li('c').dataset.dragging).toBeUndefined()
    expect(li('a').style.transform).toBe('')
    expect(JSON.parse(localStorage.getItem(ROW_ORDER_KEY)!)).toEqual({ alpha: ['c', 'a', 'b'] })
    first.unmount()
    render(<Sidebar {...props(three(), [])} />)
    expect(rows()).toEqual(['c', 'a', 'b'])
  })

  it('drops a row dragged down in the slot under the pointer', () => {
    render(<Sidebar {...props(three(), [])} />)
    layout()
    fireEvent.pointerDown(li('a'), { button: 0, clientX: 20, clientY: 10 })
    fireEvent.pointerMove(window, { clientX: 20, clientY: 50 })
    expect(li('a').style.transform).toBe('translateY(40px)')
    expect(li('b').style.transform).toBe('translateY(-38px)')
    expect(li('c').style.transform).toBe('')
    fireEvent.pointerUp(window, { clientX: 20, clientY: 50 })
    expect(rows()).toEqual(['b', 'a', 'c'])
  })

  it('moves nothing when the row is released off the list, and the slot closes as it leaves', () => {
    const p = props(three(), [])
    render(<Sidebar {...p} />)
    layout()
    fireEvent.pointerDown(li('c'), { button: 0, clientX: 20, clientY: 100 })
    fireEvent.pointerMove(window, { clientX: 20, clientY: 40 })
    expect(li('b').style.transform).toBe('translateY(50px)')
    // Out to the side, past the sidebar: the slot closes, the row still follows.
    fireEvent.pointerMove(window, { clientX: 400, clientY: 40 })
    expect(li('b').style.transform).toBe('')
    expect(li('c').style.transform).toBe('translateY(-60px)')
    fireEvent.pointerUp(window, { clientX: 400, clientY: 40 })
    expect(rows()).toEqual(['a', 'b', 'c'])
    expect(localStorage.getItem(ROW_ORDER_KEY)).toBeNull()
    expect(li('c').dataset.dragging).toBeUndefined()
    fireEvent.click(li('c').querySelector('button')!)
    expect(p.onOpenLive).not.toHaveBeenCalled()
  })

  it('puts the row back on Escape, and the release after moves nothing', () => {
    render(<Sidebar {...props(three(), [])} />)
    layout()
    fireEvent.pointerDown(li('a'), { button: 0, clientX: 20, clientY: 10 })
    fireEvent.pointerMove(window, { clientX: 20, clientY: 120 })
    expect(li('a').style.transform).toBe('translateY(88px)')
    expect(li('c').style.transform).toBe('translateY(-38px)')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(li('a').style.transform).toBe('')
    expect(li('c').style.transform).toBe('')
    expect(li('a').dataset.dragging).toBeUndefined()
    fireEvent.pointerMove(window, { clientX: 20, clientY: 120 })
    fireEvent.pointerUp(window, { clientX: 20, clientY: 120 })
    expect(rows()).toEqual(['a', 'b', 'c'])
  })

  it('a click after a drag opens nothing, the next click opens the row, and a row\'s own button still works', async () => {
    const p = props(three(), [tabOf('t1', 'a')])
    render(<Sidebar {...p} />)
    layout()
    // Released off every row: no click follows, and the next real one is not eaten.
    fireEvent.pointerDown(li('b'), { button: 0, clientX: 20, clientY: 50 })
    fireEvent.pointerMove(window, { clientX: 20, clientY: 300 })
    fireEvent.pointerUp(window, { clientX: 20, clientY: 300 })
    await new Promise((r) => setTimeout(r, 0))
    fireEvent.click(li('b').querySelector('button')!)
    expect(p.onOpenLive).toHaveBeenCalledTimes(1)
    // The × on a tab's row closes the tab, a drag or not.
    const close = li('a').querySelector('[data-row-actions] button') as HTMLElement
    fireEvent.pointerDown(close, { button: 0, clientX: 230, clientY: 19 })
    fireEvent.pointerMove(window, { clientX: 230, clientY: 100 })
    expect(li('a').dataset.dragging).toBeUndefined()
    fireEvent.pointerUp(window, { clientX: 230, clientY: 100 })
    fireEvent.click(close)
    expect(p.onCloseTab).toHaveBeenCalledWith('t1')
    expect(rows()).toEqual(['a', 'b', 'c'])
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

  it('moves a focused row with Ctrl+Shift+↑ ↓ on Windows and Linux, where Alt+Shift arrows are the app\'s', () => {
    Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true })
    try {
      render(<Sidebar {...props(three(), [])} />)
      const btn = (k: string) => document.querySelector(`[data-row-key="${k}"] [data-nav-row]`) as HTMLElement
      fireEvent.keyDown(btn('c'), { key: 'ArrowUp', altKey: true, shiftKey: true })
      expect(rows()).toEqual(['a', 'b', 'c'])
      fireEvent.keyDown(btn('c'), { key: 'ArrowUp', ctrlKey: true, shiftKey: true })
      expect(rows()).toEqual(['a', 'c', 'b'])
    } finally {
      Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
    }
  })

  it('draws no key on a project row (tabs have the digits), and marks the project in front', () => {
    render(<Sidebar {...props(three(), [], { activeProjectId: 'beta' })} />)
    expect(document.querySelectorAll('[data-project-key]')).toHaveLength(0)
    expect(document.querySelectorAll('[data-project-row][data-current]')).toHaveLength(1)
    expect(document.querySelector('[data-project-row="beta"]')).toHaveAttribute('data-current', 'true')
    expect(document.querySelector('[data-project-row="beta"]')!.getAttribute('title')).not.toContain('⌘')
  })
})

describe('the rows ⌥⌘↑ ⌥⌘↓ walk', () => {
  it('are the rows the sidebar lists: every agent session of the project, tab or not, in the fixed order; hidden ones are not stops', () => {
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
    expect(sessionStops(node, tabs, p.tabLabels!, undefined, hidden).map((s) => s.key)).toEqual(['a', 'i', 'b', 'c'])
    expect(sessionStops(node, tabs, p.tabLabels!, ['c', 'b'], hidden).map((s) => [s.key, s.tabId ?? s.session?.session_id])).toEqual([['c', 'tc'], ['b', 'b'], ['a', 'ta'], ['i', 'i']])
  })
})
