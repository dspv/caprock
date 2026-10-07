/**
 * Settings → New sessions. Someone who always runs with permissions skipped
 * says so once, here, instead of in every dialog; the daemon keeps it so the
 * app, a browser and the phone agree.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Settings } from '@/lib/api'

const state = vi.hoisted(() => ({ mode: '', saved: [] as string[] }))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      settings: async (): Promise<Settings> =>
        ({ update_checks: false, plan_kind: '', plan_label: '', plan_usd_per_month: 0, spawn_permission_mode: state.mode }) as Settings,
      saveSettings: async (s: Partial<Settings>) => {
        state.saved.push(s.spawn_permission_mode as string)
        state.mode = s.spawn_permission_mode as string
        return s as Settings
      },
    },
  }
})

import { SpawnModeSetting } from './SpawnModeSetting'

describe('SpawnModeSetting', () => {
  it('shows what the dialogs open on when nothing is set', async () => {
    state.mode = ''
    render(<SpawnModeSetting />)
    expect((await screen.findByRole('radio', { name: /Bypass/ })).getAttribute('aria-checked')).toBe('true')
  })

  it('saves only the mode, and shows the choice at once', async () => {
    state.mode = ''
    state.saved = []
    render(<SpawnModeSetting />)
    fireEvent.click(await screen.findByRole('radio', { name: /Bypass/ }))
    await waitFor(() => expect(state.saved).toEqual(['bypassPermissions']))
    expect(screen.getByRole('radio', { name: /Bypass/ }).getAttribute('aria-checked')).toBe('true')
  })
})
