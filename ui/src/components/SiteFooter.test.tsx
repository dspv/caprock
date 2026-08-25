/**
 * The footer is the only place in the product that asks for anything, so the
 * two things worth protecting are that it asks honestly and that it stops
 * asking once you have acted.
 *
 * The premium link is checked for its "not built yet" wording specifically. A
 * link to a page with no product behind it is fine; a link that reads like a
 * purchase is not, and that distinction lives entirely in this string.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { SiteFooter } from './SiteFooter'

describe('SiteFooter', () => {
  beforeEach(() => localStorage.clear())

  it('names the premium page without turning the footer into a checkout', () => {
    render(<SiteFooter />)
    const link = screen.getByRole('link', { name: /^premium$/i })
    expect(link).toHaveAttribute('href', 'https://caprock.dev/premium')
    // It names a destination and what is there. The price and the card field
    // live on that page — a dashboard footer that quotes a figure is one step
    // from being a storefront, which is not what people installed.
    expect(link.textContent).not.toMatch(/buy|upgrade|subscribe/i)
    expect(link.getAttribute('title')).toMatch(/daily spend cap/i)
    expect(document.body.textContent).not.toMatch(/\$\d/)
  })

  it('keeps the team offer as the only prominent one', () => {
    render(<SiteFooter />)
    // Exactly one arrow in the footer. A second offer at equal weight is what
    // turns a footer into a sales strip, and the arrow is what marks weight.
    expect(document.body.textContent?.match(/→/g) ?? []).toHaveLength(1)
  })

  it('offers the team page', () => {
    render(<SiteFooter />)
    expect(screen.getByRole('link', { name: /Caprock for Teams/ })).toHaveAttribute(
      'href',
      'https://caprock.dev/teams',
    )
  })

  it('stops asking for a star once one is given', () => {
    const { unmount } = render(<SiteFooter />)
    fireEvent.click(screen.getByRole('link', { name: /star on GitHub/ }))
    expect(screen.queryByRole('link', { name: /star on GitHub/ })).toBeNull()

    // And stays gone on the next visit, which is the point of remembering it.
    unmount()
    render(<SiteFooter />)
    expect(screen.queryByRole('link', { name: /star on GitHub/ })).toBeNull()
  })

  it('asks for a star when none has been given', () => {
    render(<SiteFooter />)
    expect(screen.getByRole('link', { name: /star on GitHub/ })).toBeInTheDocument()
  })
})
