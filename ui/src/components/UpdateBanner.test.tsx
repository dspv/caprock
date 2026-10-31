/**
 * The upgrade banner's warning about running sessions.
 *
 * Upgrading restarts the daemon, and the sessions Caprock started are its
 * children — so they end with it. They get a few seconds to stop cleanly, but
 * the work stops either way, and a user who finds that out afterwards has lost
 * a turn they were in the middle of. The banner has to say so before they copy
 * the command, and only when there is actually something to lose.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_UPDATE_EVENT, resetAppUpdate, type AppUpdateInfo } from '@/lib/appupdate'
import { UpdateBanner } from './UpdateBanner'
import type { Settings } from '@/lib/api'

const status = vi.hoisted(() => ({
  value: {
    enabled: true,
    current: 'v0.39.0',
    latest: 'v0.40.0',
    update_available: true,
    command: 'brew upgrade caprock',
    url: 'https://example.invalid/releases',
  },
}))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, update: async () => status.value } }
})

const plan = { update_checks: true } as Settings

describe('UpdateBanner', () => {
  it('warns that spawned sessions will close, before the command', async () => {
    render(<UpdateBanner plan={plan} onSave={() => {}} now={Date.now()} owned={2} />)
    await waitFor(() => expect(screen.getByText(/2 sessions Caprock started will close/)).toBeInTheDocument())
  })

  it('says it in the singular for one session', async () => {
    render(<UpdateBanner plan={plan} onSave={() => {}} now={Date.now()} owned={1} />)
    await waitFor(() => expect(screen.getByText(/1 session Caprock started will close/)).toBeInTheDocument())
  })

  // Sessions the user started themselves survive an upgrade untouched, so a
  // warning with nothing behind it would be noise on every banner.
  it('stays quiet when nothing would be lost', async () => {
    render(<UpdateBanner plan={plan} onSave={() => {}} now={Date.now()} owned={0} />)
    await waitFor(() => expect(screen.getByText(/is available/)).toBeInTheDocument())
    expect(screen.queryByText(/will close/)).not.toBeInTheDocument()
  })
})

describe('UpdateBanner in the desktop app (owner, 2026-10-31: seamless, not a link)', () => {
  let app: AppUpdateInfo
  let invoke: ReturnType<typeof vi.fn>
  const emit = (over: Record<string, unknown>) => {
    app = { ...app, ...over } as AppUpdateInfo
    act(() => { window.dispatchEvent(new CustomEvent(APP_UPDATE_EVENT, { detail: app })) })
  }
  beforeEach(() => {
    localStorage.clear()
    resetAppUpdate()
    status.value = { ...status.value, command: '' }
    app = { version: '0.39.0', supported: true, asked: true, phase: 'idle' }
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

  it('updates in place with a progress bar instead of linking to the release page', async () => {
    render(<UpdateBanner plan={plan} onSave={() => {}} now={Date.now()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Update to v0.40.0 — Restart' }))
    expect(screen.queryByText('Download it')).toBeNull()
    expect(invoke).toHaveBeenCalledWith('app_update_install', {})
    emit({ phase: 'downloading', next: '0.40.0', downloaded: 420, total: 1000 })
    expect(screen.getByText('Downloading Caprock v0.40.0')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('42%')
    expect(screen.queryByRole('button', { name: 'Not now' })).toBeNull()
    emit({ phase: 'installing', next: '0.40.0' })
    expect(screen.getByText('Installing Caprock v0.40.0 — restarting…')).toBeInTheDocument()
  })

  it('says a failed install and offers it again', async () => {
    render(<UpdateBanner plan={plan} onSave={() => {}} now={Date.now()} />)
    await screen.findByRole('button', { name: 'Update to v0.40.0 — Restart' })
    emit({ phase: 'failed', error: 'signature did not verify' })
    expect(screen.getByText('signature did not verify')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(invoke).toHaveBeenCalledWith('app_update_install', {})
  })
})
