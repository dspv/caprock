import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { appUpdate, GAP_RECHECK_MAX, GAP_RECHECK_MS, gapRechecking, newerVersion, offerFor, recheckOnOpen, resetAppUpdate, updaterGap, useGapRecheck, type AppUpdateInfo } from './appupdate'
import type { UpdateStatus } from './api'

const app = (over: Partial<AppUpdateInfo> = {}): AppUpdateInfo => ({ version: '0.78.1', supported: true, asked: true, phase: 'idle', ...over } as AppUpdateInfo)
const daemon: UpdateStatus = { enabled: true, current: 'v0.78.1', latest: 'v0.79.0', update_available: true, url: 'https://github.com/dspv/caprock/releases/latest' }

describe('newerVersion', () => {
  it('compares versions with or without the v, a pre-release below its release', () => {
    expect(newerVersion('v0.79.0', '0.78.1')).toBe(true)
    expect(newerVersion('0.78.1', 'v0.78.1')).toBe(false)
    expect(newerVersion('0.78.10', '0.78.9')).toBe(true)
    expect(newerVersion('1.0.0', '0.99.99')).toBe(true)
    expect(newerVersion('0.79.0-rc.1', '0.79.0')).toBe(false)
    expect(newerVersion('0.79.0', '0.79.0-rc.1')).toBe(true)
    expect(newerVersion('0.0.2-test', '0.0.1-test')).toBe(true)
    expect(newerVersion('dev', '0.1.0')).toBe(false)
    expect(newerVersion(undefined, '0.1.0')).toBe(false)
  })
})

describe('offerFor (F20)', () => {
  it('offers one click when the daemon knows a newer release and this app can update itself', () => {
    expect(offerFor(app(), daemon, '')).toEqual({ kind: 'install', next: 'v0.79.0' })
  })

  it('compares with the app, not the daemon: an app already on the latest offers nothing', () => {
    expect(offerFor(app({ version: '0.79.0' }), { ...daemon, current: 'v0.78.0' }, '')).toEqual({ kind: 'none' })
  })

  it('says nothing while checks are off, unless the user checked by hand', () => {
    expect(offerFor(app(), { ...daemon, enabled: false }, '')).toEqual({ kind: 'none' })
    expect(offerFor(app({ phase: 'available', next: '0.79.0' }), { ...daemon, enabled: false }, '')).toEqual({ kind: 'install', next: 'v0.79.0' })
  })

  it('hides a version the user said not now to', () => {
    expect(offerFor(app(), daemon, 'v0.79.0')).toEqual({ kind: 'none' })
    expect(offerFor(app({ phase: 'available', next: '0.79.0' }), daemon, 'v0.79.0')).toEqual({ kind: 'none' })
  })

  it('follows a download through to the restart, and a failure', () => {
    expect(offerFor(app({ phase: 'checking' }), daemon, '')).toEqual({ kind: 'checking' })
    expect(offerFor(app({ phase: 'downloading', next: '0.79.0', downloaded: 21, total: 50 }), daemon, '')).toEqual({ kind: 'progress', next: 'v0.79.0', pct: 42 })
    expect(offerFor(app({ phase: 'downloading', next: '0.79.0', downloaded: 21, total: null }), daemon, '')).toEqual({ kind: 'progress', next: 'v0.79.0', pct: null })
    expect(offerFor(app({ phase: 'installing', next: '0.79.0' }), daemon, '')).toEqual({ kind: 'installing', next: 'v0.79.0' })
    expect(offerFor(app({ phase: 'failed', error: 'boom' }), daemon, '')).toEqual({ kind: 'failed', error: 'boom' })
  })

  it('offers a bundle downloaded in the background as one click (Update automatically)', () => {
    expect(offerFor(app({ phase: 'ready', next: '0.79.0' }), daemon, '')).toEqual({ kind: 'install', next: 'v0.79.0' })
  })

  it('says up to date after a check that found nothing', () => {
    expect(offerFor(app({ phase: 'up_to_date' }), { ...daemon, latest: 'v0.78.1', update_available: false }, '')).toEqual({ kind: 'up_to_date', version: 'v0.78.1' })
  })

  it('falls back to the commands where the app cannot update itself, and in a browser', () => {
    const deb = app({ supported: false, blocked: 'Installed from the .deb package: …' })
    expect(offerFor(deb, daemon, '')).toEqual({ kind: 'commands', latest: 'v0.79.0' })
    expect(offerFor(undefined, daemon, '')).toEqual({ kind: 'commands', latest: 'v0.79.0' })
    expect(offerFor(undefined, daemon, 'v0.79.0')).toEqual({ kind: 'none' })
    expect(offerFor(undefined, { ...daemon, enabled: false }, '')).toEqual({ kind: 'none' })
  })
})

