/**
 * What the sidebar lists (owner, 2026-10-13, translated): "show ONLY the
 * agent sessions there; let the user hide or close them himself; don't move
 * anything, don't add extra elements … 'More projects' and 'Hidden' in one
 * button like 'More…'", and "a switch like 'group by projects' or not".
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@/lib/projects'
import type { SessionSummary, Summary } from '@/lib/api'
import { buildSidebar } from '@/lib/sidebar'
import { tabLabels } from '@/lib/tablabels'
import type { Tab } from '@/lib/tabs'
import { HIDDEN_KEY, HIDDEN_SESSIONS_KEY, Sidebar, type SidebarProps } from './Sidebar'
import { flatRows } from './ProjectRow'
import { saveTodayCard, TODAY_FOLD_KEY, TODAY_SHOWN_KEY } from '@/lib/todayCard'

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
    // One line each, 38px with a 14px title, easy to read (a user,
    // 2026-10-15), with no agent mark; the state as a dot and a word.
    const row = document.querySelector('[data-live-row="w1"]')!
    expect(row.className).toContain('h-[38px]')
    expect(row.querySelector('[data-row-title]')!.className).toContain('text-[14px]')
    expect(row.querySelector('[aria-label="Claude Code"]')).toBeNull()
    expect(row.querySelector('[data-row-dot="working"]')).not.toBeNull()
    expect(row.querySelector('[data-state="working"]')!.textContent).toBe('working')
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
  it('lists every session in one flat list; a row names its project only in its tooltip and accessible name', () => {
    const onGroupedChange = vi.fn()
    setup(mix(), [], { grouped: false, onGroupedChange })
    expect(document.querySelector('[data-project-row]')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Sessions' })).toBeInTheDocument()
    const list = screen.getByRole('group', { name: 'Sessions' })
    expect([...list.querySelectorAll('[data-live-row]')].map((r) => r.getAttribute('data-live-row'))).toEqual(['w1', 'wt', 'i1', 'b1'])
    // ⌘N is a tab's: a row with no tab has no key.
    expect(list.querySelectorAll('[data-row-key-digit]')).toHaveLength(0)
    // The project is not drawn on the row (a user, 2026-10-15: the rows
    // were too small to read); a screen reader and the tooltip still say it.
    const b1 = list.querySelector<HTMLElement>('[data-live-row="b1"]')!
    expect(b1.querySelector('[data-row-project]')!.className).toContain('sr-only')
    expect(b1).toHaveAccessibleName(/beta/)
    expect(b1.title).toContain('beta')
    // Every row has its state dot, as under a project.
    expect(list.querySelectorAll('[data-row-dot]')).toHaveLength(4)
    // The switch says both choices in words, the one shown checked.
    const sw = screen.getByRole('radiogroup', { name: 'List sessions by' })
    expect(sw.textContent).toBe('ProjectsTabs')
    expect(screen.getByRole('radio', { name: 'Tabs' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('radio', { name: 'Tabs' }))
    expect(onGroupedChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('radio', { name: 'Projects' }))
    expect(onGroupedChange).toHaveBeenCalledWith(true)
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
    setup(mix(), tabs, { grouped: false, activeTabId: 'tw', tabDigits: new Map([['tw', 1], ['tb', 2]]) })
    const digitOf = (sel: string) => document.querySelector(`${sel} [data-row-key-digit]`)?.textContent
    // In front, the key stays beside the ×: every tab's row says its key.
    expect(document.querySelector('[data-tab-row="tw"] [data-row-key-digit]')!.className).not.toContain('hidden')
    expect(digitOf('[data-tab-row="tw"]')).toBe('⌘1')
    expect(digitOf('[data-tab-row="tb"]')).toBe('⌘2')
    expect(digitOf('[data-live-row="w1"]')).toBeUndefined()
  })

  // A user, 2026-10-14 (translated): "chats don't disappear when I close
  // them" — the closed tabs' agents ran on, and read as open chats.
  it('heads the sessions with no tab "Running, no tab", once, where the tabbed rows end; Tree has no such line', () => {
    const tabs: Tab[] = [{ id: 'tb', projectId: 'beta', root: pane('pb', 'session', 'b1'), focusedPaneId: 'pb', title: 'Beta work' }]
    setup(mix(), tabs, { grouped: false, tabDigits: new Map([['tb', 1]]) })
    const list = screen.getByRole('group', { name: 'Sessions' })
    const order = [...list.children].map((li) => li.hasAttribute('data-untabbed-heading') ? 'HEAD' : li.querySelector('[data-tab-row]') ? 'tab' : 'live')
    expect(order).toEqual(['tab', 'HEAD', 'live', 'live', 'live'])
    expect(list.querySelector('[data-untabbed-heading]')!.textContent).toBe('Running, no tab')
    cleanup()
    setup(mix(), tabs, { grouped: true })
    expect(document.querySelector('[data-untabbed-heading]')).toBeNull()
  })
})

// A user, 2026-10-15 (translated): "which tab am I working in?" The waiting
// row had a fill and an edge, as the tab in front did: two rows looked selected.
describe('one selected row', () => {
  it('is the tab in front alone; a row waiting in another project is marked by its amber dot and word, with no fill or edge of its own', () => {
    const tabs: Tab[] = [{ id: 'tb', projectId: 'beta', root: pane('pb', 'session', 'b1'), focusedPaneId: 'pb', title: 'Beta work' }]
    for (const grouped of [true, false]) {
      setup(mix(), tabs, { grouped, activeTabId: 'tb', tabDigits: new Map([['tb', 1]]) })
      const selected = [...document.querySelectorAll('.app-row-selected')]
      expect(selected).toHaveLength(1)
      expect(selected[0]).toHaveAttribute('data-tab-row', 'tb')
      expect(selected[0]).toHaveAttribute('aria-current', 'true')
      expect(selected[0]!.querySelector('[data-row-title]')!.className).toContain('font-semibold')
      expect(document.querySelectorAll('[aria-current="true"], [data-selected]')).toHaveLength(1)
      const wt = document.querySelector('[data-live-row="wt"]')!
      expect(wt).toHaveAttribute('data-waiting', 'true')
      expect(wt.className).not.toContain('app-row-selected')
      expect(wt.querySelector('[data-row-dot="waiting"]')!.className).toContain('bg-warn')
      expect(wt.querySelector('[data-state="waiting"]')!.className).toContain('text-warn')
      cleanup()
    }
  })
})

// A user, 2026-10-15 (translated): "can this be hidden? it's in the way".
describe('the Today card', () => {
  const route = { onRoute: vi.fn(), loaded: true }

  it('folds to one line by its chevron, with the waiting count in amber, and unfolds; the fold is remembered', () => {
    const summary = { cost_usd: 19.99, rate_limits: { five_hour: { used_percentage: 40, resets_at: Date.now() / 1000 + 3600 } } } as unknown as Summary
    setup(mix(), [], { ...route, summary })
    fireEvent.click(document.querySelector('[data-today-fold]')!)
    const card = screen.getByRole('region', { name: 'Today' })
    expect(card).toHaveAttribute('data-today-folded')
    expect(card.textContent).toMatch(/^\$19\.99 · 4 running · 1 waiting$/)
    // A thin 5-hour bar under the line.
    expect(within(card).getByRole('meter', { name: /5-hour window used/ })).toHaveAttribute('aria-valuenow', '40')
    expect(card.querySelector('[data-today-waiting]')!.className).toContain('text-warn')
    expect(localStorage.getItem(TODAY_FOLD_KEY)).toBe('closed')
    cleanup()
    setup(mix(), [], route)
    expect(screen.getByRole('region', { name: 'Today' })).toHaveAttribute('data-today-folded')
    fireEvent.click(document.querySelector('[data-today-unfold]')!)
    expect(screen.getByRole('region', { name: 'Today' })).not.toHaveAttribute('data-today-folded')
    expect(localStorage.getItem(TODAY_FOLD_KEY)).toBe('open')
  })

  it('hides from its menu, keeps what waits counted on the list heading, and comes back from Settings', () => {
    const { props } = setup(mix(), [], route)
    expect(document.querySelector('[data-head-waiting]')).toBeNull()
    fireEvent.contextMenu(screen.getByRole('region', { name: 'Today' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Hide this card/ }))
    expect(screen.queryByRole('region', { name: 'Today' })).toBeNull()
    expect(localStorage.getItem(TODAY_SHOWN_KEY)).toBe('off')
    // Nothing that needs you is lost: the count is beside the heading, and opens it.
    const head = document.querySelector<HTMLElement>('[data-head-waiting]')!
    expect(head.textContent).toBe('1')
    expect(head.className).toContain('bg-warn')
    fireEvent.click(head)
    expect(props.onOpenInbox).toHaveBeenCalled()
    // Hidden stays hidden on the next load.
    cleanup()
    setup(mix(), [], route)
    expect(screen.queryByRole('region', { name: 'Today' })).toBeNull()
    // Settings → Appearance's toggle (lib/todayCard) brings it back at once.
    act(() => saveTodayCard({ hidden: false }))
    expect(screen.getByRole('region', { name: 'Today' })).toBeInTheDocument()
    expect(document.querySelector('[data-head-waiting]')).toBeNull()
  })
})
