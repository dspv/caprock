/**
 * What the sidebar lists (owner, 2026-10-13, translated): "show ONLY the
 * agent sessions there; let the user hide or close them himself; don't move
 * anything, don't add extra elements … 'More projects' and 'Hidden' in one
 * button like 'More…'", and "a switch like 'group by projects' or not".
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@/lib/projects'
import type { SessionSummary } from '@/lib/api'
import { buildSidebar } from '@/lib/sidebar'
import { tabLabels } from '@/lib/tablabels'
import type { Tab } from '@/lib/tabs'
import { HIDDEN_KEY, HIDDEN_SESSIONS_KEY, Sidebar, type SidebarProps } from './Sidebar'
import { flatRows } from './ProjectRow'

Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })

const proj = (id: string): Project => ({ id, root: `/w/${id}`, name: id, kind: 'folder', last_activity: Date.now(), pinned: true })
const live = (p: Partial<SessionSummary>) => ({
  session_id: 's', cwd: '/w/alpha', project: 'alpha', model: '', started_at: 1, last_event_at: 1, status: 'active',
  git_branch: '', owned: true, activity: { phrase: '', at: '', health: 'working' }, ...p,
}) as SessionSummary
const idle = { phrase: '', at: '', health: 'idle' } as const
const pane = (id: string, kind: 'session' | 'shell', sessionId: string) => ({ type: 'pane' as const, id, target: { kind, sessionId } })

function setup(sessions: SessionSummary[], tabs: Tab[], extra: Partial<SidebarProps> = {}) {
  const open = new Set(tabs.map((t) => (t.root.type === 'pane' ? t.root.target.sessionId : '')))
  const model = buildSidebar({ projects: [proj('alpha'), proj('beta')], sessions, permissions: new Set(), costs: new Map(), openSessions: open })
  const props: SidebarProps = {
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
  return { ...render(<Sidebar {...props} />), props }
}

const rows = () => [...document.querySelectorAll('[data-tab-row], [data-live-row]')]
  .map((r) => r.getAttribute('data-tab-row') ?? r.getAttribute('data-live-row'))

/** Working, waiting, idle and ended agents, two shells, in alpha; one in beta. */
const mix = () => [
  live({ session_id: 'w1', title: 'Busy', started_at: 1 }),
  live({ session_id: 'wt', title: 'Your turn', started_at: 2, activity: { phrase: '', at: new Date(Date.now() - 60_000).toISOString(), health: 'waiting-on-you' } }),
  live({ session_id: 'i1', title: 'Idle one', started_at: 3, activity: idle }),
  live({ session_id: 'e1', title: 'Done one', started_at: 4, status: 'ended', activity: { phrase: '', at: '', health: 'ended' } }),
  live({ session_id: 'sh1', kind: 'shell', started_at: 5, activity: idle }),
  live({ session_id: 'sh2', kind: 'shell', program: 'npm', started_at: 6 }),
  live({ session_id: 'b1', title: 'Beta work', cwd: '/w/beta', project: 'beta', started_at: 7 }),
]

beforeEach(() => { localStorage.clear(); sessionStorage.clear() })

