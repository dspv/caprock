import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CloseButton, DialogBackdrop, dialogOpen } from './Dialog'
import { Sheet } from './Sheet'
import { QuickChatSheet } from './QuickChat'

function Plain({ onClose, label = 'Plain' }: { onClose: () => void; label?: string }) {
  return (
    <DialogBackdrop onClose={onClose} className="fixed inset-0" data-testid={`${label}-backdrop`}>
      <div role="dialog" aria-label={label}>
        <CloseButton onClick={onClose} />
        <input aria-label="Field" />
      </div>
    </DialogBackdrop>
  )
}

describe('a dialog’s ways out (owner, 2026-10-10: Quick chat could not be closed)', () => {
  it('closes on its ×, on Escape and on a click on the backdrop', () => {
    const onClose = vi.fn()
    render(<Plain onClose={onClose} />)
    expect(dialogOpen()).toBe(true)
    const x = screen.getByRole('button', { name: 'Close' })
    expect(x).toHaveAttribute('title', 'Close (Esc)')
    expect(x.className).toContain('h-[30px]')
    fireEvent.click(x)
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)

    const backdrop = screen.getByTestId('Plain-backdrop')
    fireEvent.mouseDown(backdrop)
    fireEvent.click(backdrop)
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('stays open when a drag that began inside the panel ends on the backdrop', () => {
    const onClose = vi.fn()
    render(<Plain onClose={onClose} />)
    // A text selection: pressed in the field, released over the backdrop. The
    // click lands on the backdrop, their common ancestor.
    fireEvent.mouseDown(screen.getByLabelText('Field'))
    fireEvent.click(screen.getByTestId('Plain-backdrop'))
    expect(onClose).not.toHaveBeenCalled()
    // A click inside the panel never closes it either.
    fireEvent.mouseDown(screen.getByRole('dialog'))
    fireEvent.click(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes only the newest dialog on Escape, and nothing under it hears the key', () => {
    const outer = vi.fn()
    const inner = vi.fn()
    const page = vi.fn()
    window.addEventListener('keydown', page)
    const { rerender, unmount } = render(<><Plain onClose={outer} label="Outer" /><Plain onClose={inner} label="Inner" /></>)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(inner).toHaveBeenCalledTimes(1)
    expect(outer).not.toHaveBeenCalled()
    expect(page).not.toHaveBeenCalled()
    rerender(<Plain onClose={outer} label="Outer" />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(outer).toHaveBeenCalledTimes(1)
    unmount()
    expect(dialogOpen()).toBe(false)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(page).toHaveBeenCalledTimes(1)
    window.removeEventListener('keydown', page)
  })
})

describe('the sheet', () => {
  it('has the × in its header and still focuses its first field, not the ×', () => {
    const onClose = vi.fn()
    render(<Sheet label="Thing" title="Thing" onClose={onClose}><input aria-label="Name" /></Sheet>)
    expect(screen.getByLabelText('Name')).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps a × without a title too', () => {
    const onClose = vi.fn()
    render(<Sheet label="Question" onClose={onClose}><p>Sure?</p></Sheet>)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes Quick chat with the ×, the backdrop and Escape', () => {
    const onClose = vi.fn()
    render(<QuickChatSheet agents={['claude', 'codex']} onStart={() => {}} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    const backdrop = screen.getByRole('dialog', { name: 'Quick chat' }).parentElement!
    fireEvent.mouseDown(backdrop)
    fireEvent.click(backdrop)
    expect(onClose).toHaveBeenCalledTimes(2)
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(3)
  })
})
