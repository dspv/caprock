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
  it('offers a way to buy without being on a screen that sells something', async () => {
    state.licensed = false
    render(<PremiumChip />)
    const chip = await screen.findByRole('button', { name: /premium/i })

    // And it opens the dialog rather than navigating away from whatever the
    // reader was doing.
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(chip)
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('stops selling to someone who has already paid', async () => {
    // A buy button shown to a payer is the fastest way to make them feel they
    // bought nothing.
    state.licensed = true
    render(<PremiumChip />)
    await waitFor(() => expect(screen.getByText(/premium/i)).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /premium/i })).toBeNull()
  })
})
