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

import { PAID_FEATURES, PremiumModal, isNew } from './PremiumModal'
import { PremiumBanner } from './PremiumBanner'
import { resetPrompts } from '@/lib/prompts'

const NOW = Date.parse('2026-08-26T12:00:00Z')

beforeEach(() => resetPrompts())

describe('PremiumModal', () => {
  it('never opens on its own — only when someone asks', () => {
    render(<PremiumBanner costUSD={620} days={20} now={NOW} />)
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /what it does/i }))
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('leads with the feature that was clicked, not a pitch for the plan', async () => {
    render(<PremiumModal feature="report" onClose={() => {}} />)
    // Someone who clicked a weekly report wants to read about a weekly report.
    // The rest of the plan is only named, in the chip row under it.
    expect(screen.getByRole('heading', { name: /weekly report/i })).toBeTruthy()
    expect(screen.queryByText(/A number for the day/)).toBeNull()
    const outside = [...screen.getByRole('dialog').querySelectorAll('*')]
      .filter((el) => el.children.length === 0 && /daily cap/i.test(el.textContent ?? '') && !el.closest('[role="group"]'))
    expect(outside).toHaveLength(0)
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
    expect(year.getAttribute('href')).toBe(`${pricing.yearly.url}?client_reference_id=app-cap`)
    // Lifetime is a button of its own. It is the option people ask about, and
    // it was previously reachable only by leaving for the site.
    expect(once.getAttribute('href')).toBe(`${pricing.lifetime.url}?client_reference_id=app-cap`)
    expect(more.getAttribute('href')).toBe(`${pricing.info_url.split('#')[0]}#cap`)
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

  it('sells the plan-window stop as what it is: windows, not dollars, resumed after the reset', async () => {
    render(<PremiumModal feature="window" onClose={() => {}} />)
    expect(screen.getByText(/Stop at the plan limit/)).toBeTruthy()
    expect(document.body.textContent).toMatch(/resume by themselves when the window resets/)
    // Rule 7, printed on the dialog like the cap's.
    expect(document.body.textContent).toMatch(/Sessions you started yourself are never touched/)
    // The setup it needs is named before payment: the figures come from the
    // status line, and only Pro and Max have windows at all.
    expect(document.body.textContent).toMatch(/caprock statusline install/)
    expect(document.body.textContent).toMatch(/Pro and Max only/)
    // Not the cap: no dollar ceiling in its picture.
    const picture = screen.getByRole('dialog').querySelector('figure[role="img"]')!
    expect(picture.textContent).not.toMatch(/\$/)
    await waitFor(() => expect(screen.getByRole('link', { name: /year/i })).toBeInTheDocument())
    expect(screen.getByRole('link', { name: /year/i }).getAttribute('href')).toMatch(/client_reference_id=app-window$/)
    expect(screen.getByRole('link', { name: /read more/i }).getAttribute('href')).toBe('https://caprock.dev/premium/#window')
  })

  it('closes on Escape, on the backdrop, and on both close controls', () => {
    const onClose = vi.fn()
    const { rerender } = render(<PremiumModal feature="cap" onClose={onClose} />)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    rerender(<PremiumModal feature="cap" onClose={onClose} />)
    const backdrop = screen.getByRole('dialog')
    fireEvent.mouseDown(backdrop)
    fireEvent.click(backdrop)
    expect(onClose).toHaveBeenCalledTimes(2)

    for (const b of screen.getAllByRole('button', { name: 'Close' })) fireEvent.click(b)
    expect(onClose).toHaveBeenCalledTimes(4)
  })

  it('shows the feature first, and every figure in the picture is tagged an example', () => {
    for (const f of ['cap', 'window', 'gemini', 'report', 'drill'] as const) {
      const { unmount } = render(<PremiumModal feature={f} onClose={() => {}} />)
      const picture = screen.getByRole('dialog').querySelector('figure[role="img"]')!
      expect(picture, f).toBeTruthy()
      expect(picture.textContent, f).toMatch(/^Example/)
      expect(picture.getAttribute('aria-label'), f).toMatch(/^Example:/)
      unmount()
    }
  })

  it('marks the lifetime "Best value", as the site does, and offers no monthly plan', async () => {
    render(<PremiumModal feature="cap" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByRole('link', { name: /\$100/ })).toBeInTheDocument())
    const once = screen.getByRole('link', { name: /\$100/ }).parentElement!
    expect(once.textContent).toMatch(/Best value/)
    expect(screen.getByRole('link', { name: /year/i }).parentElement!.textContent).not.toMatch(/Best value/)
    expect(screen.queryByRole('link', { name: /month/i })).toBeNull()
  })

  it('takes focus when it opens and gives it back when it closes', () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const { unmount } = render(<PremiumModal feature="cap" onClose={() => {}} />)
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)
    unmount()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('does not close when the dialog body itself is clicked', () => {
    const onClose = vi.fn()
    render(<PremiumModal feature="cap" onClose={onClose} />)
    fireEvent.click(screen.getByText(/A number for the day/))
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('PremiumModal: the whole plan', () => {
  // Readers took the plan for the one feature they had clicked (owner,
  // 2026-10-16, translated). The rest of the plan is one row of chips under
  // it, not a second screen.
  const chips = () => [...screen.getByRole('group', { name: 'Also in Premium' }).querySelectorAll('button')]

  it('counts the plan in the header, with the yearly price from the daemon', async () => {
    render(<PremiumModal feature="cap" onClose={() => {}} />)
    const n = PAID_FEATURES.length
    expect(n).toBeGreaterThan(1)
    await waitFor(() => expect(screen.getByText(`Premium · ${n} features · $30 a year`)).toBeInTheDocument())
  })

  it('lists every other feature once, and not the one on top', () => {
    for (const f of PAID_FEATURES) {
      const { unmount } = render(<PremiumModal feature={f} onClose={() => {}} />)
      expect(chips(), f).toHaveLength(PAID_FEATURES.length - 1)
      expect(chips().every((c) => c.getAttribute('aria-pressed') === 'false'), f).toBe(true)
      unmount()
    }
  })

  it('swaps the picture and the lines in place when a chip is pressed, and back again', async () => {
    render(<PremiumModal feature="cap" onClose={() => {}} />)
    const report = chips().find((c) => c.textContent?.startsWith('Weekly report'))!
    fireEvent.click(report)
    expect(screen.getByRole('heading', { name: /weekly report/i })).toBeInTheDocument()
    expect(screen.getByRole('dialog').querySelector('figure[role="img"]')!.getAttribute('aria-label')).toMatch(/Monday message/)
    expect(screen.getByText(/BotFather/)).toBeInTheDocument()
    expect(screen.queryByText(/A number for the day/)).toBeNull()
    expect(report.getAttribute('aria-pressed')).toBe('true')
    // Still the same dialog, with the same number of chips.
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(chips()).toHaveLength(PAID_FEATURES.length - 1)
    // What is bought or read about is the feature being read.
    await waitFor(() => expect(screen.getByRole('link', { name: /year/i })).toBeInTheDocument())
    expect(screen.getByRole('link', { name: /year/i }).getAttribute('href')).toMatch(/client_reference_id=app-report$/)
    expect(screen.getByRole('link', { name: /read more/i }).getAttribute('href')).toMatch(/#report$/)

    fireEvent.click(report)
    expect(screen.getByText(/A number for the day/)).toBeInTheDocument()
    expect(report.getAttribute('aria-pressed')).toBe('false')
  })

  it('moves between chips with the arrow keys, with one chip in the Tab order', () => {
    render(<PremiumModal feature="cap" onClose={() => {}} />)
    const c = chips()
    expect(c.filter((b) => b.tabIndex === 0)).toHaveLength(1)
    // Opening the dialog does not land on a chip.
    expect(c).not.toContain(document.activeElement)
    c[0]!.focus()
    fireEvent.keyDown(c[0]!, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(c[1])
    fireEvent.keyDown(c[1]!, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(c[0])
    fireEvent.keyDown(c[0]!, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(c[c.length - 1])
    fireEvent.keyDown(c[c.length - 1]!, { key: 'Home' })
    expect(document.activeElement).toBe(c[0])
    fireEvent.click(c[2]!)
    expect(chips().filter((b) => b.tabIndex === 0)).toEqual([c[2]])
  })

  it('tags as New only what shipped in the last 30 days', () => {
    const day = 86_400_000
    // 2026-10-16: drill (10-04), window (10-09), agents, telegram and
    // subscriptions (10-10) are new; cap, report (08-26) and gemini (09-01)
    // are not.
    const now = Date.parse('2026-10-16T12:00:00Z')
    render(<PremiumModal feature="drill" onClose={() => {}} now={now} />)
    const tagged = chips().filter((c) => /New$/.test(c.textContent ?? '')).map((c) => c.textContent!.replace(/New$/, ''))
    expect(tagged.sort()).toEqual(['Own agents', 'Plan limit', 'Sign-ins', 'Telegram'])
    expect(isNew('drill', now)).toBe(true)
    expect(isNew('cap', now)).toBe(false)
    expect(isNew('gemini', now)).toBe(false)
    // The edge: 30 days after a feature shipped it is no longer new.
    const shipped = Date.parse('2026-10-10T00:00:00Z')
    expect(isNew('telegram', shipped + 30 * day - 1)).toBe(true)
    expect(isNew('telegram', shipped + 30 * day)).toBe(false)
    // Nothing is tagged before it shipped, and nothing is promised.
    expect(isNew('telegram', shipped - day)).toBe(false)
    for (const hedge of [/soon/i, /not built/i, /planned/i]) expect(document.body.textContent).not.toMatch(hedge)
  })
})

describe('fromFeature', () => {
  it('tags a checkout with the feature and lands the info link on its entry', async () => {
    const { fromFeature } = await import('./PremiumModal')
    expect(fromFeature('https://buy.stripe.com/x', 'cap', 'buy')).toBe('https://buy.stripe.com/x?client_reference_id=app-cap')
    expect(fromFeature('https://buy.stripe.com/x?a=1', 'drill', 'buy')).toBe('https://buy.stripe.com/x?a=1&client_reference_id=app-drill')
    expect(fromFeature('https://caprock.dev/premium/', 'report', 'info')).toBe('https://caprock.dev/premium/#report')
    expect(fromFeature('https://caprock.dev/premium/#old', 'gemini', 'info')).toBe('https://caprock.dev/premium/#gemini')
  })
})
