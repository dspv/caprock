/** The update card in the corner: once per version, with progress, in the app only. */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateStatus } from '@/lib/api'
import { APP_UPDATE_EVENT, resetAppUpdate, type AppUpdateInfo } from '@/lib/appupdate'

const h = vi.hoisted(() => ({ st: undefined as unknown, saved: [] as unknown[] }))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      update: async () => h.st,
      settings: async () => ({ update_checks: true, app_update: 'ask', plan_kind: '', plan_label: '', plan_usd_per_month: 0 }),
      saveSettings: async (p: unknown) => { h.saved.push(p); return {} },
    },
  }
})

import { AppUpdateToast, TOAST_KEY } from './AppUpdateToast'

const base: UpdateStatus = { enabled: true, current: 'v0.79.0', latest: 'v0.80.0', update_available: true, url: 'https://github.com/dspv/caprock/releases/latest' }

describe('the update card', () => {
  let app: AppUpdateInfo
  let invoke: ReturnType<typeof vi.fn>
  const emit = (over: Record<string, unknown>) => {
    app = { ...app, ...over } as AppUpdateInfo
    act(() => { window.dispatchEvent(new CustomEvent(APP_UPDATE_EVENT, { detail: app })) })
  }

  beforeEach(() => {
    localStorage.clear()
    resetAppUpdate()
    h.st = base
    app = { version: '0.79.0', supported: true, asked: true, phase: 'idle' }
    invoke = vi.fn(async (cmd: string) => {
      if (cmd === 'app_update_status' || cmd === 'app_update_check') return app
      if (cmd === 'app_update_install') return new Promise(() => { /* restarts */ })
      throw new Error(cmd)
    })
    ;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke }
  })
  afterEach(() => { delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ })

  it('announces a newer version and updates with one click, showing progress', async () => {
    render(<AppUpdateToast />)
    // From what to what, at a glance (owner, 2026-10-11).
    expect((await screen.findByText('0.80.0')).closest('[data-update-from-to]')?.textContent).toMatch(/^Update.*→0\.80\.0$/)
    fireEvent.click(screen.getByRole('button', { name: 'Update and restart' }))
    expect(invoke).toHaveBeenCalledWith('app_update_install', {})
    emit({ phase: 'downloading', next: '0.80.0', downloaded: 250, total: 1000 })
    expect(screen.getByRole('status', { name: 'Caprock update' })).toHaveTextContent('25%')
    emit({ phase: 'installing', next: '0.80.0' })
    expect(screen.getByRole('status', { name: 'Caprock update' })).toHaveTextContent('restarts in a moment')
  })

  it('Later puts it away for that version only', async () => {
    const { unmount } = render(<AppUpdateToast />)
    fireEvent.click(await screen.findByRole('button', { name: 'Later' }))
    expect(screen.queryByText('0.80.0')).toBeNull()
    expect(localStorage.getItem(TOAST_KEY)).toBe('v0.80.0')
    unmount()
    h.st = { ...base, latest: 'v0.81.0' }
    render(<AppUpdateToast />)
    expect(await screen.findByText('0.81.0')).toBeTruthy()
  })

  it('says nothing where the app cannot replace itself, or nothing is newer', async () => {
    app = { ...app, supported: false }
    const { unmount } = render(<AppUpdateToast />)
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByRole('status')).toBeNull()
    unmount()
    app = { ...app, supported: true }
    h.st = { ...base, latest: 'v0.79.0', update_available: false }
    render(<AppUpdateToast />)
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByRole('status')).toBeNull()
  })

  // Last: it switches the shared settings cache to auto for the rest of the file.
  it('Always update automatically flips the setting, and from then on the card does not ask', async () => {
    render(<AppUpdateToast />)
    fireEvent.click(await screen.findByRole('button', { name: 'Always update automatically' }))
    expect(h.saved).toContainEqual({ app_update: 'auto', update_checks: true })
    // No restart now: the automatic path waits for a quiet moment.
    expect(invoke).not.toHaveBeenCalledWith('app_update_install', {})
    expect(screen.queryByText('0.80.0')).toBeNull()
  })
})
