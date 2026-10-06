/**
 * The tab strip reorders by pointer events: in the desktop app the shell's
 * native drop handler takes every drag over the window, so an HTML5
 * dragover or drop never reaches the page (.ai/21-app.md § Dropping a file).
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TabStrip } from './TerminalTabs'
import type { Tab } from '@/lib/tabs'

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
