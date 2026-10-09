import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { NewMenu } from './NewMenu'

const items = () => [
  { id: 'agent', label: 'New agent', hint: '⇧⌘N', run: vi.fn() },
  { id: 'quick-chat', label: 'Quick chat…', hint: '⌥⌘N', run: vi.fn() },
  { id: 'shell', label: 'New shell', hint: '⌘T', run: vi.fn() },
]

// Owner, 2026-10-09: the strip's + is an amber outline that opens a menu of
// what opens a tab, each with its key.
describe('the + menu', () => {
  it('opens on a click with every row and its key, and runs the one clicked', () => {
    const list = items()
    render(<NewMenu items={list} />)
    const plus = screen.getByRole('button', { name: 'New' })
    expect(plus).toHaveClass('app-primary')
    fireEvent.click(plus)
    const rows = screen.getAllByRole('menuitem')
    expect(rows.map((r) => r.textContent)).toEqual(['New agent⇧⌘N', 'Quick chat…⌥⌘N', 'New shell⌘T'])
    expect(rows[0]).toHaveFocus()
    fireEvent.click(rows[1]!)
    expect(list[1]!.run).toHaveBeenCalled()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('is walked with the arrows and closed with Esc, focus back on +', () => {
    render(<NewMenu items={items()} />)
    const plus = screen.getByRole('button', { name: 'New' })
    fireEvent.click(plus)
    const menu = screen.getByRole('menu')
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(screen.getAllByRole('menuitem')[1]).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    expect(screen.getAllByRole('menuitem')[2]).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(plus).toHaveFocus()
  })
})
