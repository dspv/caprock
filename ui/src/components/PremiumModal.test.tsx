/**
 * A dialog that appears over someone's work is the loudest thing an interface
 * can do, and this product's argument is that it is a tool you installed
 * rather than a trial you are inside. So the rules about when it appears and
 * what it is allowed to claim are what is tested — not that a div renders.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PremiumPricing } from '@/lib/api'

const pricing: PremiumPricing = {
  yearly: { per_month_usd: 2.5, charged_usd: 30, period: 'year', url: 'https://buy.stripe.com/yearly' },
  monthly: { per_month_usd: 5, charged_usd: 5, period: 'month', url: 'https://buy.stripe.com/monthly' },
  lifetime: { per_month_usd: 0, charged_usd: 100, period: 'once', url: 'https://buy/l' },
  info_url: 'https://caprock.dev/premium/',
  compare: { plan: 'Claude Pro', monthly_usd: 20, source: 'claude.com/pricing', read_on: '2026-08-28' },
}

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, premium: async () => pricing } }
})

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

  it('leads with the feature that was clicked, not a pitch for the plan', async () => {
    render(<PremiumModal feature="report" onClose={() => {}} />)
    // Someone who clicked a weekly report wants to read about a weekly report.
    expect(screen.getByText(/weekly report/i)).toBeTruthy()
    expect(screen.queryByText(/daily cap/i)).toBeNull()
  })

  it('states the price rather than sending someone away to find it', async () => {
    render(<PremiumModal feature="cap" onClose={() => {}} />)
    // The per-month equivalent of the yearly plan — the number people compare.
    await waitFor(() => expect(document.body.textContent).toMatch(/\$2\.50/))
    // Every way to pay stays reachable, so the smaller commitment is not
    // hidden behind the one we would rather sell. Matched on the figures
    // alone: the previous version asserted the exact phrasing, and rewording
    // the line failed a test about *what is offered*.
    expect(document.body.textContent).toMatch(/\$30/)
    expect(document.body.textContent).toMatch(/\$5/)
    expect(document.body.textContent).toMatch(/\$100/)
  })

  it('says plainly when a feature is not built', async () => {
    render(<PremiumModal feature="cap" onClose={() => {}} />)
    expect(document.body.textContent).toMatch(/not built yet/i)
  })

  it('offers both ways to pay and a way to read more, each in a new tab', async () => {
    render(<PremiumModal feature="cap" onClose={() => {}} />)
    // Found by where each link goes, not by its label: the buttons are named
    // for their prices now, and a test that matched on the word "Subscribe"
    // failed for a rewording while the thing it guards was intact.
    await waitFor(() => expect(screen.getByRole('link', { name: /year/i })).toBeInTheDocument())
    const year = screen.getByRole('link', { name: /year/i })
    const once = screen.getByRole('link', { name: /once/i })
    const more = screen.getByRole('link', { name: /read more/i })
    expect(year.getAttribute('href')).toBe(pricing.yearly.url)
    // Lifetime is a button of its own. It is the option people ask about, and
    // it was previously reachable only by leaving for the site.
    expect(once.getAttribute('href')).toBe(pricing.lifetime.url)
    expect(more.getAttribute('href')).toBe(pricing.info_url)
    for (const a of [year, once, more]) expect(a.getAttribute('target')).toBe('_blank')
  })

  it('measures the price against one the reader already pays, with its source', async () => {
    // A price with no ruler means nothing, and a number about someone else's
    // pricing with no source is what rule 6 forbids. Both halves are the test.
    render(<PremiumModal feature="cap" onClose={() => {}} />)
    // Named twice on purpose: once in the comparison, once crediting the
    // source, so getAllByText rather than a query that forbids the second.
    await waitFor(() => expect(screen.getAllByText(/Claude Pro/).length).toBeGreaterThan(0))
    expect(document.body.textContent).toMatch(/\$20 \/ month/)
    expect(document.body.textContent).toMatch(/claude\.com\/pricing/)
    expect(document.body.textContent).toMatch(/2026-08-28/)
    // And it must not imply the two are substitutes.
    expect(document.body.textContent).toMatch(/Different things/i)
  })

  it('closes on Escape, on the backdrop, and on both close controls', () => {
    const onClose = vi.fn()
    const { rerender } = render(<PremiumModal feature="cap" onClose={onClose} />)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    rerender(<PremiumModal feature="cap" onClose={onClose} />)
    fireEvent.click(screen.getByRole('dialog'))
    expect(onClose).toHaveBeenCalledTimes(2)

    for (const b of screen.getAllByRole('button', { name: 'Close' })) fireEvent.click(b)
    expect(onClose).toHaveBeenCalledTimes(4)
  })

  it('does not close when the dialog body itself is clicked', () => {
    const onClose = vi.fn()
    render(<PremiumModal feature="cap" onClose={onClose} />)
    fireEvent.click(screen.getByText(/Set a number for the day/))
    expect(onClose).not.toHaveBeenCalled()
  })
})
