/**
 * The tab strip reorders by pointer events: in the desktop app the shell's
 * native drop handler takes every drag over the window, so an HTML5
 * dragover or drop never reaches the page (.ai/21-app.md § Dropping a file).
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TabProject, TabStrip, TerminalStack } from './TerminalTabs'
import type { Tab } from '@/lib/tabs'
import type { SessionSummary } from '@/lib/api'
import { setComposerEnabled } from '@/lib/composer'

// These read the labels in their macOS spelling; lib/appkeys.test.ts covers
// Windows and Linux.
Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })

// A pane that counts its renders: xterm is beside the point here.
const panes = vi.hoisted(() => ({ renders: new Map<string, number>(), composer: new Map<string, unknown>(), quick: new Map<string, boolean>() }))
vi.mock('./TerminalPane', () => ({
  TerminalPane: ({ sessionId, composer, quickReplies }: { sessionId: string; composer?: unknown; quickReplies?: boolean }) => {
    panes.renders.set(sessionId, (panes.renders.get(sessionId) ?? 0) + 1)
    panes.composer.set(sessionId, composer)
    panes.quick.set(sessionId, !!quickReplies)
    return null
  },
}))

const tab = (id: string): Tab => ({
  id,
  projectId: 'p',
  root: { type: 'pane', id: `${id}-pane`, target: { kind: 'shell', sessionId: id } },
  focusedPaneId: `${id}-pane`,
  title: id,
})

function strip() {
  const onMove = vi.fn()
  const onActivate = vi.fn()
  render(
    <TabStrip
      tabs={[tab('one'), tab('two'), tab('three')]}
      activeTabId="one"
      sessions={new Map()}
      permissions={new Set()}
      inspectorOpen={false}
      sidebarOpen
      onActivate={onActivate}
      onDetach={() => {}}
      onMove={onMove}
      onNewAgent={() => {}}
      onNewShell={() => {}}
      onToggleInspector={() => {}}
    />,
  )
  const tabs = screen.getAllByRole('tab')
  return { onMove, onActivate, tabs }
}

describe('TabStrip', () => {
  const original = document.elementFromPoint
  afterEach(() => { document.elementFromPoint = original })

  it('moves a tab dragged with the pointer onto another, without activating it', () => {
    const { onMove, onActivate, tabs } = strip()
    expect(tabs[0]!.getAttribute('draggable')).toBeNull()
    document.elementFromPoint = () => tabs[2]!
    fireEvent.pointerDown(tabs[0]!, { button: 0, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(window, { clientX: 60, clientY: 12 })
    expect(tabs[0]!.dataset.dragging).toBe('true')
    fireEvent.pointerUp(window, { clientX: 300, clientY: 12 })
    fireEvent.click(tabs[0]!)
    expect(onMove).toHaveBeenCalledWith('one', 2)
    expect(onActivate).not.toHaveBeenCalled()
    expect(tabs[0]!.dataset.dragging).toBeUndefined()
  })

  // Owner, 2026-10-09: tabs were barely noticeable. The one in front is the
  // framed, amber-edged surface; each other is a filled tab of its own.
  it('marks the tab in front apart from the rest, and offers + as a menu', () => {
    const { tabs } = strip()
    expect(tabs[0]).toHaveClass('app-tab-front')
    expect(tabs[1]).toHaveClass('app-tab-back')
    expect(tabs[1]).not.toHaveClass('app-tab-front')
    expect(screen.queryByRole('button', { name: /New shell/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'New' })).toHaveAttribute('aria-haspopup', 'menu')
  })

  it('sets the pinned Dashboard tab apart from the sessions', () => {
    render(
      <TabStrip
        tabs={[tab('one')]}
        activeTabId="one"
        dashboard={{ active: false, label: 'Dashboard', onActivate: () => {}, onClose: () => {} }}
        sessions={new Map()}
        permissions={new Set()}
        inspectorOpen={false}
        sidebarOpen
        onActivate={() => {}}
        onDetach={() => {}}
        onMove={() => {}}
        onNewAgent={() => {}}
        onNewShell={() => {}}
        onToggleInspector={() => {}}
      />,
    )
    const dash = screen.getByRole('tab', { name: /Dashboard/ })
    expect(dash).toHaveClass('app-tab-dash')
    expect(dash).not.toHaveClass('app-tab-back')
  })

  it('takes a press that barely moves for a click', () => {
    const { onMove, onActivate, tabs } = strip()
    document.elementFromPoint = () => tabs[2]!
    fireEvent.pointerDown(tabs[1]!, { button: 0, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(window, { clientX: 12, clientY: 11 })
    fireEvent.pointerUp(window, { clientX: 12, clientY: 11 })
    fireEvent.click(tabs[1]!)
    expect(onMove).not.toHaveBeenCalled()
    expect(onActivate).toHaveBeenCalledWith('two')
  })
})

describe('a file tab', () => {
  const fileTab: Tab = {
    id: 'f',
    projectId: '7',
    root: { type: 'pane', id: 'f-pane', target: { kind: 'file', sessionId: 'file:7::docs/app.md', path: 'docs/app.md', worktree: '' } },
    focusedPaneId: 'f-pane',
    title: 'app.md',
  }

  it('is named by the file, with the whole path as its tooltip', () => {
    render(
      <TabStrip
        tabs={[fileTab]}
        activeTabId="f"
        sessions={new Map()}
        permissions={new Set()}
        inspectorOpen={false}
        sidebarOpen
        onActivate={() => {}}
        onDetach={() => {}}
        onMove={() => {}}
        onNewAgent={() => {}}
        onNewShell={() => {}}
        onToggleInspector={() => {}}
      />,
    )
    const t = screen.getByRole('tab')
    expect(t.textContent).toContain('app.md')
    // No key: ⌘1–⌘9 are projects, drawn on a tab only when given (digits).
    expect(t.getAttribute('title')).toBe('docs/app.md')
    expect(screen.getByRole('button', { name: 'Close tab app.md' })).toBeInTheDocument()
  })

  // Owner, 2026-10-13 (translated): "I have only four tabs and already
  // can't see the 4th one's title. I don't care which agent it is … the
  // session name is very important."
  it('names a session tab by its session, the project its coloured short name and the agent only in the tooltip', () => {
    const other: Tab = { ...tab('solo'), projectId: 'q' }
    render(
      <TabStrip
        tabs={[tab('one'), tab('two'), other]}
        activeTabId="one"
        sessions={new Map()}
        permissions={new Set()}
        projectName={(id) => (id === 'p' ? 'caprock' : 'caprock-web')}
        inspectorOpen={false}
        sidebarOpen
        onActivate={() => {}}
        onDetach={() => {}}
        onMove={() => {}}
        onNewAgent={() => {}}
        onNewShell={() => {}}
        onToggleInspector={() => {}}
      />,
    )
    const [one, , solo] = screen.getAllByRole('tab') as [HTMLElement, HTMLElement, HTMLElement]
    expect(one.querySelector('[data-row-title]')?.textContent).toBe('Shell 1')
    expect(solo.querySelector('[data-row-title]')?.textContent).toBe('Shell 1')
    // No dots (owner, 2026-10-14, translated: "the indicators tell me nothing at all").
    expect(one.querySelector('[data-project-dot], [role="img"]')).toBeNull()
    expect(one.querySelector('[data-tab-project]')!.textContent).toBe('caprock')
    expect((one.querySelector('[data-tab-project]') as HTMLElement).style.color).not.toBe('')
    expect(one.getAttribute('aria-label')).toBe('Shell 1 · caprock')
    expect(solo.getAttribute('aria-label')).toBe('Shell 1 · caprock-web')
    // No agent mark on the tab; it is named in the tooltip.
    expect(one.querySelector('[aria-label="Shell"], [aria-label="Claude Code"]')).toBeNull()
    expect(one.getAttribute('title')).toBe('Shell 1 · Shell · caprock')
    expect(one.querySelector('[data-tab-subtitle], [data-project-chip]')).toBeNull()
  })

  // Owner, 2026-10-14 (translated): "The indicators tell me nothing at all,
  // literally zero." A tab shows state only when it asks something of you.
  it('marks a tab with a dot only when its session waits on you (amber) or failed (red); working and idle show nothing', () => {
    const agentTab = (id: string): Tab => ({ ...tab(id), root: { type: 'pane', id: `${id}-pane`, target: { kind: 'session', sessionId: id } } })
    const sess = (id: string, health?: string): SessionSummary =>
      ({ session_id: id, owned: true, status: 'active', kind: 'agent', agent: 'claude', title: id, ...(health ? { activity: { phrase: '', at: '', health } } : {}) }) as SessionSummary
    render(
      <TabStrip
        tabs={['asks', 'waits', 'broke', 'works', 'rests'].map(agentTab)}
        activeTabId="works"
        sessions={new Map([['asks', sess('asks')], ['waits', sess('waits', 'waiting-on-you')], ['broke', sess('broke', 'error')], ['works', sess('works', 'working')], ['rests', sess('rests')]])}
        permissions={new Set(['asks'])}
        projectName={() => 'caprock'}
        inspectorOpen={false}
        sidebarOpen
        onActivate={() => {}}
        onDetach={() => {}}
        onMove={() => {}}
        onNewAgent={() => {}}
        onNewShell={() => {}}
        onToggleInspector={() => {}}
      />,
    )
    const alertOf = (i: number) => screen.getAllByRole('tab')[i]!.querySelector('[data-tab-alert]')?.getAttribute('data-tab-alert') ?? null
    expect([0, 1, 2, 3, 4].map(alertOf)).toEqual(['waiting', 'waiting', 'error', null, null])
    expect(screen.getAllByRole('tab')[0]!.querySelector('[data-tab-alert]')!.className).toContain('bg-warn')
    expect(screen.getAllByRole('tab')[2]!.querySelector('[data-tab-alert]')!.className).toContain('bg-danger')
    expect(screen.getAllByRole('tab')[1]!.getAttribute('title')).toContain('— waiting on you')
    expect(screen.getAllByRole('tab')[2]!.getAttribute('aria-description')).toBe('failed')
    expect(document.querySelectorAll('[role="tab"] [role="img"]')).toHaveLength(0)
  })

  // Owner, 2026-10-15 (translated): "I don't understand where I am, it's
  // impossible" — waiting tabs wore the front tab's accent bar.
  it('looks selected on the tab in front alone: a waiting or looping tab is a dot, never the bar', () => {
    const agentTab = (id: string): Tab => ({ ...tab(id), root: { type: 'pane', id: `${id}-pane`, target: { kind: 'session', sessionId: id } } })
    const sess = (id: string, health?: string): SessionSummary =>
      ({ session_id: id, owned: true, status: 'active', kind: 'agent', agent: 'claude', title: id, ...(health ? { activity: { phrase: '', at: '', health } } : {}) }) as SessionSummary
    render(
      <TabStrip
        tabs={['front', 'w1', 'w2', 'w3', 'loops'].map(agentTab)}
        activeTabId="front"
        digits={new Map([['front', 1], ['w1', 2], ['w2', 3], ['w3', 4], ['loops', 5]])}
        sessions={new Map([['front', sess('front', 'working')], ['w1', sess('w1', 'waiting-on-you')], ['w2', sess('w2', 'waiting-on-you')], ['w3', sess('w3', 'waiting-on-you')], ['loops', sess('loops', 'looping')]])}
        permissions={new Set()}
        projectName={() => 'caprock'}
        inspectorOpen={false}
        sidebarOpen
        onActivate={() => {}}
        onDetach={() => {}}
        onMove={() => {}}
        onNewAgent={() => {}}
        onNewShell={() => {}}
        onToggleInspector={() => {}}
      />,
    )
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'false', 'false'])
    expect(tabs.map((t) => t.classList.contains('app-tab-front'))).toEqual([true, false, false, false, false])
    expect(document.querySelectorAll('.app-tab-front')).toHaveLength(1)
    expect(tabs[0]!.className).toContain('font-semibold')
    expect(tabs[0]!.className).toContain('min-w-[232px]')
    expect(tabs[0]!.querySelector('[data-row-title]')!.className).toContain('min-w-[16ch]')
    for (const t of tabs.slice(1)) {
      expect(t.className).toContain('app-tab-back')
      expect(t.className).not.toContain('font-semibold')
    }
    // Waiting is an amber dot before the title; looping a red one. No bar.
    expect(tabs.slice(1, 4).map((t) => t.querySelector('[data-tab-alert]')!.className)).toEqual(Array(3).fill(expect.stringContaining('bg-warn')))
    expect(tabs[4]!.querySelector('[data-tab-alert="looping"]')!.className).toContain('bg-danger')
    expect(tabs[4]!.getAttribute('aria-description')).toBe('looping')
    for (const t of tabs) {
      const dot = t.querySelector('[data-tab-alert]')
      if (dot) expect(dot.className).not.toMatch(/absolute|top-0|h-\[3px\]|bg-accent/)
      if (dot) expect(dot.compareDocumentPosition(t.querySelector('[data-row-title]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
  })

  // Owner, 2026-10-14 (translated): "not every tab shows the key combination".
  it('puts the jump key in the ×\'s slot at the right end on every tab: the × on hover, and beside the key in front', () => {
    render(
      <TabStrip
        tabs={[tab('one'), tab('two')]}
        activeTabId="one"
        digits={new Map([['one', 1], ['two', 2]])}
        sessions={new Map()}
        permissions={new Set()}
        projectName={() => 'caprock'}
        inspectorOpen={false}
        sidebarOpen
        onActivate={() => {}}
        onDetach={() => {}}
        onMove={() => {}}
        onNewAgent={() => {}}
        onNewShell={() => {}}
        onToggleInspector={() => {}}
        dashboard={{ active: false, label: 'Dashboard', onActivate: () => {}, onClose: () => {} }}
      />,
    )
    const [one, two] = screen.getAllByRole('tab').filter((t) => t.hasAttribute('data-tab-index')) as [HTMLElement, HTMLElement]
    for (const t of [one, two]) {
      const end = t.querySelector('[data-tab-end]')!
      // The slot is the tab's last child: nothing after it, the title before it.
      expect(t.lastElementChild).toBe(end)
      expect(end.querySelector('[data-tab-key]')!.className).toContain('app-kbd-sm')
    }
    // In front: the key and the × side by side; behind: the key, the × over it on hover.
    expect(one.querySelector('[data-tab-key]')!.className).not.toContain('invisible')
    expect(one.querySelector('[data-tab-key]')!.textContent).toBe('⌘1')
    expect(one.querySelector('[data-tab-end] button')!.className).not.toContain('invisible')
    expect(one.querySelector('[data-tab-end] button')!.className).not.toContain('absolute')
    expect(two.querySelector('[data-tab-end] button')!.className).toContain('absolute')
    expect(two.querySelector('[data-tab-key]')!.className).toContain('group-hover:invisible')
    expect(two.querySelector('[data-tab-end] button')!.className).toContain('invisible group-hover:visible')
    expect(two.getAttribute('title')).toContain('— ⌘2')
    // The Dashboard tab is its icon and its key, drawn as a tab's (owner,
    // 2026-10-14, translated: "I must always see the key combinations next
    // to the tabs"); no × while it is behind.
    const dash = document.querySelector('[data-dashboard-tab]')!
    expect(dash.querySelector('[data-tab-key]')!.textContent).toBe('⌘0')
    expect(dash.querySelector('[data-tab-key]')!.className).toBe('app-kbd-sm')
    expect(dash.getAttribute('title')).toBe('Dashboard — ⌘0; ⌘0 again: Home, at its top')
    expect(screen.getByRole('button', { name: 'Close tab Dashboard' }).className).toContain('hidden')
    // The inspector's button says its key, as Deck does.
    expect(screen.getByRole('button', { name: 'Inspector (⌘I)' }).querySelector('[data-strip-key]')!.textContent).toBe('⌘I')
  })

  it('draws the pinned tab\'s key in front and behind, ⌘, for Settings, and Ctrl+Shift off macOS', () => {
    const strip = (active: boolean, label: string) => render(
      <TabStrip tabs={[]} activeTabId={undefined} sessions={new Map()} permissions={new Set()} inspectorOpen={false} sidebarOpen
        onActivate={() => {}} onDetach={() => {}} onMove={() => {}} onNewAgent={() => {}} onNewShell={() => {}} onToggleInspector={() => {}}
        dashboard={{ active, label, onActivate: () => {}, onClose: () => {} }} />,
    )
    const keyOf = () => document.querySelector('[data-dashboard-tab] [data-tab-key]')?.textContent
    const a = strip(true, 'Dashboard')
    expect(keyOf()).toBe('⌘0')
    a.unmount()
    const b = strip(false, 'Settings')
    expect(keyOf()).toBe('⌘,')
    b.unmount()
    const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32')
    try {
      const c = strip(false, 'Dashboard')
      expect(keyOf()).toBe('Ctrl+Shift+0')
      c.unmount()
      strip(true, 'Settings')
      expect(keyOf()).toBe('Ctrl+Shift+,')
    } finally {
      platform.mockRestore()
    }
  })

  // Owner, 2026-10-15, translated: "as a separate page with its own tab —
  // among the system tabs, next to the dashboard".
  it('pins the Pipeline tab right after the Dashboard tab and before Mail, folded to its glyph and ⌘P', () => {
    const onActivate = vi.fn()
    const onClose = vi.fn()
    const draw = (active: boolean) => render(
      <TabStrip tabs={[tab('one')]} activeTabId={undefined} sessions={new Map()} permissions={new Set()} inspectorOpen={false} sidebarOpen
        onActivate={() => {}} onDetach={() => {}} onMove={() => {}} onNewAgent={() => {}} onNewShell={() => {}} onToggleInspector={() => {}}
        dashboard={{ active: false, label: 'Dashboard', onActivate: () => {}, onClose: () => {} }}
        pipeline={{ active, onActivate, onClose }}
        mail={{ active: false, onActivate: () => {}, onClose: () => {} }} />,
    )
    const a = draw(true)
    const pinned = screen.getAllByRole('tab').map((t) => t.getAttribute('aria-label') ?? t.getAttribute('data-tab-index'))
    expect(pinned).toEqual(['Dashboard', 'Pipeline', 'Mail', '0'])
    const p = document.querySelector('[data-pipeline-tab]')!
    expect(p).toHaveAttribute('aria-selected', 'true')
    expect(p.querySelector('[data-tab-key]')!.textContent).toBe('⌘P')
    expect(p.getAttribute('title')).toBe('Pipeline — ⌘P; ⌘P again: back to where you were')
    expect(p.querySelector('svg')).toBeTruthy()
    // Its name is not drawn, only its glyph and key; the × shows while it is in front.
    expect(p.textContent).toBe('⌘P')
    expect(screen.getByRole('button', { name: 'Close tab Pipeline' }).className).toContain('flex')
    fireEvent.click(p)
    expect(onActivate).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Close tab Pipeline' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onActivate).toHaveBeenCalledTimes(1)
    a.unmount()
    const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Linux x86_64')
    try {
      draw(false)
      expect(document.querySelector('[data-pipeline-tab] [data-tab-key]')!.textContent).toBe('Ctrl+Shift+P')
      expect(document.querySelector('[data-pipeline-tab]')).toHaveAttribute('aria-keyshortcuts', 'Control+Shift+P')
      expect(screen.getByRole('button', { name: 'Close tab Pipeline' }).className).toContain('hidden')
    } finally {
      platform.mockRestore()
    }
  })

  it('shows what the workspace draws for a file, not a terminal', () => {
    const renderFile = vi.fn((_t: Tab, leaf: { target: { path?: string } }, visible: boolean) => <p>{`${leaf.target.path} ${visible ? 'in front' : 'behind'}`}</p>)
    render(<TerminalStack tabs={[fileTab]} visibleTabId="f" renderFile={renderFile} />)
    expect(screen.getByText('docs/app.md in front')).toBeInTheDocument()
    expect(document.querySelector('[data-tab-panel="f"]')!.className).not.toContain('app-slab')
  })
})

describe('TerminalStack', () => {
  it('does not redraw a terminal when only the session list or the callbacks change', () => {
    panes.renders.clear()
    const tabs = [tab('one'), tab('two'), tab('three')]
    const props = (n: number) => ({
      tabs,
      visibleTabId: 'one',
      // What the workspace hands down each time a session's row moves: a new
      // map and new callbacks.
      sessions: new Map<string, SessionSummary>([[`s${n}`, { session_id: `s${n}` } as SessionSummary]]),
      permissions: new Set<string>(),
      onPaneStatus: () => {},
      onPaneExit: () => {},
    })
    const { rerender } = render(<TerminalStack {...props(0)} />)
    for (let i = 1; i <= 5; i++) rerender(<TerminalStack {...props(i)} />)
    expect([...panes.renders.values()]).toEqual([1, 1, 1])
    // Bringing another tab forward redraws the two whose state changed.
    rerender(<TerminalStack {...props(6)} visibleTabId="two" />)
    expect(panes.renders.get('one')).toBe(2)
    expect(panes.renders.get('two')).toBe(2)
    expect(panes.renders.get('three')).toBe(1)
  })
})

describe('TerminalStack composer', () => {
  afterEach(() => setComposerEnabled(false))
  const agentTab = (id: string): Tab => ({ ...tab(id), root: { type: 'pane', id: `${id}-pane`, target: { kind: 'session', sessionId: id } } })
  const session = (id: string, over: Partial<SessionSummary>): SessionSummary =>
    ({ session_id: id, owned: true, status: 'working', kind: 'agent', agent: 'claude', ...over }) as SessionSummary
  const stack = () => (
    <TerminalStack
      tabs={[agentTab('mine'), agentTab('theirs'), tab('sh'), agentTab('gone')]}
      visibleTabId="mine"
      sessions={new Map([
        ['mine', session('mine', {})],
        ['theirs', session('theirs', { owned: false })],
        ['sh', session('sh', { kind: 'shell' })],
        ['gone', session('gone', { status: 'ended' })],
      ])}
      permissions={new Set(['mine'])}
    />
  )

  it('gives no pane a composer while it is off', () => {
    panes.composer.clear()
    render(stack())
    expect([...panes.composer.values()]).toEqual([undefined, undefined, undefined, undefined])
  })

  it('when on, gives one only to a live agent Caprock started (rule 7), never to a shell', () => {
    setComposerEnabled(true)
    panes.composer.clear()
    render(stack())
    expect(panes.composer.get('mine')).toEqual({ agent: 'claude', asking: true })
    expect(panes.composer.get('theirs')).toBeUndefined()
    expect(panes.composer.get('sh')).toBeUndefined()
    expect(panes.composer.get('gone')).toBeUndefined()
  })

  it('gives quick replies to a live agent Caprock started, composer or not, and to no session it only watches (rule 7)', () => {
    for (const on of [false, true]) {
      setComposerEnabled(on)
      panes.quick.clear()
      const { unmount } = render(stack())
      expect(Object.fromEntries(panes.quick)).toEqual({ mine: true, theirs: false, sh: false, gone: false })
      unmount()
    }
  })
})

// Owner, 2026-10-14 (translated): "The repo name on the right doesn't fit — it
// must fit, at least scroll inside on hover … it shouldn't be shortened; give
// it more space. The session name is fine."
describe("a tab's project name", () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('is never capped short: on a tab behind, the title gives way first, and the tooltip names both in full', () => {
    render(
      <TabStrip
        tabs={[tab('one'), tab('two')]}
        activeTabId="two"
        sessions={new Map()}
        permissions={new Set()}
        projectName={() => 'uncensored-chat-app'}
        inspectorOpen={false}
        sidebarOpen
        onActivate={() => {}}
        onDetach={() => {}}
        onMove={() => {}}
        onNewAgent={() => {}}
        onNewShell={() => {}}
        onToggleInspector={() => {}}
      />,
    )
    const [one, two] = screen.getAllByRole('tab') as [HTMLElement, HTMLElement]
    const project = one.querySelector('[data-tab-project]') as HTMLElement
    expect(project.textContent).toBe('uncensored-chat-app')
    // The tab in front keeps 16 characters of its title; its project is
    // what gives way there (2026-10-15: its title read "ca…").
    expect(two.querySelector('[data-row-title]')!.className).toMatch(/min-w-\[16ch\]/)
    // No cap of its own (it was max-w-[9ch]): it shrinks only once the title
    // is down to its few letters.
    expect(project.className).not.toMatch(/max-w/)
    expect(project.className).toMatch(/\bshrink-\[4\]/)
    const title = one.querySelector('[data-row-title]') as HTMLElement
    expect(title.className).toMatch(/min-w-\[4ch\]/)
    expect(title.className).toMatch(/flex-1/)
    expect(one.getAttribute('title')).toContain('Shell 1')
    expect(one.getAttribute('title')).toContain('uncensored-chat-app')
  })

  it('scrolls on hover only when its text is wider than its box, by exactly the hidden part', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(150)
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(60)
    const { unmount } = render(<TabProject name="payments-service-gateway" hue={120} />)
    const cut = document.querySelector('[data-tab-project]') as HTMLElement
    expect(cut.hasAttribute('data-overflow')).toBe(true)
    expect(cut.style.getPropertyValue('--tab-project-shift')).toBe('90px')
    expect(cut.textContent).toBe('payments-service-gateway')
    unmount()

    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(40)
    render(<TabProject name="atlas" hue={120} />)
    const whole = document.querySelector('[data-tab-project]') as HTMLElement
    expect(whole.hasAttribute('data-overflow')).toBe(false)
    expect(whole.style.getPropertyValue('--tab-project-shift')).toBe('0px')
  })
})

// ADR-075: a browser tab sits in the strip apart from the agents: a globe, its
// title, no key, no project; and its panel is the page view, not a terminal.
describe('a page tab', () => {
  const pageTab = (id: string, url: string, title: string): Tab => ({
    id,
    projectId: 'p',
    root: { type: 'pane', id: `${id}-pane`, target: { kind: 'page', sessionId: `page:${id}`, url } },
    focusedPaneId: `${id}-pane`,
    title,
  })

  it('reads as a page, never an agent, after a divider', () => {
    const onDetach = vi.fn()
    render(
      <TabStrip
        tabs={[tab('one'), pageTab('w', 'http://localhost:5173/', 'Vite App')]}
        activeTabId="one"
        projectName={() => 'caprock'}
        digits={new Map([['one', 1]])}
        sessions={new Map()}
        permissions={new Set()}
        inspectorOpen={false}
        sidebarOpen
        onActivate={() => {}}
        onDetach={onDetach}
        onMove={() => {}}
        onNewAgent={() => {}}
        onNewShell={() => {}}
        onToggleInspector={() => {}}
      />,
    )
    const page = screen.getByRole('tab', { name: 'Browser · Vite App' })
    expect(page.hasAttribute('data-page-tab')).toBe(true)
    expect(page.className).toContain('app-tab-page-first')
    expect(page.getAttribute('title')).toContain('http://localhost:5173/')
    expect(page.querySelector('[data-tab-key]')).toBeNull()
    expect(page.querySelector('[data-tab-project]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Close browser tab Vite App' }))
    expect(onDetach).toHaveBeenCalledWith('w')
  })

  it('shows the page view in its panel, never a terminal', () => {
    const renderPage = vi.fn(() => <div data-testid="page" />)
    render(<TerminalStack tabs={[pageTab('w', 'https://example.com/', 'Example')]} visibleTabId="w" renderPage={renderPage} />)
    expect(screen.getByTestId('page')).toBeTruthy()
    expect(renderPage).toHaveBeenCalledWith(expect.objectContaining({ id: 'w' }), expect.objectContaining({ id: 'w-pane' }), true)
    expect(panes.renders.has('page:w')).toBe(false)
  })
})
