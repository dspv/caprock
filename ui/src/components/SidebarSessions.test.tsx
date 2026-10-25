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
import { recordClosed } from '@/lib/recentlyClosed'

Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })

const proj = (id: string): Project => ({ id, root: `/w/${id}`, name: id, kind: 'folder', last_activity: Date.now(), pinned: true })
const live = (p: Partial<SessionSummary>) => ({
  session_id: 's', cwd: '/w/alpha', project: 'alpha', model: '', started_at: 1, last_event_at: Date.now(), status: 'active',
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

// The owner's bug on 2026-10-16 (translated): "the tabs in the top strip
// don't match what's on the left". Every open tab has a row, Tree and Flat.
describe('every open tab has a row', () => {
  const tabs: Tab[] = [
    { id: 'ti', projectId: 'alpha', root: pane('pi', 'session', 'i1'), focusedPaneId: 'pi', title: 'Idle one' },
    { id: 'tb', projectId: 'beta', root: pane('pb', 'session', 'b1'), focusedPaneId: 'pb', title: 'Beta work' },
  ]
  for (const grouped of [true, false]) {
    it(`lists a hidden session and a hidden project that have a tab (${grouped ? 'Tree' : 'Flat'})`, () => {
      localStorage.setItem(HIDDEN_KEY, JSON.stringify({ beta: Date.now() }))
      localStorage.setItem(HIDDEN_SESSIONS_KEY, JSON.stringify({ i1: Date.now(), w1: Date.now() }))
      setup(mix(), tabs, { grouped })
      expect(document.querySelector('[data-tab-row="ti"]')).not.toBeNull()
      expect(document.querySelector('[data-tab-row="tb"]')).not.toBeNull()
      if (grouped) expect(document.querySelector('[data-project-row="beta"]')).not.toBeNull()
      // A hidden row with no tab stays hidden, under More… alone.
      expect(document.querySelector('[data-live-row="w1"]')).toBeNull()
      fireEvent.click(document.querySelector('[data-sidebar-more]')!)
      expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['Busy · alphashow'])
    })
  }
})

describe('group by project, off', () => {
  it('lists every session in one flat list; a row names its project only in its tooltip and accessible name', () => {
    const onGroupedChange = vi.fn()
    setup(mix(), [], { grouped: false, onGroupedChange })
    expect(document.querySelector('[data-project-row]')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Sessions' })).toBeInTheDocument()
    // No tab open: every row is under Running, no tab.
    const list = screen.getByRole('group', { name: 'Running, no tab' })
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
    // The tabbed rows, then the heading and the rows with no tab: two views of one order.
    const lists = [screen.getByRole('group', { name: 'Sessions' }), screen.getByRole('group', { name: 'Running, no tab' })]
    const order = lists.flatMap((list) => [...list.children]).map((li) => li.hasAttribute('data-untabbed-heading') ? 'HEAD' : li.querySelector('[data-tab-row]') ? 'tab' : 'live')
    expect(order).toEqual(['tab', 'HEAD', 'live', 'live', 'live'])
    expect(document.querySelectorAll('[data-untabbed-heading]')).toHaveLength(1)
    expect(document.querySelector('[data-untabbed-heading]')!.textContent).toBe('Running, no tab')
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

  const summary = {
    cost_usd: 19.99,
    rate_limits: {
      five_hour: { used_percentage: 6, resets_at: Date.now() / 1000 + 3600 },
      seven_day: { used_percentage: 74, resets_at: Date.now() / 1000 + 86400 },
    },
  } as unknown as Summary

  // Owner, 2026-10-25: from a session tab he could not find how to share.
  // One quiet icon, not the loud corner removed on 2026-10-16.
  it('has one quiet way to share the week, folded or not', () => {
    setup(mix(), [], { ...route, summary })
    const card = screen.getByRole('region', { name: 'Today' })
    const share = within(card).getByRole('button', { name: 'Share your week' })
    expect(share.textContent).toBe('')
    fireEvent.click(document.querySelector('[data-today-fold]')!)
    expect(within(screen.getByRole('region', { name: 'Today' })).getByRole('button', { name: 'Share your week' })).toBeTruthy()
  })

  it('folds to one line by its chevron, with the waiting count in amber and both windows, and unfolds; the fold is remembered', () => {
    setup(mix(), [], { ...route, summary })
    fireEvent.click(document.querySelector('[data-today-fold]')!)
    const card = screen.getByRole('region', { name: 'Today' })
    expect(card).toHaveAttribute('data-today-folded')
    expect(within(card).getByRole('button', { name: /Unfold the card/ }).textContent).toBe('$19.99 · 4 running · 1 waiting · 5h 6% · 7d 74%')
    expect(card.querySelector('[data-today-waiting]')!.className).toContain('text-warn')
    // 74% of the week is past the amber line, as the full card colours it.
    expect(card.querySelector('[data-today-window="7d"]')!.className).toContain('text-warn')
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
    fireEvent.click(screen.getByRole('menuitem', { name: /^Hide/ }))
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

  it('closes by its ×, from the full card and from the line, and stays closed', () => {
    setup(mix(), [], route)
    fireEvent.click(screen.getByRole('button', { name: 'Hide the Today card' }))
    expect(screen.queryByRole('region', { name: 'Today' })).toBeNull()
    expect(localStorage.getItem(TODAY_SHOWN_KEY)).toBe('off')
    act(() => saveTodayCard({ hidden: false, folded: true }))
    const card = screen.getByRole('region', { name: 'Today' })
    expect(card).toHaveAttribute('data-today-folded')
    fireEvent.click(within(card).getByRole('button', { name: 'Hide the Today card' }))
    expect(screen.queryByRole('region', { name: 'Today' })).toBeNull()
    cleanup()
    setup(mix(), [], route)
    expect(screen.queryByRole('region', { name: 'Today' })).toBeNull()
  })

  it('offers Full card, One line and Hide on right-click, and remembers the pick', () => {
    setup(mix(), [], { ...route, summary })
    fireEvent.contextMenu(screen.getByRole('region', { name: 'Today' }))
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Full cardshown', 'One line', 'HideSettings shows it'])
    fireEvent.click(screen.getByRole('menuitem', { name: /^One line/ }))
    expect(screen.getByRole('region', { name: 'Today' })).toHaveAttribute('data-today-folded')
    expect(localStorage.getItem(TODAY_FOLD_KEY)).toBe('closed')
    fireEvent.contextMenu(screen.getByRole('region', { name: 'Today' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Full card/ }))
    expect(screen.getByRole('region', { name: 'Today' })).not.toHaveAttribute('data-today-folded')
    expect(localStorage.getItem(TODAY_FOLD_KEY)).toBe('open')
  })

  it('shows the full card to a viewer who never chose', () => {
    localStorage.removeItem(TODAY_FOLD_KEY)
    localStorage.removeItem(TODAY_SHOWN_KEY)
    setup(mix(), [], route)
    expect(screen.getByRole('region', { name: 'Today' })).not.toHaveAttribute('data-today-folded')
  })
})

// Owner, 2026-10-20: two rows both said "Quick chat · ..." and could not be
// told apart. A chat's row says what it is about, its model quietly after,
// and, with no tab, when it started.
describe('a quick chat row', () => {
  const started = new Date(2026, 9, 19, 9, 40).getTime()
  const chat = (p: Partial<SessionSummary>) => live({ cwd: '/data/chats/2026-10-19-094012', project: 'chat', model_display: 'Opus 5.5', started_at: started, ...p })

  it('with no tab: its title, its start time and its model', () => {
    setup([chat({ session_id: 'c1', title: 'Monads, explained' })], [])
    const row = document.querySelector('[data-live-row="c1"]')!
    expect(row.querySelector('[data-row-title]')!.textContent).toBe('Monads, explained')
    expect(row.querySelector('[data-row-when]')!.textContent).toBe('19 Oct 09:40')
    expect(row.querySelector('[data-row-branch]')!.textContent).toBe('Opus 5.5')
  })

  it('before it has a title: "Quick chat · model" and the time, the model not said twice', () => {
    setup([chat({ session_id: 'c2' })], [])
    const row = document.querySelector('[data-live-row="c2"]')!
    expect(row.querySelector('[data-row-title]')!.textContent).toBe('Quick chat · Opus 5.5')
    expect(row.querySelector('[data-row-when]')!.textContent).toBe('19 Oct 09:40')
    expect(row.querySelector('[data-row-branch]')).toBeNull()
  })

  it('with a tab: its title and model, no time', () => {
    const t: Tab = { id: 't1', projectId: 'other-folders', title: 'Quick chat', focusedPaneId: 'a', root: pane('a', 'session', 'c3') }
    setup([chat({ session_id: 'c3', title: 'Monads, explained' })], [t])
    const row = document.querySelector('[data-tab-row="t1"]')!
    expect(row.querySelector('[data-row-title]')!.textContent).toBe('Monads, explained')
    expect(row.querySelector('[data-row-when]')).toBeNull()
    expect(row.querySelector('[data-row-branch]')!.textContent).toBe('Opus 5.5')
  })
})

// Owner, 2026-10-20: "Running, no tab" keeps what he started himself, titled,
// active in the last day; scouts, ops runs and helpers fold into one row.
describe('the Background row', () => {
  const H = 60 * 60 * 1000
  const background = () => [
    live({ session_id: 'mine', title: 'Vibe coding setup', started_at: 1, last_event_at: Date.now() - H, activity: idle }),
    live({ session_id: 'ops', cwd: '/private/var/folders/7k/x/T/ops-seo-site-66tben_l', project: 'ops', started_at: 2, activity: idle }),
    live({ session_id: 'scout', agent: 'codex', owned: false, started_at: 3, description_source: 'prompt', description: 'You are a scout.\nFind threads.\nRead only.\nOutput JSON.', activity: idle }),
    live({ session_id: 'old', title: 'Last week', started_at: 4, last_event_at: Date.now() - 30 * H, activity: { phrase: '', at: new Date(Date.now() - 30 * H).toISOString(), health: 'idle' } }),
  ]

  it('folds the rest into one closed row at the bottom, opened and remembered on a click', () => {
    setup(background(), [], { grouped: false })
    const running = screen.getByRole('group', { name: 'Running, no tab' })
    expect([...running.querySelectorAll('[data-live-row]')].map((r) => r.getAttribute('data-live-row'))).toEqual(['mine'])
    const toggle = document.querySelector<HTMLButtonElement>('[data-background-toggle]')!
    expect(toggle.textContent).toContain('Background · 3')
    expect(toggle.textContent).toContain('scouts, ops, helpers')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('group', { name: 'Background' })).toBeNull()
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const bg = screen.getByRole('group', { name: 'Background' })
    expect([...bg.querySelectorAll('[data-live-row]')].map((r) => r.getAttribute('data-live-row'))).toEqual(['ops', 'scout', 'old'])
    // Kept per browser: a new sidebar opens it again.
    cleanup()
    setup(background(), [], { grouped: false })
    expect(document.querySelector('[data-background-toggle]')).toHaveAttribute('aria-expanded', 'true')
  })

  it('heads the fold with Running, no tab when nothing else runs without a tab; Tree has no fold', () => {
    setup(background().slice(1), [], { grouped: false })
    expect(document.querySelector('[data-untabbed-heading]')!.textContent).toBe('Running, no tab')
    expect(screen.queryByRole('group', { name: 'Running, no tab' })).toBeNull()
    expect(document.querySelector('[data-background-toggle]')!.textContent).toContain('Background · 3')
    cleanup()
    setup(background(), [], { grouped: true })
    expect(document.querySelector('[data-background-toggle]')).toBeNull()
  })
})

describe('Recently closed', () => {
  const closed = (id: string, title: string, minsAgo: number) => ({ sessionId: id, title, projectId: 'alpha', cwd: '/w/alpha', closedAt: Date.now() - minsAgo * 60_000 })
  const store = (list: unknown[]) => localStorage.setItem('caprock.app.recently-closed', JSON.stringify(list))

  for (const grouped of [true, false]) {
    it(`lists the last five closed, newest first, with a quiet age, and reopens one on a click (${grouped ? 'Tree' : 'Flat'})`, () => {
      store([closed('c1', 'Fix login', 2), closed('c2', 'Docs pass', 61), closed('c3', 'Three', 70), closed('c4', 'Four', 80), closed('c5', 'Five', 90), closed('c6', 'Six', 100)])
      const onReopenClosed = vi.fn()
      const onRoute = vi.fn()
      setup(mix(), [], { grouped, onReopenClosed, onRoute })
      const section = screen.getByRole('region', { name: 'Recently closed' })
      const rowsHere = [...section.querySelectorAll('[data-closed-row]')]
      expect(rowsHere.map((r) => r.getAttribute('data-closed-row'))).toEqual(['c1', 'c2', 'c3', 'c4', 'c5'])
      expect(rowsHere[0]!.querySelector('[data-closed-ago]')!.textContent).toBe('2 min')
      expect(rowsHere[1]!.querySelector('[data-closed-ago]')!.textContent).toBe('1 h')
      // The newest says its key.
      expect((rowsHere[0] as HTMLElement).title).toContain('⇧⌘T')
      fireEvent.click(rowsHere[1]!)
      expect(onReopenClosed).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'c2', title: 'Docs pass' }))
      fireEvent.click(within(section).getByRole('button', { name: 'Show all in History' }))
      expect(onRoute).toHaveBeenCalledWith('#/history')
    })
  }

  it('sits above Running, no tab in the Flat list, after the tabbed rows', () => {
    store([closed('c1', 'Fix login', 2)])
    const tabs: Tab[] = [{ id: 'tb', projectId: 'beta', root: pane('pb', 'session', 'b1'), focusedPaneId: 'pb', title: 'Beta work' }]
    setup(mix(), tabs, { grouped: false, onReopenClosed: vi.fn() })
    const order = [...document.querySelectorAll('[data-tab-row], [data-recently-closed], [data-untabbed-heading]')]
      .map((el) => el.hasAttribute('data-tab-row') ? 'tab' : el.hasAttribute('data-recently-closed') ? 'closed' : 'running')
    expect(order).toEqual(['tab', 'closed', 'running'])
  })

  it('is hidden when empty, and leaves out a session that has a tab again', () => {
    setup(mix(), [], { grouped: false, onReopenClosed: vi.fn() })
    expect(screen.queryByRole('region', { name: 'Recently closed' })).toBeNull()
    cleanup()
    store([closed('b1', 'Beta work', 5)])
    const tabs: Tab[] = [{ id: 'tb', projectId: 'beta', root: pane('pb', 'session', 'b1'), focusedPaneId: 'pb', title: 'Beta work' }]
    setup(mix(), tabs, { grouped: false, onReopenClosed: vi.fn() })
    expect(screen.queryByRole('region', { name: 'Recently closed' })).toBeNull()
  })

  it('follows the list as tabs close', () => {
    setup(mix(), [], { grouped: false, onReopenClosed: vi.fn() })
    act(() => { recordClosed([closed('c9', 'Just closed', 0)]) })
    expect(screen.getByRole('region', { name: 'Recently closed' }).textContent).toContain('Just closed')
  })
})

// Owner, 2026-10-21: an untabbed session Caprock ends for sitting idle says so
// in one line where its row was, and a click continues it; it does not vanish.
describe('a session ended for sitting idle', () => {
  const ended = (p: Partial<SessionSummary>) => live({
    status: 'ended', activity: { phrase: '', at: '', health: 'ended' }, last_event_at: Date.now() - 13 * 3_600_000,
    idle_ended_at: Date.now() - 60_000, idle_ended_after_ms: 12 * 3_600_000, ...p,
  })

  it('stays under Running, no tab for a day, reading "12 h idle · continue", and a click opens it to continue', () => {
    const sessions = [live({ session_id: 'w1', title: 'Busy' }), ended({ session_id: 'z1', title: 'Old chat', started_at: 2 }),
      ended({ session_id: 'z2', title: 'Long gone', started_at: 3, idle_ended_at: Date.now() - 25 * 3_600_000 }),
      live({ session_id: 'e1', title: 'Done one', status: 'ended', started_at: 4, activity: { phrase: '', at: '', health: 'ended' } })]
    const { props } = setup(sessions, [], { grouped: false })
    const list = screen.getByRole('group', { name: 'Running, no tab' })
    expect([...list.querySelectorAll('[data-live-row]')].map((r) => r.getAttribute('data-live-row'))).toEqual(['w1', 'z1'])
    const row = list.querySelector<HTMLElement>('[data-live-row="z1"]')!
    expect(row.querySelector('[data-idle-ended]')!.textContent).toBe('12 h idle · continue')
    expect(row.title).toContain('Ended after 12 h idle — click to continue it.')
    // No stop on an ended row; its × still hides it.
    expect(row.parentElement!.querySelector('[aria-label^="Stop"]')).toBeNull()
    fireEvent.click(row)
    expect(props.onOpenLive).toHaveBeenCalledWith(expect.objectContaining({ session_id: 'z1' }), 'alpha')
  })

  it('is listed under its project in Tree too', () => {
    setup([ended({ session_id: 'z1', title: 'Old chat' })], [], { grouped: true })
    const alpha = screen.getByRole('group', { name: 'alpha: sessions' })
    expect(alpha.querySelector('[data-live-row="z1"] [data-idle-ended]')!.textContent).toBe('12 h idle · continue')
  })
})

