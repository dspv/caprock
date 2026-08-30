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
    // The prices that are actually charged. The per-month equivalent used to
    // sit here too, in a row against Claude Pro's monthly rate — two unrelated
    // numbers above the buttons, which read as a strange comparison rather
    // than as a price. What each button is worth now sits under it.
    await waitFor(() => expect(document.body.textContent).toMatch(/\$30/))
    // A year or a lifetime, and deliberately not the monthly plan.
    //
    // At $5 the monthly option is the cheapest way to hold a licence key for a
    // month, which is a worse deal for the buyer than either commitment beside
    // it. It still exists on the site for anyone who wants it; it is not what
    // this dialog offers.
    expect(document.body.textContent).toMatch(/\$30/)
    expect(document.body.textContent).toMatch(/\$100/)
    expect(document.body.textContent).not.toMatch(/\$5 a month/)
  })

  it('sells the product rather than disclaiming it', async () => {
    // The dialog used to carry "Not built yet" in a bordered box above the
    // price — the loudest thing on a screen whose job is to sell. What
    // protects the buyer is the refund term, not a line of grey text: the
    // terms refund the period for any feature described as being built and
    // then abandoned. This asserts the hedge stays off the screen.
    render(<PremiumModal feature="cap" onClose={() => {}} />)
    await waitFor(() => expect(document.body.textContent).toMatch(/\$30/))
    for (const hedge of [/not built/i, /coming soon/i, /not yet/i, /planned/i]) {
      expect(document.body.textContent).not.toMatch(hedge)
    }
  })

  it('offers both ways to pay and a way to read more, each in a new tab', async () => {
    render(<PremiumModal feature="cap" onClose={() => {}} />)
    // Found by where each link goes, not by its label: the buttons are named
    // for their prices now, and a test that matched on the word "Subscribe"
    // failed for a rewording while the thing it guards was intact.
    await waitFor(() => expect(screen.getByRole('link', { name: /year/i })).toBeInTheDocument())
    const year = screen.getByRole('link', { name: /year/i })
    // Located by its price, not its wording — the label has been reworded
    // twice and the thing it guards has not changed.
    const once = screen.getByRole('link', { name: /\$100/ })
    const more = screen.getByRole('link', { name: /read more/i })
    expect(year.getAttribute('href')).toBe(pricing.yearly.url)
    // Lifetime is a button of its own. It is the option people ask about, and
    // it was previously reachable only by leaving for the site.
    expect(once.getAttribute('href')).toBe(pricing.lifetime.url)
    expect(more.getAttribute('href')).toBe(pricing.info_url)
    for (const a of [year, once, more]) expect(a.getAttribute('target')).toBe('_blank')
  })

  it('says what each price buys, and does not price itself against Claude', async () => {
    // "$100 forever" was the most-asked question on this screen — forever
    // *what*, this feature or everything Premium ever gains? Two readers said
    // they would have bought had it been answered.
    render(<PremiumModal feature="cap" onClose={() => {}} />)
    await waitFor(() => expect(document.body.textContent).toMatch(/\$100/))
    expect(document.body.textContent).toMatch(/now and future/i)
    expect(document.body.textContent).toMatch(/no renewal/i)

    // The Claude Pro comparison used to sit above the buttons. Four of five
    // readers said it argued against us: it made $100 read as five months of a
    // tool they cannot work without, and invited "yours sends a message,
    // theirs writes the code". Its absence is the assertion.
    expect(document.body.textContent).not.toMatch(/Claude Pro/)
    expect(document.body.textContent).not.toMatch(/months of/i)
  })

  it('states the setup a paid feature demands, before it is paid for', async () => {
    // "Through your own bot" was called the most alarming line on the screen
    // while it was dressed as a bullet point. Creating a Telegram bot is work,
    // and unnamed work is what people discover after paying.
    render(<PremiumModal feature="report" onClose={() => {}} />)
    expect(screen.getByText(/BotFather/)).toBeTruthy()
    expect(document.body.textContent).toMatch(/two minutes/i)
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
    fireEvent.click(screen.getByText(/A number for the day/))
    expect(onClose).not.toHaveBeenCalled()
  })
})
