/**
 * Keep awake (ADR-049): three modes saved by the daemon, a line saying what
 * is happening now, and a status-strip mark only while the machine is held.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { KeepAwakeStatus, Settings } from '@/lib/api'

const state = vi.hoisted(() => ({
  mode: undefined as string | undefined,
  saved: [] as string[],
  status: { mode: 'working', holding: false, working: 0, available: true } as KeepAwakeStatus,
}))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    isPairedDevice: () => false,
    api: {
      ...actual.api,
      settings: async (): Promise<Settings> =>
        ({ update_checks: false, plan_kind: '', plan_label: '', plan_usd_per_month: 0, keep_awake: state.mode }) as Settings,
      saveSettings: async (s: Partial<Settings>) => {
        state.saved.push(s.keep_awake as string)
        return s as Settings
      },
      keepAwake: async () => state.status,
    },
  }
})

import { KeepAwakeIndicator, KeepAwakeSetting, keepAwakeLine } from './KeepAwake'

describe('KeepAwakeSetting', () => {
  it('opens on While agents work when the daemon says so', async () => {
    state.mode = 'working'
    render(<KeepAwakeSetting />)
    expect((await screen.findByRole('radio', { name: 'While agents work' })).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText(/does not fall asleep while an agent is working/)).toBeInTheDocument()
  })

  it('saves only the mode and shows it at once', async () => {
    state.mode = 'working'
    state.saved = []
    render(<KeepAwakeSetting />)
    fireEvent.click(await screen.findByRole('radio', { name: 'Off' }))
    await waitFor(() => expect(state.saved).toEqual(['off']))
    expect(screen.getByRole('radio', { name: 'Off' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText(/sleeps on its usual schedule/)).toBeInTheDocument()
  })

  it('says how many agents keep it awake', async () => {
    state.mode = 'working'
    state.status = { mode: 'working', holding: true, working: 2, available: true }
    render(<KeepAwakeSetting />)
    expect(await screen.findByText(/Keeping this computer awake now · 2 agents working/)).toBeInTheDocument()
    expect(screen.getByText('awake now')).toBeInTheDocument()
  })
})

describe('keepAwakeLine', () => {
  it('names why it cannot, before anything else', () => {
    expect(keepAwakeLine({ mode: 'working', holding: false, working: 1, available: false, reason: 'systemd-inhibit was not found' }))
      .toBe('systemd-inhibit was not found')
  })
  it('reports a failed hold', () => {
    expect(keepAwakeLine({ mode: 'always', holding: false, working: 0, available: true, error: 'boom' })).toMatch(/Could not keep the computer awake: boom/)
  })
  it('says the computer may sleep when nothing works', () => {
    expect(keepAwakeLine({ mode: 'working', holding: false, working: 0, available: true })).toMatch(/may sleep/)
  })
})

describe('KeepAwakeIndicator', () => {
  it('says the computer may sleep, faint, while nothing holds it', async () => {
    state.status = { mode: 'working', holding: false, working: 0, available: true }
    render(<KeepAwakeIndicator />)
    const mark = await screen.findByText('may sleep')
    expect(mark.closest('[data-keep-awake]')?.getAttribute('data-holding')).toBe('false')
  })

  it('stays visible when keep-awake is off, and opens the modes from there', async () => {
    state.status = { mode: 'off', holding: false, working: 0, available: true }
    render(<KeepAwakeIndicator />)
    const mark = await screen.findByText('awake off')
    expect(mark.closest('[data-keep-awake]')?.getAttribute('data-holding')).toBe('false')
    fireEvent.click(mark)
    expect(await screen.findByRole('dialog', { name: 'Keep awake' })).toBeTruthy()
  })

  it('opens what it means and the three modes on a click', async () => {
    state.status = { mode: 'working', holding: true, working: 2, available: true }
    render(<KeepAwakeIndicator />)
    fireEvent.click(await screen.findByText('awake'))
    const pop = await screen.findByRole('dialog', { name: 'Keep awake' })
    expect(within(pop).getByRole('radio', { name: 'While agents work' }).getAttribute('aria-checked')).toBe('true')
    expect(within(pop).getByText(/2 agents working/)).toBeTruthy()
    fireEvent.click(within(pop).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog', { name: 'Keep awake' })).toBeNull()
  })

  it('shows a mark while holding, with why in its title', async () => {
    state.status = { mode: 'working', holding: true, working: 1, available: true }
    render(<KeepAwakeIndicator />)
    const mark = await screen.findByText('awake')
    expect(mark.closest('[data-keep-awake]')?.getAttribute('title')).toMatch(/1 agent is working/)
  })
})
