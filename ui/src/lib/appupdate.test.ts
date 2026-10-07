import { describe, expect, it } from 'vitest'
import { newerVersion, offerFor, type AppUpdateInfo } from './appupdate'
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
