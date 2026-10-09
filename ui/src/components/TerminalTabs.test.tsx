/**
 * The tab strip reorders by pointer events: in the desktop app the shell's
 * native drop handler takes every drag over the window, so an HTML5
 * dragover or drop never reaches the page (.ai/21-app.md § Dropping a file).
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TabStrip, TerminalStack } from './TerminalTabs'
import type { Tab } from '@/lib/tabs'
import type { SessionSummary } from '@/lib/api'

// A pane that counts its renders: xterm is beside the point here.
const panes = vi.hoisted(() => ({ renders: new Map<string, number>() }))
vi.mock('./TerminalPane', () => ({
  TerminalPane: ({ sessionId }: { sessionId: string }) => {
    panes.renders.set(sessionId, (panes.renders.get(sessionId) ?? 0) + 1)
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
    expect(t.getAttribute('title')).toBe('docs/app.md — ⌘1')
    expect(screen.getByRole('button', { name: 'Close tab app.md' })).toBeInTheDocument()
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