describe('the sessions under a project', () => {
  it('lists every agent session, working, waiting or idle, in the order they started; no shells, no ended ones, no "+N more"', () => {
    setup(mix(), [])
    const alpha = screen.getByRole('group', { name: 'alpha: sessions' })
    expect([...alpha.querySelectorAll('[data-live-row]')].map((r) => r.getAttribute('data-live-row'))).toEqual(['w1', 'wt', 'i1'])
    expect(rows()).toEqual(['w1', 'wt', 'i1', 'b1'])
    expect(document.querySelector('[data-more-rows]')).toBeNull()
    expect(screen.queryByText(/more›|Fold \d back/)).toBeNull()
    // One line each, compact, with no agent mark.
    const row = document.querySelector('[data-live-row="w1"]')!
    expect(row.className).toContain('h-[28px]')
    expect(row.querySelector('[aria-label="Claude Code"]')).toBeNull()
  })

  it('takes a hidden session off the list until More… shows it again', () => {
    localStorage.setItem(HIDDEN_SESSIONS_KEY, JSON.stringify({ i1: Date.now() }))
    setup(mix(), [])
    expect(rows()).toEqual(['w1', 'wt', 'b1'])
    fireEvent.click(document.querySelector('[data-sidebar-more]')!)
    const menu = screen.getByRole('menu', { name: 'More projects and hidden rows' })
    expect(within(menu).getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['Idle one · alphashow'])
    fireEvent.click(within(menu).getByRole('menuitem'))
    expect(rows()).toEqual(['w1', 'wt', 'i1', 'b1'])
    expect(document.querySelector('[data-sidebar-more]')).toBeNull()
  })

  it('puts other projects and hidden projects and rows in one More… list: open one, or show one again', () => {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify({ beta: Date.now() }))
    localStorage.setItem(HIDDEN_SESSIONS_KEY, JSON.stringify({ wt: Date.now() }))
    setup(mix(), [])
    expect(screen.queryByRole('region', { name: 'Hidden' })).toBeNull()
    expect(screen.queryByRole('button', { name: /More projects/ })).toBeNull()
    fireEvent.click(document.querySelector('[data-sidebar-more]')!)
    const menu = screen.getByRole('menu')
    expect(within(menu).getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['betashow', 'Your turn · alphashow'])
    fireEvent.click(within(menu).getByRole('menuitem', { name: /^beta/ }))
    expect(JSON.parse(localStorage.getItem(HIDDEN_KEY)!)).toEqual({})
    expect(document.querySelector('[data-project-row="beta"]')).not.toBeNull()
  })
})

describe('group by project, off', () => {
  it('lists every session in one flat list, each with its project dimmed, numbered ⌘1–⌘9 by place', () => {
    const onToggleGrouped = vi.fn()
    setup(mix(), [], { grouped: false, onToggleGrouped })
    expect(document.querySelector('[data-project-row]')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Sessions' })).toBeInTheDocument()
    const list = screen.getByRole('group', { name: 'Sessions' })
    expect([...list.querySelectorAll('[data-live-row]')].map((r) => r.getAttribute('data-live-row'))).toEqual(['w1', 'wt', 'i1', 'b1'])
    expect([...list.querySelectorAll('[data-row-key-digit]')].map((k) => k.textContent)).toEqual(['⌘1', '⌘2', '⌘3', '⌘4'])
    expect(list.querySelector('[data-live-row="b1"] [data-row-project-mark]')!.textContent).toBe('beta')
    const toggle = screen.getByRole('button', { name: 'Group by project' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(toggle)
    expect(onToggleGrouped).toHaveBeenCalled()
  })

  it('keeps its own order by hand, apart from each project\'s', () => {
    const sessions = mix()
    const model = buildSidebar({ projects: [proj('alpha'), proj('beta')], sessions, permissions: new Set(), costs: new Map(), openSessions: new Set() })
    const flat = (orders: Record<string, string[]>) => flatRows(model.projects, [], new Map(), orders).map((r) => r.key)
    expect(flat({})).toEqual(['w1', 'wt', 'i1', 'b1'])
    expect(flat({ '*': ['b1', 'i1'] })).toEqual(['b1', 'i1', 'w1', 'wt'])
    expect(flat({ alpha: ['i1'] })).toEqual(['w1', 'wt', 'i1', 'b1'])
  })

  it('draws on a row the same digit the strip draws on its tab', () => {
    const tabs: Tab[] = [
      { id: 'tb', projectId: 'beta', root: pane('pb', 'session', 'b1'), focusedPaneId: 'pb', title: 'Beta work' },
      { id: 'tw', projectId: 'alpha', root: pane('pw', 'session', 'wt'), focusedPaneId: 'pw', title: 'Your turn' },
    ]
    setup(mix(), tabs, { grouped: false, activeTabId: 'tw' })
    const digitOf = (sel: string) => document.querySelector(`${sel} [data-row-key-digit]`)?.textContent
    // In front, the × takes the key's place; the key is still the row's.
    expect(document.querySelector('[data-tab-row="tw"] [data-row-key-digit]')!.className).toContain('hidden')
    expect(digitOf('[data-tab-row="tw"]')).toBe('⌘2')
    expect(digitOf('[data-tab-row="tb"]')).toBe('⌘4')
    expect(digitOf('[data-live-row="w1"]')).toBe('⌘1')
  })
})