// Owner, 2026-11-23: "Caprock 0.189.0 · v0.190.0 is out" over a button that
// read "Update to v0.189.1". The daemon saw the release; latest.json, which
// the app's updater reads, was uploaded minutes later.
describe('the gap between a release and its app update', () => {
  const out: UpdateStatus = { ...daemon, current: 'v0.189.0', latest: 'v0.190.0' }
  const on = (over: Partial<AppUpdateInfo>) => app({ version: '0.189.0', ...over })

  afterEach(() => { resetAppUpdate(); vi.useRealTimers(); vi.restoreAllMocks() })

  it('is a gap while the updater offers an older version, or nothing, than the release', () => {
    expect(updaterGap(on({ phase: 'available', next: '0.189.1' }), out)).toBe('v0.190.0')
    expect(updaterGap(on({ phase: 'ready', next: '0.189.1' }), out)).toBe('v0.190.0')
    expect(updaterGap(on({ phase: 'up_to_date' }), out)).toBe('v0.190.0')
  })

  it('is no gap once they agree, before the updater has asked, or with checks off', () => {
    expect(updaterGap(on({ phase: 'available', next: '0.190.0' }), out)).toBe('')
    expect(updaterGap(on({ phase: 'idle' }), out)).toBe('')
    expect(updaterGap(on({ phase: 'available', next: '0.189.1' }), { ...out, enabled: false })).toBe('')
    expect(updaterGap(on({ phase: 'up_to_date', version: '0.190.0' }), out)).toBe('')
    expect(updaterGap(on({ phase: 'available', next: '0.189.1', supported: false }), out)).toBe('')
  })

  it('offers nothing to install while it lasts, and the newest in one jump once it closes', () => {
    expect(offerFor(on({ phase: 'available', next: '0.189.1' }), out, '')).toEqual({ kind: 'preparing', latest: 'v0.190.0' })
    expect(offerFor(on({ phase: 'ready', next: '0.189.1' }), out, '')).toEqual({ kind: 'preparing', latest: 'v0.190.0' })
    expect(offerFor(on({ phase: 'up_to_date' }), out, '')).toEqual({ kind: 'preparing', latest: 'v0.190.0' })
    expect(offerFor(on({ phase: 'available', next: '0.189.1' }), out, 'v0.190.0')).toEqual({ kind: 'none' })
    expect(offerFor(on({ phase: 'available', next: '0.190.0' }), out, '')).toEqual({ kind: 'install', next: 'v0.190.0' })
  })

  it('re-checks every GAP_RECHECK_MS while it lasts, at most GAP_RECHECK_MAX times', async () => {
    vi.useFakeTimers()
    const recheck = vi.spyOn(appUpdate, 'recheck').mockResolvedValue(undefined)
    const { rerender, unmount } = renderHook(({ i }) => useGapRecheck(i, out), { initialProps: { i: on({ phase: 'available', next: '0.189.1' }) } })
    expect(recheck).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(GAP_RECHECK_MS)
    expect(recheck).toHaveBeenCalledTimes(1)
    expect(recheck).toHaveBeenLastCalledWith('v0.190.0')
    expect(gapRechecking('v0.190.0')).toBe(true)
    await vi.advanceTimersByTimeAsync(GAP_RECHECK_MS * (GAP_RECHECK_MAX + 5))
    expect(recheck).toHaveBeenCalledTimes(GAP_RECHECK_MAX)
    expect(gapRechecking('v0.190.0')).toBe(false)
    // They agree: nothing more.
    recheck.mockClear()
    rerender({ i: on({ phase: 'available', next: '0.190.0' }) })
    await vi.advanceTimersByTimeAsync(GAP_RECHECK_MS * 3)
    expect(recheck).not.toHaveBeenCalled()
    unmount()
  })

  it('stops as soon as the updater offers the release', async () => {
    vi.useFakeTimers()
    const recheck = vi.spyOn(appUpdate, 'recheck').mockResolvedValue(undefined)
    const { rerender, unmount } = renderHook(({ i }) => useGapRecheck(i, out), { initialProps: { i: on({ phase: 'up_to_date' }) } })
    await vi.advanceTimersByTimeAsync(GAP_RECHECK_MS)
    expect(recheck).toHaveBeenCalledTimes(1)
    rerender({ i: on({ phase: 'available', next: '0.190.0' }) })
    await vi.advanceTimersByTimeAsync(GAP_RECHECK_MS * 4)
    expect(recheck).toHaveBeenCalledTimes(1)
    unmount()
  })

  it('asks on opening the panel when the updater lags or never asked, not more than once in a while', () => {
    const recheck = vi.spyOn(appUpdate, 'recheck').mockResolvedValue(undefined)
    const check = vi.spyOn(appUpdate, 'check').mockResolvedValue(undefined)
    expect(recheckOnOpen(on({ phase: 'available', next: '0.189.1' }), out)).toBe(true)
    expect(recheck).toHaveBeenCalledWith('v0.190.0')
    // Opened again a moment later: no second request.
    expect(recheckOnOpen(on({ phase: 'available', next: '0.189.1' }), out)).toBe(false)
    resetAppUpdate()
    // Never asked: an ordinary check.
    expect(recheckOnOpen(on({ phase: 'idle' }), out)).toBe(true)
    expect(check).toHaveBeenCalledTimes(1)
    resetAppUpdate()
    // Already offering the release, busy, or nothing newer: no request.
    expect(recheckOnOpen(on({ phase: 'available', next: '0.190.0' }), out)).toBe(false)
    expect(recheckOnOpen(on({ phase: 'downloading', next: '0.190.0', downloaded: 1, total: 2 }), out)).toBe(false)
    expect(recheckOnOpen(on({ phase: 'up_to_date', version: '0.190.0' }), out)).toBe(false)
    expect(recheck).toHaveBeenCalledTimes(1)
  })
})
