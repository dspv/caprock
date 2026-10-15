/** The answer to a check by hand: up to date with Close, or the error with Retry; silent in the background. */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateStatus } from '@/lib/api'
import { APP_UPDATE_EVENT, appUpdate, resetAppUpdate, type AppUpdateInfo } from '@/lib/appupdate'
import { answerFor, checkByHand, resetCheckBanner } from '@/lib/checkbanner'

const h = vi.hoisted(() => ({ check: undefined as unknown as () => Promise<unknown> }))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, checkUpdate: () => h.check() } }
})

import { UP_TO_DATE_BANNER_MS, UpdateCheckBanner } from './UpdateCheckBanner'

const current: UpdateStatus = { enabled: true, current: 'v0.79.0', latest: 'v0.79.0', update_available: false }
const flush = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }

describe('answerFor', () => {
  const app = (over: Partial<AppUpdateInfo>) => ({ version: '0.79.0', supported: true, asked: true, phase: 'idle', ...over }) as AppUpdateInfo
  it('up to date, failed, or nothing to say when a newer version is out', () => {
    expect(answerFor(current, undefined)).toMatchObject({ kind: 'up_to_date', version: 'v0.79.0' })
    expect(answerFor({ ...current, error: 'HTTP 502' }, undefined)).toMatchObject({ kind: 'failed', error: 'HTTP 502' })
    expect(answerFor(new Error('offline'), undefined)).toMatchObject({ kind: 'failed', error: 'offline' })
    expect(answerFor({ ...current, latest: 'v0.80.0', update_available: true }, undefined)).toBeNull()
  })
  it('in an app that replaces itself, the app’s own answer decides', () => {
    expect(answerFor(new Error('403'), app({ phase: 'up_to_date' }))).toMatchObject({ kind: 'up_to_date', version: 'v0.79.0' })
    expect(answerFor(current, app({ phase: 'failed', error: 'Could not reach GitHub' }))).toMatchObject({ kind: 'failed' })
    expect(answerFor(current, app({ phase: 'available', next: '0.80.0' }))).toBeNull()
  })
})

describe('the banner', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    resetCheckBanner()
    resetAppUpdate()
    h.check = async () => current
  })
  afterEach(() => {
    vi.useRealTimers()
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })

  it('says up to date after Check now, with Close, and goes after 8 s unless hovered', async () => {
    render(<UpdateCheckBanner />)
    await act(async () => { await checkByHand() })
    const b = screen.getByRole('status', { name: 'You’re up to date' })
    expect(b).toHaveTextContent('Caprock 0.79.0 is the latest · checked just now')
    fireEvent.mouseEnter(b)
    await flush(UP_TO_DATE_BANNER_MS * 2)
    expect(screen.queryByRole('status', { name: 'You’re up to date' })).toBeTruthy()
    fireEvent.mouseLeave(b)
    await flush(UP_TO_DATE_BANNER_MS)
    expect(screen.queryByRole('status', { name: 'You’re up to date' })).toBeNull()

    await act(async () => { await checkByHand() })
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('status', { name: 'You’re up to date' })).toBeNull()
  })

  it('a failed check stays, with the error and Retry', async () => {
    h.check = async () => { throw new Error('could not reach GitHub') }
    render(<UpdateCheckBanner />)
    await act(async () => { await checkByHand() })
    const b = screen.getByRole('alert', { name: 'Could not check for updates' })
    expect(b).toHaveTextContent('could not reach GitHub')
    await flush(UP_TO_DATE_BANNER_MS * 2)
    expect(screen.getByRole('alert')).toBeTruthy()
    h.check = async () => current
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })) })
    await flush()
    expect(screen.getByRole('status', { name: 'You’re up to date' })).toBeTruthy()
  })

  it('says nothing when a newer version is out: the offer announces that', async () => {
    h.check = async () => ({ ...current, latest: 'v0.80.0', update_available: true })
    render(<UpdateCheckBanner />)
    await act(async () => { await checkByHand() })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('answers a check from the app menu, and never a background download', async () => {
    let info: AppUpdateInfo = { version: '0.79.0', supported: true, asked: true, phase: 'idle' }
    const emit = (over: Partial<AppUpdateInfo>) => {
      info = { ...info, ...over } as AppUpdateInfo
      act(() => { window.dispatchEvent(new CustomEvent(APP_UPDATE_EVENT, { detail: info })) })
    }
    let finishDownload = () => {}
    ;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === 'app_update_download') return new Promise((r) => { finishDownload = () => r(info) })
        return info
      },
    }
    render(<UpdateCheckBanner />)
    await flush()
    // Update automatically's download: checking, then nothing newer. Silent.
    const dl = appUpdate.download()
    await flush()
    emit({ phase: 'checking' })
    emit({ phase: 'up_to_date' })
    finishDownload()
    await act(async () => { await dl })
    expect(screen.queryByRole('status', { name: 'You’re up to date' })).toBeNull()
    // Check for Updates… in the menu: the shell's phase answers.
    emit({ phase: 'checking' })
    emit({ phase: 'up_to_date' })
    expect(screen.getByRole('status', { name: 'You’re up to date' })).toHaveTextContent('Caprock 0.79.0')
  })
})
