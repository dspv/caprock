/**
 * The sidebar's database indicator: which state it shows, what each says,
 * and the pack it offers — asked first, then posted, then a real bar.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'
import {
  FAILED_SHOW_MS, PACKED_SHOW_MS, PACK_SNOOZE_KEY, dbWork, dbWorkText, dbWorkTitle, fmtSeconds, pct, pollMs, reloadPackSnooze,
  type PackOffer, type PackReport,
} from './dbWork'
import { DbWorkIndicator } from '@/components/DbWork'

const now = 1_790_000_000_000
const offer: PackOffer = {
  used_bytes: 2_098_000_000, free_bytes_est: 415_000_000, sampled_pages: 4000,
  est_seconds: 84, hold_seconds_est: 66, worth: true,
}
const base = (over: Partial<PackReport['pack']> = {}, z: Partial<PackReport['compression']> = {}): PackReport => ({
  compression: { on: true, cursor_id: 900, target_id: 900, progress: 1, pending: false, saved_bytes: 878_000_000, ...z },
  pack: { db_bytes: 2_098_000_000, ...over },
})

describe('dbWork', () => {
  it('shows compression while a pass is under way, with its share and what it saved', () => {
    const w = dbWork(base({}, { cursor_id: 400, target_id: 1000, progress: 0.4, pending: true, saved_bytes: 310_000_000 }), now, 0)
    expect(w?.kind).toBe('compressing')
    expect(dbWorkText(w!)).toBe('Compressing old tool output · 40% · 310.0MB saved')
    expect(dbWorkTitle(w!)).toMatch(/at most a tenth of one core/)
  })
  it('shows restoring with the switch off', () => {
    const w = dbWork(base({}, { on: false, restoring: true, progress: 0.25 }), now, 0)
    expect(dbWorkText(w!)).toBe('Restoring compressed tool output · 25%')
  })
  it('offers a pack only when it is worth it, compression is done, and not snoozed', () => {
    expect(dbWork(base({ offer }), now, 0)?.kind).toBe('offer')
    expect(dbWork(base({ offer: { ...offer, worth: false } }), now, 0)).toBeUndefined()
    expect(dbWork(base({ offer }), now, now + 1)).toBeUndefined()
    // Mid-pass, compression's own line comes first.
    expect(dbWork(base({ offer }, { pending: true, progress: 0.5 }), now, 0)?.kind).toBe('compressing')
    const w = dbWork(base({ offer }), now, 0)!
    expect(dbWorkText(w)).toBe('Pack the database · about 85 s · frees ~415.0MB')
    expect(dbWorkTitle(w)).toMatch(/an estimate from 4,000 of its pages/)
    expect(dbWorkTitle(w)).toMatch(/new events wait about 65 s/)
  })
  it('shows a running pack over everything, with its phase and a measured share or none', () => {
    const run = { phase: 'copying' as const, progress: 0.21, started_ms: now - 5000, elapsed_ms: 5000, est_seconds: 84, events_wait: true }
    const w = dbWork(base({ running: run, offer }, { pending: true }), now, 0)!
    expect(w.kind).toBe('packing')
    expect(dbWorkText(w)).toBe('Packing the database · copying · 21%')
    expect(dbWorkText(dbWork(base({ running: { ...run, progress: -1 } }), now, 0)!)).toBe('Packing the database · copying')
  })
  it('says a finished pack for a minute, and one that stopped for longer', () => {
    const last = { at_ms: now - 1000, ok: true, before_bytes: 2_098_000_000, after_bytes: 1_634_000_000, took_ms: 56_000 }
    expect(dbWorkText(dbWork(base({ last }), now, 0)!)).toBe('Packed · 2.1GB → 1.6GB')
    expect(dbWork(base({ last: { ...last, at_ms: now - PACKED_SHOW_MS } }), now, 0)).toBeUndefined()
    const failed = { ...last, ok: false, why: 'it ran past 10 minutes' }
    expect(dbWorkText(dbWork(base({ last: failed }), now, 0)!)).toBe('Packing stopped: it ran past 10 minutes')
    expect(dbWork(base({ last: { ...failed, at_ms: now - FAILED_SHOW_MS } }), now, 0)).toBeUndefined()
  })
  it('is quiet with nothing to say', () => {
    expect(dbWork(base(), now, 0)).toBeUndefined()
    expect(dbWork(undefined, now, 0)).toBeUndefined()
  })
  it('reads more often while something moves', () => {
    expect(pollMs({ kind: 'packing', run: { phase: 'writing', progress: 0.5, started_ms: 0, elapsed_ms: 0, est_seconds: 1, events_wait: true } })).toBe(2000)
    expect(pollMs({ kind: 'compressing', progress: 0, saved: 0 })).toBe(5000)
    expect(pollMs(undefined)).toBe(300_000)
  })
  it('rounds shares down and durations to words', () => {
    expect(pct(0.996)).toBe('99%')
    expect(fmtSeconds(42)).toBe('40 s')
    expect(fmtSeconds(2)).toBe('5 s')
    expect(fmtSeconds(130)).toBe('2 min')
  })
})

describe('the status strip indicator', () => {
  let read: ReturnType<typeof vi.spyOn>
  let post: ReturnType<typeof vi.spyOn>
  const strip = () => render(<DbWorkIndicator />)

  beforeEach(() => {
    try { localStorage.removeItem(PACK_SNOOZE_KEY) } catch { /* none */ }
    reloadPackSnooze()
    read = vi.spyOn(api, 'storagePack')
    post = vi.spyOn(api, 'startPack')
  })
  afterEach(() => { read.mockRestore(); post.mockRestore() })

  it('is absent with nothing to say', async () => {
    read.mockResolvedValue(base())
    strip()
    await waitFor(() => expect(read).toHaveBeenCalled())
    expect(document.querySelector('[data-db-work]')).toBeNull()
  })

  it('shows compression as a short item with a bar filled to its share', async () => {
    read.mockResolvedValue(base({}, { cursor_id: 400, target_id: 1000, progress: 0.4, pending: true, saved_bytes: 310_000_000 }))
    strip()
    await waitFor(() => expect(document.querySelector('[data-db-work="compressing"]')).not.toBeNull())
    expect(document.querySelector('[data-db-work]')?.textContent).toBe('Compressing · 40% · 310.0MB saved')
    expect(document.querySelector('[data-work-bar]')?.getAttribute('data-work-bar')).toBe('0.4')
  })

  it('offers a pack with its time; the popover says what waits, and Pack now posts it', async () => {
    read.mockResolvedValue(base({ offer }))
    post.mockResolvedValue(base({ running: { phase: 'waiting', progress: 0, started_ms: now, elapsed_ms: 0, est_seconds: 84, events_wait: true } }))
    strip()
    const item = await screen.findByText('Pack database · ~85 s')
    expect(post).not.toHaveBeenCalled()
    fireEvent.click(item)
    const pop = document.querySelector('[data-db-work-popover]')
    expect(pop?.textContent).toMatch(/frees ~415.0MB/)
    expect(pop?.textContent).toMatch(/new events wait about 65 s/)
    expect(pop?.textContent).toMatch(/4,000 of the file's pages/)
    fireEvent.click(document.querySelector('[data-pack-now]')!)
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(document.querySelector('[data-db-work="packing"]')).not.toBeNull())
  })

  it('during a pack carries a measured bar, or a moving stripe where a phase has no reading', async () => {
    read.mockResolvedValue(base({ running: { phase: 'writing', progress: 0.46, started_ms: now, elapsed_ms: 1, est_seconds: 84, events_wait: true } }))
    const { unmount } = strip()
    await waitFor(() => expect(document.querySelector('[data-db-work="packing"]')?.textContent).toBe('Packing · 46%'))
    expect(document.querySelector('[data-work-bar]')?.getAttribute('data-work-bar')).toBe('0.46')
    unmount()
    read.mockResolvedValue(base({ running: { phase: 'copying', progress: -1, started_ms: now, elapsed_ms: 1, est_seconds: 84, events_wait: true } }))
    strip()
    await waitFor(() => expect(document.querySelector('[data-work-bar="indeterminate"]')).not.toBeNull())
    expect(document.querySelector('[data-db-work]')?.textContent).toBe('Packing · copying')
  })

  it('Not now hides the offer', async () => {
    read.mockResolvedValue(base({ offer }))
    strip()
    fireEvent.click(await screen.findByText(/Pack database/))
    fireEvent.click(document.querySelector('[data-pack-snooze]')!)
    await waitFor(() => expect(document.querySelector('[data-db-work]')).toBeNull())
  })

  it('says a finished pack, quietly', async () => {
    read.mockResolvedValue(base({ last: { at_ms: Date.now() - 1000, ok: true, before_bytes: 2_098_000_000, after_bytes: 1_634_000_000, took_ms: 96_000, hold_ms: 57_000 } }))
    strip()
    await waitFor(() => expect(document.querySelector('[data-db-work="packed"]')?.textContent).toBe('Packed · 2.1GB → 1.6GB'))
  })
})
