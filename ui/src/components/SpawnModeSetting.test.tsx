/**
 * Settings → New sessions. Someone who always runs with permissions skipped
 * says so once, here, instead of in every dialog; the daemon keeps it so the
 * app, a browser and the phone agree.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Settings } from '@/lib/api'

const state = vi.hoisted(() => ({ mode: '', idle: undefined as string | undefined, saved: [] as string[], patches: [] as Partial<Settings>[] }))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      settings: async (): Promise<Settings> =>
        ({ update_checks: false, plan_kind: '', plan_label: '', plan_usd_per_month: 0, spawn_permission_mode: state.mode, end_idle_after: state.idle }) as Settings,
      saveSettings: async (s: Partial<Settings>) => {
        state.patches.push(s)
        if (s.spawn_permission_mode !== undefined) {
          state.saved.push(s.spawn_permission_mode)
          state.mode = s.spawn_permission_mode
        }
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
    expect((await screen.findByRole('radio', { name: /Accept edits/ })).getAttribute('aria-checked')).toBe('true')
  })

  it('saves only the mode, and shows the choice at once', async () => {
    state.mode = ''
    state.saved = []
    render(<SpawnModeSetting />)
    fireEvent.click(await screen.findByRole('radio', { name: /Bypass/ }))
    await waitFor(() => expect(state.saved).toEqual(['bypassPermissions']))
    expect(screen.getByRole('radio', { name: /Bypass/ }).getAttribute('aria-checked')).toBe('true')
  })

  it('offers ending idle chats, 12 h when never chosen, and saves only that choice', async () => {
    state.idle = undefined
    state.patches = []
    render(<SpawnModeSetting />)
    const group = await screen.findByRole('radiogroup', { name: 'End idle chats after' })
    const radios = Array.from(group.querySelectorAll('[role="radio"]')).map((r) => r.textContent)
    expect(radios).toEqual(['2 h', '12 h', '24 h', 'Never'])
    expect(screen.getByRole('radio', { name: '12 h' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('radio', { name: 'Never' }))
    await waitFor(() => expect(state.patches).toEqual([{ end_idle_after: 'never' }]))
    expect(screen.getByRole('radio', { name: 'Never' }).getAttribute('aria-checked')).toBe('true')
    expect(document.querySelector('[data-end-idle-hint]')!.textContent).toMatch(/keep running with no tab/)
  })

  it('shows the stored choice', async () => {
    state.idle = '2h'
    render(<SpawnModeSetting />)
    expect((await screen.findByRole('radio', { name: '2 h' })).getAttribute('aria-checked')).toBe('true')
    expect(document.querySelector('[data-end-idle-hint]')!.textContent).toMatch(/never ended/)
  })
})
