import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

const m = vi.hoisted(() => ({ mac: true }))
vi.mock('@/lib/appmode', async (orig) => ({ ...(await orig<typeof import('@/lib/appmode')>()), isMacPlatform: () => m.mac }))

import { SectionFrames } from './SectionFrames'
import { DEFAULT_ORDER, ORDER_KEY, resetOrderForTest, useSectionOrder, type CockpitSection } from '@/lib/cockpitorder'

beforeEach(() => {
  localStorage.clear()
  resetOrderForTest()
  m.mac = true
})

/** Six sections drawn, the rest showing nothing for this session; CI's fold drew nothing. */
function Panel() {
  const order = useSectionOrder()
  const sec = (name: string): ReactNode => <section aria-label={name}><h4>{name}</h4></section>
  const sections = Object.fromEntries(DEFAULT_ORDER.map((id) => [id, null])) as Record<CockpitSection, ReactNode>
  sections.now = sec('Now')
  sections.context = sec('Context')
  sections.spend = sec('Spend')
  sections.tools = sec('Recent tools')
  sections.ci = <div data-fold="ci" />
  sections.release = <div data-fold="release">{sec('Release')}</div>
  return <div data-testid="panel"><SectionFrames order={order} sections={sections} /></div>
}

const drawn = () => Array.from(document.querySelectorAll('section')).map((s) => s.getAttribute('aria-label'))
const grip = (name: string) => screen.getByRole('button', { name: `Reorder ${name}` })

describe('reordering the right panel’s sections', () => {
  it('gives every drawn section a grip, and none to a section with nothing to show', () => {
    render(<Panel />)
    expect(drawn()).toEqual(['Now', 'Context', 'Spend', 'Recent tools', 'Release'])
    expect(screen.getAllByRole('button', { name: /^Reorder / })).toHaveLength(6)
    expect(document.querySelector('[data-section-frame="limits"]')).toBeNull()
  })

  it('moves the focused grip’s section with ⌥⇧↑ ⌥⇧↓, skipping what is not drawn, and keeps the focus on it', () => {
    render(<Panel />)
    grip('Release').focus()
    // CI drew nothing: one press puts Release above Recent tools.
    fireEvent.keyDown(grip('Release'), { key: 'ArrowUp', code: 'ArrowUp', altKey: true, shiftKey: true })
    expect(drawn()).toEqual(['Now', 'Context', 'Spend', 'Release', 'Recent tools'])
    expect(document.activeElement).toBe(grip('Release'))
    fireEvent.keyDown(grip('Release'), { key: 'ArrowDown', code: 'ArrowDown', altKey: true, shiftKey: true })
    expect(drawn()).toEqual(['Now', 'Context', 'Spend', 'Recent tools', 'Release'])
    // A plain arrow, or Alt alone, moves nothing.
    fireEvent.keyDown(grip('Release'), { key: 'ArrowUp', code: 'ArrowUp' })
    fireEvent.keyDown(grip('Release'), { key: 'ArrowUp', code: 'ArrowUp', altKey: true })
    expect(drawn()).toEqual(['Now', 'Context', 'Spend', 'Recent tools', 'Release'])
  })

  // CLAUDE.md rule 12: the key as Windows and Linux spell it.
  it('takes Ctrl+Shift+↑ off macOS, as its title says, and not Alt+Shift+↑ there', () => {
    m.mac = false
    render(<Panel />)
    expect(grip('Spend').title).toContain('Ctrl+Shift+↑')
    fireEvent.keyDown(grip('Spend'), { key: 'ArrowUp', code: 'ArrowUp', altKey: true, shiftKey: true })
    expect(drawn()[2]).toBe('Spend')
    fireEvent.keyDown(grip('Spend'), { key: 'ArrowUp', code: 'ArrowUp', ctrlKey: true, shiftKey: true })
    expect(drawn()).toEqual(['Now', 'Spend', 'Context', 'Recent tools', 'Release'])
  })

  it('moves from the grip’s menu — up, down, to the top — keeps the order, and resets it', () => {
    const { unmount } = render(<Panel />)
    fireEvent.click(grip('Release'))
    const menu = screen.getByRole('menu', { name: 'Release section' })
    expect(screen.getByRole('menuitem', { name: /Move down/ })).toBeDisabled()
    expect(screen.getByRole('menuitem', { name: /Reset order/ })).toBeDisabled()
    expect(menu).toHaveTextContent('⌥⇧↑')
    fireEvent.click(screen.getByRole('menuitem', { name: /Move to top/ }))
    expect(screen.queryByRole('menu')).toBeNull()
    expect(drawn()).toEqual(['Release', 'Now', 'Context', 'Spend', 'Recent tools'])
    expect(JSON.parse(localStorage.getItem(ORDER_KEY)!)[0]).toBe('release')
    fireEvent.click(grip('Context'))
    fireEvent.click(screen.getByRole('menuitem', { name: /Move up/ }))
    expect(drawn()).toEqual(['Release', 'Context', 'Now', 'Spend', 'Recent tools'])
    // A fresh page reads it back.
    unmount()
    resetOrderForTest()
    render(<Panel />)
    expect(drawn()).toEqual(['Release', 'Context', 'Now', 'Spend', 'Recent tools'])
    fireEvent.click(grip('Spend'))
    fireEvent.click(screen.getByRole('menuitem', { name: /Reset order/ }))
    expect(localStorage.getItem(ORDER_KEY)).toBeNull()
    expect(drawn()).toEqual(['Now', 'Context', 'Spend', 'Recent tools', 'Release'])
  })

  it('drops a dragged grip’s section where the pointer is, a line showing where; a short press is a click', () => {
    render(<Panel />)
    // Each frame 40px tall, top to bottom.
    const ids = ['now', 'context', 'spend', 'tools', 'ci', 'release']
    for (const id of ids) {
      const el = document.querySelector(`[data-section-frame="${id}"]`)!
      const top = ids.indexOf(id) * 40
      el.getBoundingClientRect = () => ({ top, height: 40, bottom: top + 40, left: 0, right: 300, width: 300, x: 0, y: top, toJSON: () => ({}) })
    }
    const g = grip('Recent tools')
    fireEvent.pointerDown(g, { button: 0, clientY: 125, pointerId: 1 })
    fireEvent.pointerMove(g, { clientY: 127, pointerId: 1 })
    expect(document.querySelector('[data-drop-line]')).toBeNull()
    fireEvent.pointerMove(g, { clientY: 10, pointerId: 1 })
    // Above Now's middle: the line over Now.
    expect(document.querySelector('[data-section-frame="now"] [data-drop-line]')).not.toBeNull()
    fireEvent.pointerMove(g, { clientY: 50, pointerId: 1 })
    expect(document.querySelector('[data-section-frame="context"] [data-drop-line]')).not.toBeNull()
    fireEvent.pointerUp(g, { clientY: 50, pointerId: 1 })
    fireEvent.click(g)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(drawn()).toEqual(['Now', 'Recent tools', 'Context', 'Spend', 'Release'])
    expect(document.querySelector('[data-drop-line]')).toBeNull()
  })
})
