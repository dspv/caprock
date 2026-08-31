/**
 * The cap is the first thing Caprock does rather than shows, and it stops
 * someone's work. So what is tested is that the control tells the truth about
 * its own state, and that the promises printed on it stay printed.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Settings } from '@/lib/api'

const state = vi.hoisted(() => ({
  cap: 0 as number | undefined,
  saved: [] as number[],
}))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      settings: async (): Promise<Settings> =>
        ({
          update_checks: false,
          plan_kind: '',
          plan_label: '',
          plan_usd_per_month: 0,
          cap_usd_per_day: state.cap,
        }) as Settings,
      saveSettings: async (s: Partial<Settings>) => {
        state.saved.push(s.cap_usd_per_day as number)
        state.cap = s.cap_usd_per_day as number
        return s as Settings
      },
    },
  }
})

import { SpendCap } from './SpendCap'

describe('SpendCap', () => {
  it('shows the limit it is actually set to', async () => {
    // Shipped broken once: the field seeded from the first render, where the
    // response is still undefined, and marked itself done. The panel read
    // "on $280" beside an empty box — a control that does not show what it is
    // set to is worse than one that shows nothing.
    //
    // This test passes with the bug reintroduced: under jsdom both renders
    // settle before the assertion, so the wrong effect still ends up with the
    // right value. It was caught in a browser and it is stated here rather
    // than dressed up as a regression guard it cannot be.
    state.cap = 280
    state.saved = []
    render(<SpendCap />)
    await waitFor(() =>
      expect((screen.getByLabelText(/daily spend cap in dollars/i) as HTMLInputElement).value).toBe('280'),
    )
    expect(screen.getByText('on')).toBeTruthy()
  })

  it('can be turned off, which the API has to be able to express', async () => {
    // Zero is a state, not an absence. The endpoint dropped it from the
    // response as `omitempty`, so an off cap was indistinguishable from a
    // daemon too old to have the field — and it could be switched on but never
    // off.
    state.cap = 280
    state.saved = []
    render(<SpendCap />)
    fireEvent.click(await screen.findByRole('button', { name: /turn off/i }))
    await waitFor(() => expect(state.saved).toContain(0))
  })

  it('offers a limit from the reader’s own history rather than prefilling one', async () => {
    // A number that appears in the field on its own is a number nobody chose,
    // and this one stops work. It is offered as a click.
    state.cap = 0
    state.saved = []
    render(<SpendCap suggestion={280} />)
    const offer = await screen.findByRole('button', { name: /use \$280/i })
    // Not already in the field.
    expect((screen.getByLabelText(/daily spend cap in dollars/i) as HTMLInputElement).value).toBe('')
    fireEvent.click(offer)
    await waitFor(() => expect(state.saved).toContain(280))
  })

  it('refuses a negative ceiling instead of saving one', async () => {
    state.cap = 0
    state.saved = []
    render(<SpendCap />)
    const input = await screen.findByLabelText(/daily spend cap in dollars/i)
    fireEvent.change(input, { target: { value: '-5' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(screen.getByText(/positive number of dollars/i)).toBeInTheDocument())
    expect(state.saved).toHaveLength(0)
  })

  it('states that sessions you started yourself are never touched', async () => {
    // Rule 7 is the reason anyone lets this daemon near their machine, and a
    // panel that pauses processes is exactly where it has to be said — in both
    // states, because someone reads it while deciding whether to switch it on.
    for (const cap of [0, 280]) {
      state.cap = cap
      const { unmount } = render(<SpendCap />)
      await waitFor(() =>
        expect(document.body.textContent).toMatch(/sessions you started yourself are never touched/i),
      )
      unmount()
    }
  })

  it('says paused rather than killed, because that is what happens', async () => {
    state.cap = 280
    render(<SpendCap />)
    await waitFor(() => expect(document.body.textContent).toMatch(/paused, not killed/i))
  })
})
