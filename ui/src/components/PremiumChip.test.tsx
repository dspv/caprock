/**
 * The header chip: one control, and what it says depends on whether they paid.
 *
 * It was two controls in one border — a payment link and a chevron — with no
 * seam between them, so clicking the word "premium" to find out what premium
 * *is* took you to a card form. A reader who has not decided should never land
 * on a checkout by accident, and a chevron is a shape rather than a label.
 */
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PremiumChip } from './PremiumChip'
import type { PremiumPricing } from '@/lib/api'

const state = vi.hoisted(() => ({ value: {} as PremiumPricing }))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, premium: async () => state.value } }
})

const pricing = (license: PremiumPricing['license']): PremiumPricing =>
  ({
    yearly: { charged_usd: 30, url: 'https://buy/y' },
    monthly: { charged_usd: 5, url: 'https://buy/m' },
    lifetime: { charged_usd: 100, url: 'https://buy/l' },
    license,
  }) as PremiumPricing

describe('PremiumChip', () => {
  it('asks for something, rather than just showing a price', async () => {
    state.value = pricing({ active: false } as PremiumPricing['license'])
    render(<PremiumChip />)
    // "premium $30/yr" is a price tag, and a price tag asks nothing.
    const btn = await screen.findByRole('button', { name: /get premium/i })
    expect(btn).toBeInTheDocument()
    expect(screen.getByText('$30/yr')).toBeInTheDocument()
  })

  it('never puts a checkout one stray click away', async () => {
    state.value = pricing({ active: false } as PremiumPricing['license'])
    render(<PremiumChip />)
    await screen.findByRole('button', { name: /get premium/i })
    // No link at all in the header: the buy buttons live in the dialog, where
    // clicking one is a decision rather than a slip.
    expect(screen.queryByRole('link')).toBeNull()
  })

  // Paid readers know they paid. What they cannot see anywhere else is which
  // plan they are on and when it ends.
  it('names the plan once bought', async () => {
    state.value = pricing({ active: true, expires_at: '2027-09-01' } as PremiumPricing['license'])
    render(<PremiumChip />)
    await waitFor(() => expect(screen.getByText(/premium/i)).toBeInTheDocument())
    expect(screen.getByText('yearly')).toBeInTheDocument()
  })

  it('calls a fifty-year key lifetime', async () => {
    state.value = pricing({ active: true, expires_at: '2076-09-01' } as PremiumPricing['license'])
    render(<PremiumChip />)
    await waitFor(() => expect(screen.getByText('lifetime')).toBeInTheDocument())
  })

  // A renewal that has not arrived is worth noticing a week early, not on the
  // morning the features stop.
  it('flags a key inside its grace period', async () => {
    state.value = pricing({
      active: true, in_grace: true, expires_at: '2026-08-25',
    } as PremiumPricing['license'])
    render(<PremiumChip />)
    await waitFor(() => expect(screen.getByText(/renew/)).toBeInTheDocument())
  })

  it('renders nothing until the daemon has answered', () => {
    state.value = {} as PremiumPricing
    const { container } = render(<PremiumChip />)
    // An older daemon sends no pricing at all; a chip reading "$undefined/yr"
    // is worse than no chip.
    expect(container.textContent).toBe('')
  })
})
