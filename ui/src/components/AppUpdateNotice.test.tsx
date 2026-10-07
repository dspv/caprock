import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateStatus } from '@/lib/api'
import { APP_UPDATE_EVENT, resetAppUpdate, type AppUpdateInfo } from '@/lib/appupdate'

const h = vi.hoisted(() => ({ st: undefined as unknown, calls: 0 }))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, update: async () => { h.calls++; return h.st } } }
})

import { AppUpdateNotice, upgradeCommands } from './AppUpdateNotice'

const base: UpdateStatus = { enabled: true, current: 'v0.77.0', latest: 'v0.78.0', update_available: true, url: 'https://github.com/dspv/caprock/releases/latest' }

beforeEach(() => {
  localStorage.clear()
  h.calls = 0
  resetAppUpdate()
})

describe('the app update notice (F12)', () => {
  it('names the cask and the formula commands, app first, and nothing invented', () => {
    expect(upgradeCommands({ ...base, app_command: 'brew update && brew upgrade --cask caprock-app', command: 'brew update && brew upgrade caprock' }))
      .toEqual([
        { label: 'The app', command: 'brew update && brew upgrade --cask caprock-app' },
        { label: 'The daemon', command: 'brew update && brew upgrade caprock' },
      ])
    expect(upgradeCommands({ ...base, command: 'brew update && brew upgrade caprock' })).toEqual([{ label: 'Caprock', command: 'brew update && brew upgrade caprock' }])
    expect(upgradeCommands(base)).toEqual([])
  })

  it('shows quietly, opens to the command, and is dismissed for that version only', async () => {
    h.st = { ...base, app_command: 'brew update && brew upgrade --cask caprock-app' }
    const { unmount } = render(<AppUpdateNotice />)
    const pill = await screen.findByRole('button', { name: 'v0.78.0 is out' })
    fireEvent.click(pill)
    expect(screen.getByText('$ brew update && brew upgrade --cask caprock-app')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(screen.queryByText('v0.78.0 is out')).toBeNull()
    expect(localStorage.getItem('caprock.update.dismissed')).toBe('v0.78.0')
    unmount()
    // The next release speaks up again.
    h.st = { ...base, latest: 'v0.79.0' }
    render(<AppUpdateNotice />)
    expect(await screen.findByRole('button', { name: 'v0.79.0 is out' })).toBeTruthy()
  })

  it('says nothing while checks are off or nothing is newer', async () => {
    h.st = { ...base, enabled: false, update_available: false, latest: undefined }
    render(<AppUpdateNotice />)
    await act(async () => { await Promise.resolve() })
    expect(h.calls).toBe(1)
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('in the desktop app, one click (F20)', () => {
  let app: AppUpdateInfo
  let invoke: ReturnType<typeof vi.fn>

  const emit = (over: Record<string, unknown>) => {
    app = { ...app, ...over } as AppUpdateInfo
    act(() => { window.dispatchEvent(new CustomEvent(APP_UPDATE_EVENT, { detail: app })) })
  }

  beforeEach(() => {
    app = { version: '0.77.0', supported: true, asked: true, phase: 'idle' }
    invoke = vi.fn(async (cmd: string) => {
      if (cmd === 'app_update_status' || cmd === 'app_update_check') return app
      if (cmd === 'app_update_install') return new Promise(() => { /* restarts; never answers */ })
      throw new Error(cmd)
    })
    ;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke }
  })
  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })

  it('offers Update — Restart and walks through download, install and restart', async () => {
    h.st = base
    render(<AppUpdateNotice />)
    fireEvent.click(await screen.findByRole('button', { name: 'Update to v0.78.0 — Restart' }))
    expect(invoke).toHaveBeenCalledWith('app_update_install', {})
    emit({ phase: 'downloading', next: '0.78.0', downloaded: 0, total: 1000 })
    expect(screen.getByRole('status')).toHaveTextContent('Downloading v0.78.0')
    emit({ phase: 'downloading', next: '0.78.0', downloaded: 420, total: 1000 })
    expect(screen.getByRole('status')).toHaveTextContent('42%')
    emit({ phase: 'installing', next: '0.78.0' })
    expect(screen.getByRole('status')).toHaveTextContent('Installing v0.78.0 — restarting…')
  })

  it('opens a failure with the reason, Try again and the release page', async () => {
    h.st = base
    render(<AppUpdateNotice />)
    await screen.findByRole('button', { name: 'Update to v0.78.0 — Restart' })
    emit({ phase: 'failed', error: 'The update’s signature did not verify, so nothing was installed.' })
    const dialog = screen.getByRole('dialog', { name: 'The update did not install' })
    expect(dialog).toHaveTextContent('signature did not verify')
    expect(dialog).toHaveTextContent('Caprock v0.77.0 keeps running')
    expect(screen.getByRole('link', { name: 'release page' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(invoke).toHaveBeenCalledWith('app_update_install', {})
  })

  it('a failure waved away with Not now goes quiet', async () => {
    h.st = base
    render(<AppUpdateNotice />)
    await screen.findByRole('button', { name: 'Update to v0.78.0 — Restart' })
    emit({ phase: 'failed', error: 'Could not reach GitHub' })
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(screen.queryByText('Update failed')).toBeNull()
  })

  it('answers a check from the menu, even with checks off: checking, then up to date for a moment', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      h.st = { ...base, enabled: false, update_available: false, latest: undefined }
      render(<AppUpdateNotice />)
      await act(async () => { await Promise.resolve() })
      emit({ phase: 'checking' })
      expect(screen.getByRole('status')).toHaveTextContent('Checking for updates…')
      emit({ phase: 'up_to_date' })
      expect(screen.getByRole('status')).toHaveTextContent('Caprock is up to date')
      act(() => { vi.advanceTimersByTime(7000) })
      expect(screen.queryByRole('status')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a dismissed version is offered again when the user checks by hand', async () => {
    localStorage.setItem('caprock.update.dismissed', 'v0.78.0')
    h.st = base
    render(<AppUpdateNotice />)
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByRole('button', { name: /Update to/ })).toBeNull()
    emit({ phase: 'checking' })
    emit({ phase: 'available', next: '0.78.0' })
    expect(screen.getByRole('button', { name: 'Update to v0.78.0 — Restart' })).toBeTruthy()
  })

  it('an install that cannot update itself says why and gives the command', async () => {
    app = { ...app, supported: false, blocked: 'Installed from the .deb package: install the new Caprock-Linux.deb from the release page with your package manager.' }
    h.st = { ...base, command: 'brew update && brew upgrade caprock' }
    render(<AppUpdateNotice />)
    await act(async () => { await Promise.resolve() })
    fireEvent.click(await screen.findByRole('button', { name: 'v0.78.0 is out' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('Installed from the .deb package')
    expect(screen.getByText('$ brew update && brew upgrade caprock')).toBeTruthy()
    expect(invoke).not.toHaveBeenCalledWith('app_update_install', expect.anything())
  })
})
