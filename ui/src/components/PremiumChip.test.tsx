/**
 * The complaint this exists to answer was "how do I even buy this?", asked
 * while looking at the main screen. So what is tested is that a path to paying
 * exists without visiting a particular screen, and that it goes away once
 * someone has paid.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { PremiumPricing } from '@/lib/api'

const state = vi.hoisted(() => ({ licensed: false }))

const pricing = (): PremiumPricing => ({
  yearly: { per_month_usd: 2.5, charged_usd: 30, period: 'year', url: 'https://buy/y' },
  monthly: { per_month_usd: 5, charged_usd: 5, period: 'month', url: 'https://buy/m' },
  lifetime: { per_month_usd: 0, charged_usd: 100, period: 'once', url: 'https://buy/l' },
  info_url: 'https://caprock.dev/premium/',
  license: { active: state.licensed, in_grace: false },
})

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, premium: async () => pricing() } }
})

import { PremiumChip } from './PremiumChip'

describe('PremiumChip', () => {
  it('goes straight to the checkout, without a dialog in the way', async () => {
    // The first version opened the dialog and nothing else, so someone who had
    // already decided still had to read a screen and then hunt for a price.
    // "You cannot go straight to premium" was the complaint.
    state.licensed = false
    render(<PremiumChip />)
    const buy = await screen.findByRole('link', { name: /premium/i })
    expect(buy.getAttribute('href')).toBe('https://buy/y')
    expect(buy.getAttribute('target')).toBe('_blank')
    // Reaching it must not require opening anything first.
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('still offers the explanation, for anyone who has not decided', async () => {
    state.licensed = false
    render(<PremiumChip />)
    const more = await screen.findByRole('button', { name: /what premium includes/i })
    fireEvent.click(more)
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  // Not tested here: the crash when the daemon sends no plans. It was real —
  // the first version read `.url` off an absent plan and took the whole header
  // down — but App.test.tsx is what catches it, because a crash only shows as
  // a crash when something around it disappears. Two attempts at asserting it
  // in isolation passed whether the guard was present or not, and a test that
  // cannot fail is worse than no test.
  it('stops selling to someone who has already paid', async () => {
    // A buy button shown to a payer is the fastest way to make them feel they
    // bought nothing.
    state.licensed = true
    render(<PremiumChip />)
    await waitFor(() => expect(screen.getByText(/premium/i)).toBeInTheDocument())
    expect(screen.queryByRole('link', { name: /premium/i })).toBeNull()
  })
})
