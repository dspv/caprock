/** Settings → Updates: the release check, Check now, and Ask me / Update automatically in the app. */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings, UpdateStatus } from '@/lib/api'
import { resetAppUpdate, type AppUpdateInfo } from '@/lib/appupdate'

const h = vi.hoisted(() => ({
  settings: undefined as unknown as Settings,
  saved: [] as unknown[],
  checks: 0,
}))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  const st: UpdateStatus = { enabled: true, current: 'v0.79.0', latest: 'v0.79.0', update_available: false, checked_at: Date.now() - 5 * 60_000 }
  return {
    ...actual,
    api: {
      ...actual.api,
      update: async () => st,
      checkUpdate: async () => { h.checks++; return { ...st, latest: 'v0.80.0', update_available: true, checked_at: Date.now() } },
      settings: async () => h.settings,
      saveSettings: async (p: unknown) => { h.saved.push(p); return {} },
    },
  }
})

import { UpdatesSetting } from './UpdatesSetting'

describe('Settings → Updates', () => {
  let invoke: ReturnType<typeof vi.fn>
  beforeEach(() => {
    resetAppUpdate()
    h.saved = []
    h.checks = 0
    // The settings cache is shared by the file: checks start off.
    h.settings = { update_checks: false, app_update: 'ask', plan_kind: '', plan_label: '', plan_usd_per_month: 0 }
    const app: AppUpdateInfo = { version: '0.79.0', supported: true, asked: true, phase: 'idle' }
    invoke = vi.fn(async (cmd: string) => {
      if (cmd === 'app_update_status' || cmd === 'app_update_check') return app
      throw new Error(cmd)
    })
    ;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke }
  })
  afterEach(() => { delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ })

  it('offers Ask me by default; Update automatically is saved and turns the check on', async () => {
    render(<UpdatesSetting />)
    const ask = await screen.findByRole('radio', { name: 'Ask me' })
    expect(ask).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('button', { name: 'Check now' })).toBeDisabled()
    fireEvent.click(screen.getByRole('radio', { name: 'Update automatically' }))
    expect(h.saved).toContainEqual({ app_update: 'auto', update_checks: true })
    expect(screen.getByRole('radio', { name: 'Update automatically' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText(/no agent is working or waiting for your answer/)).toBeTruthy()
  })

  it('Check now asks the daemon and the app’s updater, and shows what it found', async () => {
    render(<UpdatesSetting />)
    const btn = await screen.findByRole('button', { name: 'Check now' })
    expect(btn).not.toBeDisabled() // on since the test above
    await act(async () => { fireEvent.click(btn) })
    expect(h.checks).toBe(1)
    expect(invoke).toHaveBeenCalledWith('app_update_check', {})
    expect(screen.getByText('v0.80.0 is out')).toBeTruthy()
  })
})
