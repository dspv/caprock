/**
 * What a subscription buys, at the only place it is visible: the glass comes
 * off. Someone who paid and still sees a lock has been charged for nothing,
 * which is the failure this whole design is arranged around.
 */
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { PremiumPricing } from '@/lib/api'

const state = vi.hoisted(() => ({ active: false, inGrace: false }))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      premium: async (): Promise<PremiumPricing> => ({
        yearly: { per_month_usd: 2.5, charged_usd: 30, period: 'year', url: 'https://buy/y' },
        monthly: { per_month_usd: 5, charged_usd: 5, period: 'month', url: 'https://buy/m' },
        info_url: 'https://caprock.dev/premium/',
        license: { active: state.active, in_grace: state.inGrace },
      }),
    },
  }
})

import { Locked } from './Locked'

describe('Locked', () => {
  it('covers the feature when there is no key', async () => {
    state.active = false
    render(<Locked feature="cap" title="Stop the day"><p>the real panel</p></Locked>)
    expect(await screen.findByRole('button', { name: /unlock/i })).toBeTruthy()
  })

  it('hands over the feature when the key is active', async () => {
    state.active = true
    render(<Locked feature="cap" title="Stop the day"><p>the real panel</p></Locked>)
    await waitFor(() => expect(screen.queryByRole('button', { name: /unlock/i })).toBeNull())
    expect(screen.getByText('the real panel')).toBeTruthy()
  })

  it('keeps the feature during grace', async () => {
    // A failed renewal must not take the feature away while there is still
    // time to fix the payment.
    state.active = true
    state.inGrace = true
    render(<Locked feature="cap" title="Stop the day"><p>the real panel</p></Locked>)
    await waitFor(() => expect(screen.getByText('the real panel')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /unlock/i })).toBeNull()
  })
})
