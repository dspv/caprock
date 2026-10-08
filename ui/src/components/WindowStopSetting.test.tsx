/**
 * The plan-window stop pauses someone's work on figures Caprock did not
 * measure itself. What is tested is that its one control says what it is set
 * to, saves what was clicked, and says out loud when it cannot act.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Settings, WindowStop } from '@/lib/api'

const NOW = Date.parse('2026-10-09T12:00:00Z')

const state = vi.hoisted(() => ({
  saved: [] as Partial<Settings>[],
  ws: undefined as WindowStop | undefined,
}))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      // Never chosen: the daemon answers with the default, 90.
      settings: async (): Promise<Settings> =>
        ({ update_checks: false, plan_kind: '', plan_label: '', plan_usd_per_month: 0, window_stop_pct: 90 }) as Settings,
      saveSettings: async (s: Partial<Settings>) => {
        state.saved.push(s)
        return s as Settings
      },
      windowStop: async () => state.ws,
    },
  }
})

import { WindowStopSetting } from './WindowStopSetting'

function stop(over: Partial<WindowStop> = {}): WindowStop {
  return { pct: 90, licensed: true, fresh_for_s: 600, windows: [], paused: [], ...over }
}

describe('WindowStopSetting', () => {
  it('starts at 90%, the free alert’s own line, and saves the share clicked', async () => {
    state.ws = stop()
    render(<WindowStopSetting now={NOW} />)
    await waitFor(() => expect(screen.getByRole('radio', { name: '90%' }).getAttribute('aria-checked')).toBe('true'))
    // The promise printed on the control: only Caprock's own sessions.
    expect(document.body.textContent).toMatch(/Sessions you started yourself are never touched/)
    expect(document.body.textContent).toMatch(/resumes them after the window resets/)

    fireEvent.click(screen.getByRole('radio', { name: '95%' }))
    expect(state.saved.at(-1)).toEqual({ window_stop_pct: 95 })
    expect(screen.getByRole('radio', { name: '95%' }).getAttribute('aria-checked')).toBe('true')
  })

  it('can be turned off, and says the free alert stays', async () => {
    state.ws = stop()
    render(<WindowStopSetting now={NOW} />)
    await waitFor(() => screen.getByRole('radio', { name: 'Off' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Off' }))
    expect(state.saved.at(-1)).toEqual({ window_stop_pct: 0 })
    expect(document.body.textContent).toMatch(/Off\. Nothing is paused/)
    expect(document.body.textContent).toMatch(/alert at 90%/)
  })

  it('says when it has no figures to act on, and where they come from', async () => {
    state.ws = stop({ windows: [] })
    render(<WindowStopSetting now={NOW} />)
    await waitFor(() => expect(document.body.textContent).toMatch(/No plan figures yet/))
    expect(document.body.textContent).toMatch(/caprock statusline install/)
  })

  it('says when its figures are too old to act on, rather than looking armed', async () => {
    state.ws = stop({
      windows: [{
        window: 'five_hour', used_percentage: 93, resets_at: NOW / 1000 + 3600,
        observed_at: NOW - 40 * 60_000, fresh: false, stale: 'figures older than ten minutes',
      }],
    })
    render(<WindowStopSetting now={NOW} />)
    await waitFor(() => expect(screen.getByTestId('window-figures').textContent).toMatch(/5-hour 93%/))
    expect(screen.getByTestId('window-figures').textContent).toMatch(/Too old to act on/)
    expect(screen.getByTestId('window-figures').textContent).toMatch(/older than 10 minutes/)
  })

  it('names the sessions it has paused and when they resume', async () => {
    state.ws = stop({
      windows: [{ window: 'five_hour', used_percentage: 91, resets_at: NOW / 1000 + 1800, observed_at: NOW - 60_000, fresh: true }],
      paused: [{ session_id: 'abc12345-x', project: 'acme-api', window: 'five_hour', resume_at: NOW / 1000 + 1800, paused_at: NOW - 60_000 }],
    })
    render(<WindowStopSetting now={NOW} />)
    await waitFor(() => expect(document.body.textContent).toMatch(/acme-api/))
    expect(document.body.textContent).toMatch(/paused · resumes after/)
    expect(screen.getByTestId('window-figures').textContent).toMatch(/next reset is in 30 min/)
  })
})
