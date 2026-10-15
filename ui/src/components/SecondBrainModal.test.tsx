import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { SecondBrainModal } from './SecondBrainModal'

describe('SecondBrainModal', () => {
  it('says what it does, the Jarvis promise, three steps and where the data goes', () => {
    render(<SecondBrainModal onClose={() => {}} onOpen={() => {}} />)
    const dialog = screen.getByRole('dialog', { name: 'Second Brain' })
    const text = dialog.textContent ?? ''
    expect(text).toContain('Remembers what your agents learn — so the next one starts smarter')
    expect(text).toMatch(/decisions, findings, ideas, open questions/)
    expect(text).toContain('Over time it becomes your personal Jarvis: an assistant that knows your projects.')
    const steps = screen.getByRole('list', { name: 'How it works' })
    expect(steps.querySelectorAll('li')).toHaveLength(3)
    // The defaults are the daemon's (internal/brain/engine.go), not invented.
    expect(steps.textContent).toMatch(/Haiku/)
    expect(steps.textContent).toMatch(/300k tokens a day/)
    expect(steps.textContent).toMatch(/handoff/)
    const privacy = dialog.querySelector('[data-brain-privacy]')!
    expect(privacy.textContent).toMatch(/Nothing leaves your computer except the call your own claude makes/)
    expect(privacy.textContent).toMatch(/Settings → Second Brain/)
    expect(text).not.toMatch(/Premium|\$/)
  })

  it('opens the Second Brain screen and closes', () => {
    const onOpen = vi.fn()
    const onClose = vi.fn()
    render(<SecondBrainModal onClose={onClose} onOpen={onOpen} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open Second Brain' }))
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('has no open button without somewhere to go', () => {
    render(<SecondBrainModal onClose={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Open Second Brain' })).toBeNull()
  })
})
