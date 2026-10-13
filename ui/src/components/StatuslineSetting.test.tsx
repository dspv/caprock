/**
 * Settings → Status line. Full until chosen, so nobody's line changes unless
 * they pick something; a choice saves only the mode and shows at once. Hidden
 * is recommended in words, never picked for anyone.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Settings } from '@/lib/api'

const state = vi.hoisted(() => ({ mode: undefined as string | undefined, saved: [] as Partial<Settings>[] }))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      settings: async (): Promise<Settings> =>
        ({ update_checks: false, plan_kind: '', plan_label: '', plan_usd_per_month: 0, statusline_mode: state.mode }) as Settings,
      saveSettings: async (s: Partial<Settings>) => {
        state.saved.push(s)
        state.mode = s.statusline_mode
        return s as Settings
      },
    },
  }
})

import { StatuslineSetting } from './StatuslineSetting'

describe('StatuslineSetting', () => {
  it('is Full when never chosen', async () => {
    state.mode = undefined
    render(<StatuslineSetting />)
    expect((await screen.findByRole('radio', { name: 'Full' })).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText(/cost, turns, steps/)).toBeTruthy()
  })

  it('saves only the mode, and says what Short and Off mean', async () => {
    state.mode = 'full'
    state.saved = []
    render(<StatuslineSetting />)
    fireEvent.click(await screen.findByRole('radio', { name: 'Short' }))
    await waitFor(() => expect(state.saved).toEqual([{ statusline_mode: 'short' }]))
    expect(screen.getByRole('radio', { name: 'Short' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText(/only once the 5-hour window is at 80%/)).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: 'Off' }))
    await waitFor(() => expect(state.saved.at(-1)).toEqual({ statusline_mode: 'off' }))
    expect(screen.getByText(/removed from Claude Code/)).toBeTruthy()
    expect(screen.getByText(/stops your plan limits reaching Caprock/)).toBeTruthy()
    expect(screen.getByText(/pick Hidden/)).toBeTruthy()
    expect(screen.getByText(/never changed/)).toBeTruthy()
  })

  it('offers Hidden, recommends it until chosen, and says the limits keep coming', async () => {
    state.mode = 'full'
    state.saved = []
    const { container } = render(<StatuslineSetting />)
    const radios = (await screen.findAllByRole('radio')).map((r) => r.textContent)
    expect(radios).toEqual(['Full', 'Short', 'Hidden', 'Off'])
    expect(container.querySelector('[data-statusline-recommend]')?.textContent).toMatch(/Recommended: Hidden/)
    fireEvent.click(screen.getByRole('radio', { name: 'Hidden' }))
    await waitFor(() => expect(state.saved).toEqual([{ statusline_mode: 'hidden' }]))
    expect(screen.getByRole('radio', { name: 'Hidden' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText(/still reach Caprock/)).toBeTruthy()
    expect(container.querySelector('[data-statusline-recommend]')).toBeNull()
  })
})
