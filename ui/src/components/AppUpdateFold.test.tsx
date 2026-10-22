/** The update card folds into the status strip, for one version (owner 2026-10-22, after Orca). */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateStatus } from '@/lib/api'
import { APP_UPDATE_EVENT, resetAppUpdate, type AppUpdateInfo } from '@/lib/appupdate'
import { FOLD_KEY, resetUpdateCard } from '@/lib/updatecard'

const h = vi.hoisted(() => ({ st: undefined as unknown }))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      update: async () => h.st,
      checkUpdateSoon: async () => h.st,
      settings: async () => ({ update_checks: true, app_update: 'ask', plan_kind: '', plan_label: '', plan_usd_per_month: 0 }),
      saveSettings: async () => ({}),
    },
  }
})

import { AppUpdateToast, FOLD_LABEL } from './AppUpdateToast'
import { AppUpdateNotice } from './AppUpdateNotice'

const base: UpdateStatus = { enabled: true, current: 'v0.147.0', latest: 'v0.149.0', update_available: true, url: 'https://github.com/dspv/caprock/releases/latest' }

/** The card and the strip's line, as the app shell has them. */
function Both() {
  return (
    <>
      <AppUpdateToast />
      <footer data-testid="strip"><AppUpdateNotice /></footer>
    </>
  )
}

const card = () => document.querySelector('[data-update-toast]')
const folded = () => document.querySelector<HTMLElement>('[data-update-folded]')

describe('the update card folds into the strip', () => {
  let app: AppUpdateInfo
  let invoke: ReturnType<typeof vi.fn>
  const emit = (over: Record<string, unknown>) => {
    app = { ...app, ...over } as AppUpdateInfo
    act(() => { window.dispatchEvent(new CustomEvent(APP_UPDATE_EVENT, { detail: app })) })
  }
  const downloading = async (pct: number, next = '0.149.0') => {
    render(<Both />)
    await screen.findByText(next)
    emit({ phase: 'downloading', next, downloaded: pct * 10, total: 1000 })
  }

  beforeEach(() => {
    localStorage.clear()
    resetAppUpdate()
    resetUpdateCard()
    h.st = base
    app = { version: '0.147.0', supported: true, asked: true, phase: 'idle' }
    invoke = vi.fn(async (cmd: string) => {
      if (cmd === 'app_update_status') return app
      if (cmd === 'app_update_install') return new Promise(() => { /* restarts */ })
      throw new Error(cmd)
    })
    ;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke }
  })
  afterEach(() => { delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ })

  it('folds from its chevron: the card goes and the strip shows the compact item, whose progress follows', async () => {
    await downloading(22)
    expect(card()).toHaveTextContent('Downloading · 22% — keep working.')
    const chevron = screen.getByRole('button', { name: FOLD_LABEL })
    expect(chevron).toHaveAttribute('title', FOLD_LABEL)
    fireEvent.click(chevron)
    expect(card()).toBeNull()
    expect(folded()).toHaveTextContent('↓ 0.149.0 · 22%')
    expect(folded()?.querySelector<HTMLElement>('[data-update-folded-bar]')?.style.width).toBe('22%')
    // The strip's long line gives way to the compact item, never both.
    expect(screen.queryByText(/Downloading v0\.149\.0/)).toBeNull()
    expect(localStorage.getItem(FOLD_KEY)).toBe('v0.149.0')
    emit({ downloaded: 640 })
    expect(folded()).toHaveTextContent('↓ 0.149.0 · 64%')
    expect(folded()?.querySelector<HTMLElement>('[data-update-folded-bar]')?.style.width).toBe('64%')
    expect(card()).toBeNull()
  })

  it('folds on Esc while focus is in the card', async () => {
    await downloading(10)
    const chevron = screen.getByRole('button', { name: FOLD_LABEL })
    chevron.focus()
    fireEvent.keyDown(chevron, { key: 'Escape' })
    expect(card()).toBeNull()
    expect(folded()).toHaveTextContent('↓ 0.149.0 · 10%')
  })

  it('says ready in the strip without unfolding the card, and a click unfolds it', async () => {
    await downloading(50)
    fireEvent.click(screen.getByRole('button', { name: FOLD_LABEL }))
    emit({ phase: 'ready', next: '0.149.0' })
    expect(folded()).toHaveTextContent('0.149.0 ready · Restart')
    expect(card()).toBeNull()
    // Never an install from the strip's item: it only brings the card back.
    fireEvent.click(folded()!)
    expect(invoke).not.toHaveBeenCalledWith('app_update_install', {})
    expect(card()).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Update and restart' })).toBeTruthy()
    expect(folded()).toBeNull()
    expect(localStorage.getItem(FOLD_KEY)).toBeNull()
  })

  it('a click on the item unfolds the card mid-download', async () => {
    await downloading(30)
    fireEvent.click(screen.getByRole('button', { name: FOLD_LABEL }))
    fireEvent.click(folded()!)
    expect(card()).toHaveTextContent('Downloading · 30%')
    // Unfolded, the strip says it its usual way again.
    expect(screen.getByText(/Downloading v0\.149\.0/)).toBeTruthy()
  })

  it('shows a failure in the warn colour, and a click opens the card on the error', async () => {
    await downloading(40)
    fireEvent.click(screen.getByRole('button', { name: FOLD_LABEL }))
    emit({ phase: 'failed', error: 'The signature did not match.' })
    expect(folded()).toHaveTextContent('0.149.0 failed')
    expect(folded()).toHaveClass('text-warn')
    // The strip's own failure panel does not pop open over it.
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(card()).toBeNull()
    fireEvent.click(folded()!)
    expect(card()).toHaveTextContent('The update did not install.')
    expect(card()?.querySelector('[data-update-error]')).toHaveTextContent('The signature did not match.')
    expect(folded()).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(invoke).toHaveBeenCalledWith('app_update_install', {})
  })

  it('remembers the fold for that version only; a newer one starts unfolded', async () => {
    const { unmount } = render(<Both />)
    await screen.findByText('0.149.0')
    fireEvent.click(screen.getByRole('button', { name: FOLD_LABEL }))
    expect(card()).toBeNull()
    expect(folded()).toHaveTextContent('0.149.0 · Update')
    unmount()
    // A reload keeps it folded for 0.149.0.
    resetUpdateCard()
    const again = render(<Both />)
    await act(async () => { await Promise.resolve() })
    expect(card()).toBeNull()
    expect(folded()).not.toBeNull()
    again.unmount()
    // 0.150.0 is a new announcement.
    h.st = { ...base, latest: 'v0.150.0' }
    render(<Both />)
    expect(await screen.findByText('0.150.0')).toBeTruthy()
    expect(card()).not.toBeNull()
    expect(folded()).toBeNull()
  })
})
