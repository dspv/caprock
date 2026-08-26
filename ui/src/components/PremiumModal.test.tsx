/**
 * A dialog that appears over someone's work is the loudest thing an interface
 * can do, and this product's argument is that it is a tool you installed
 * rather than a trial you are inside. So the rule that matters most about this
 * component is when it does NOT appear.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PremiumModal } from './PremiumModal'
import { PremiumBanner } from './PremiumBanner'
import { resetPrompts } from '@/lib/prompts'

const NOW = Date.parse('2026-08-26T12:00:00Z')

beforeEach(() => resetPrompts())

describe('PremiumModal', () => {
  it('never opens on its own — only when someone asks', () => {
    render(<PremiumBanner costUSD={620} days={20} now={NOW} />)
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /what it does/ }))
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('separates what is built from what is not', () => {
    // Naming unwritten software on a surface someone pays from is an invented
    // number wearing a different hat.
    render(<PremiumModal onClose={() => {}} />)
    expect(screen.getByText(/working today/i)).toBeTruthy()
    expect(screen.getByText(/being built/i)).toBeTruthy()
    expect(document.body.textContent).toMatch(/not written yet/i)
  })

  it('quotes no price, and sends the reader somewhere that does', () => {
    // A price copied into a second codebase eventually contradicts the one
    // that charges the card, so this surface carries none.
    render(<PremiumModal onClose={() => {}} />)
    expect(document.body.textContent).not.toMatch(/\$\d/)
    const link = screen.getByRole('link', { name: /price and subscribe/i })
    expect(link.getAttribute('href')).toBe('https://caprock.dev/premium/')
    expect(link.getAttribute('target')).toBe('_blank')
  })

  it('closes on Escape, on the backdrop, and on the button', () => {
    const onClose = vi.fn()
    const { rerender } = render(<PremiumModal onClose={onClose} />)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    rerender(<PremiumModal onClose={onClose} />)
    fireEvent.click(screen.getByRole('dialog'))
    expect(onClose).toHaveBeenCalledTimes(2)

    // Two controls carry this name — the header's ✕ and the footer's button.
    // Both must work, so both are clicked rather than one being disambiguated
    // away.
    for (const b of screen.getAllByRole('button', { name: 'Close' })) {
      fireEvent.click(b)
    }
    expect(onClose).toHaveBeenCalledTimes(4)
  })

  it('does not close when the dialog body itself is clicked', () => {
    // Clicking a word you are reading should not throw the dialog away.
    const onClose = vi.fn()
    render(<PremiumModal onClose={onClose} />)
    fireEvent.click(screen.getByText(/Premium is the half that acts on it/))
    expect(onClose).not.toHaveBeenCalled()
  })
})
