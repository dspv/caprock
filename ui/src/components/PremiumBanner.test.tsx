/**
 * The free version is the whole product, not a crippled preview. What keeps a
 * banner from turning it into a trial is a set of rules about where it can
 * appear and what it may say, and those rules are what is tested here — not
 * that a div renders.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { PremiumBanner } from './PremiumBanner'
import { PremiumHint } from './PremiumHint'
import { resetPrompts } from '@/lib/prompts'

const NOW = Date.parse('2026-08-26T12:00:00Z')

beforeEach(() => resetPrompts())

describe('PremiumBanner', () => {
  it('leads with a measured fact from this machine', () => {
    render(<PremiumBanner costUSD={620} days={20} now={NOW} />)
    // "$31.00 a day" is the reader's own number and can be checked. A banner
    // that opens with the offer instead is one they have no reason to believe.
    expect(screen.getByText('$31.00')).toBeTruthy()
    expect(document.body.textContent).toMatch(/20 active days/)
  })

  it('quotes no price', () => {
    render(<PremiumBanner costUSD={620} days={20} now={NOW} />)
    const text = document.body.textContent ?? ''
    // The spend figure is allowed; a subscription price is not. Strip the
    // measured number and nothing that looks like money may remain.
    expect(text.replace('$31.00', '')).not.toMatch(/\$\d/)
  })

  it('says nothing before anything has been measured', () => {
    // A banner over an empty dashboard advertises to someone who has not yet
    // seen the product do anything.
    const { container } = render(<PremiumBanner costUSD={0} days={0} now={NOW} />)
    expect(container.textContent).toBe('')
  })

  it('stays quiet for a month once dismissed, then returns', () => {
    const { unmount } = render(<PremiumBanner costUSD={620} days={20} now={NOW} />)
    fireEvent.click(screen.getByRole('button', { name: /not now/ }))
    unmount()

    render(<PremiumBanner costUSD={620} days={20} now={NOW + 20 * 24 * 3600 * 1000} />)
    expect(screen.queryByText(/what it does/)).toBeNull()

    render(<PremiumBanner costUSD={620} days={20} now={NOW + 31 * 24 * 3600 * 1000} />)
    expect(screen.getByText(/what it does/)).toBeTruthy()
  })

  it('does not share a dismissal with the in-banner hint', () => {
    // They are different offers in different places. Silencing one must not
    // silence the other, or a single click removes every mention at once and
    // the user cannot tell what they turned off.
    const { unmount } = render(<PremiumBanner costUSD={620} days={20} now={NOW} />)
    fireEvent.click(screen.getByRole('button', { name: /not now/ }))
    unmount()

    render(<PremiumHint reason="this is what a cap stops" now={NOW} />)
    expect(screen.getByText(/a cap that stops this/)).toBeTruthy()
  })
})
