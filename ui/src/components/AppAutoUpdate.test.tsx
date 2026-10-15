/** Update automatically: download in the background, restart only when safe, say so after. */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateStatus } from '@/lib/api'
import { APP_UPDATE_EVENT, resetAppUpdate, type AppUpdateInfo } from '@/lib/appupdate'
import { IDLE_MS, RECHECK_MS, UPDATED_KEY, setLastActivity } from '@/lib/autoupdate'

const h = vi.hoisted(() => ({ st: undefined as unknown, working: 0 as number | Error }))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      update: async () => h.st,
      updateBusy: async () => {
        if (h.working instanceof Error) throw h.working
        return { working: h.working }
      },
      settings: async () => ({ update_checks: true, app_update: 'auto', plan_kind: '', plan_label: '', plan_usd_per_month: 0 }),
      saveSettings: async () => ({}),
    },
  }
})

import { AppAutoUpdate, resetAutoUpdate } from './AppAutoUpdate'

const base: UpdateStatus = { enabled: true, current: 'v0.79.0', latest: 'v0.80.0', update_available: true, url: 'https://github.com/dspv/caprock/releases/latest' }
const flush = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }

describe('Update automatically', () => {
  let app: AppUpdateInfo
  let invoke: ReturnType<typeof vi.fn>
  const emit = (over: Record<string, unknown>) => {
    app = { ...app, ...over } as AppUpdateInfo
    act(() => { window.dispatchEvent(new CustomEvent(APP_UPDATE_EVENT, { detail: app })) })
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    localStorage.clear()
    resetAppUpdate()
    resetAutoUpdate()
    h.st = base
    h.working = 0
    app = { version: '0.79.0', supported: true, asked: true, phase: 'idle' }
    invoke = vi.fn(async (cmd: string) => {
      if (cmd === 'app_update_status') return app
      if (cmd === 'app_update_download') return { ...app, phase: 'ready', next: '0.80.0' }
      if (cmd === 'app_update_install') return new Promise(() => { /* restarts */ })
      throw new Error(cmd)
    })
    ;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke }
  })
  afterEach(() => {
    vi.useRealTimers()
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })

  it('downloads a newer version the release check found, once', async () => {
    render(<AppAutoUpdate />)
    await flush()
    await flush(RECHECK_MS)
    expect(invoke.mock.calls.filter(([c]) => c === 'app_update_download')).toHaveLength(1)
    expect(invoke).not.toHaveBeenCalledWith('app_update_install', {})
  })

  it('waits while an agent works, then while the user is around, then gives ten seconds and installs', async () => {
    app = { ...app, phase: 'ready', next: '0.80.0' } as AppUpdateInfo
    h.working = 1
    setLastActivity(Date.now() - IDLE_MS - 1)
    render(<AppAutoUpdate />)
    await flush()
    expect(screen.queryByRole('status', { name: 'Caprock is updating' })).toBeNull()

    // The agent finished, but the user just pressed a key.
    h.working = 0
    setLastActivity(Date.now())
    await flush(RECHECK_MS)
    expect(screen.queryByRole('status', { name: 'Caprock is updating' })).toBeNull()

    // Two minutes alone.
    setLastActivity(Date.now() - IDLE_MS)
    await flush(RECHECK_MS)
    const card = screen.getByRole('status', { name: 'Caprock is updating' })
    expect(card).toHaveTextContent('Updating to 0.80.0 in 10 s')
    expect(card).toHaveTextContent('Sessions and tabs stay as they are.')
    for (let i = 0; i < 10; i++) await flush(1000)
    await flush()
    expect(invoke).toHaveBeenCalledWith('app_update_install', {})
    expect(localStorage.getItem(UPDATED_KEY)).toBe('v0.80.0')
  })

  it('never restarts on a count it could not read', async () => {
    app = { ...app, phase: 'ready', next: '0.80.0' } as AppUpdateInfo
    h.working = new Error('daemon gone')
    setLastActivity(Date.now() - IDLE_MS - 1)
    render(<AppAutoUpdate />)
    await flush(RECHECK_MS * 3)
    expect(screen.queryByRole('status', { name: 'Caprock is updating' })).toBeNull()
    expect(invoke).not.toHaveBeenCalledWith('app_update_install', {})
  })

  it('waits while something typed is not sent', async () => {
    app = { ...app, phase: 'ready', next: '0.80.0' } as AppUpdateInfo
    const draft = document.createElement('textarea')
    draft.value = 'half a prompt'
    document.body.appendChild(draft)
    setLastActivity(Date.now() - IDLE_MS - 1)
    render(<AppAutoUpdate />)
    await flush(RECHECK_MS)
    expect(screen.queryByRole('status', { name: 'Caprock is updating' })).toBeNull()
    draft.remove()
  })

  it('Not now holds the version back for the hour; a key press calls the notice off', async () => {
    app = { ...app, phase: 'ready', next: '0.80.0' } as AppUpdateInfo
    setLastActivity(Date.now() - IDLE_MS - 1)
    render(<AppAutoUpdate />)
    await flush()
    expect(screen.getByRole('status', { name: 'Caprock is updating' })).toBeTruthy()
    fireEvent.keyDown(window, { key: 'a' })
    await flush()
    expect(screen.queryByRole('status', { name: 'Caprock is updating' })).toBeNull()

    setLastActivity(Date.now() - IDLE_MS - 1)
    await flush(RECHECK_MS)
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    setLastActivity(Date.now() - IDLE_MS - 1)
    await flush(RECHECK_MS * 4)
    expect(screen.queryByRole('status', { name: 'Caprock is updating' })).toBeNull()
    expect(invoke).not.toHaveBeenCalledWith('app_update_install', {})
  })

  it('Restart now restarts at once', async () => {
    app = { ...app, phase: 'ready', next: '0.80.0' } as AppUpdateInfo
    setLastActivity(Date.now() - IDLE_MS - 1)
    render(<AppAutoUpdate />)
    await flush()
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Restart now' }))
    fireEvent.click(screen.getByRole('button', { name: 'Restart now' }))
    expect(invoke).toHaveBeenCalledWith('app_update_install', {})
  })

  it('says what it updated to after the restart, once', async () => {
    localStorage.setItem(UPDATED_KEY, 'v0.80.0')
    app = { ...app, version: '0.80.0' }
    h.st = { ...base, current: 'v0.80.0', update_available: false }
    const { unmount } = render(<AppAutoUpdate />)
    await flush()
    expect(screen.getByRole('status', { name: 'Caprock updated' })).toHaveTextContent('Updated to 0.80.0')
    expect(screen.getByRole('button', { name: 'What’s new' })).toBeTruthy()
    unmount()
    render(<AppAutoUpdate />)
    await flush()
    expect(screen.queryByRole('status', { name: 'Caprock updated' })).toBeNull()
  })

  it('is quiet where the app cannot replace itself', async () => {
    app = { ...app, supported: false }
    render(<AppAutoUpdate />)
    await flush(RECHECK_MS)
    expect(invoke).not.toHaveBeenCalledWith('app_update_download', {})
    emit({ phase: 'idle' })
  })
})
