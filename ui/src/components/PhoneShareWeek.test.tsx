/**
 * Share your week from the phone: the row opens a sheet with the Week card,
 * drawn before the tap, and Share… hands the PNG alone to the share menu.
 * Nothing is uploaded: caprock.dev is never asked.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, type Week } from '@/lib/api'
import { resetShareCache } from '@/lib/sharecache'

vi.mock('@/lib/cardimage', () => ({ renderCardPNG: vi.fn(async () => new Blob(['png'], { type: 'image/png' })) }))

import { PhoneShareWeek } from './PhoneShareWeek'

const week = {
  period: '7d', start: '2026-10-19', end: '2026-10-25', partial: true, from_ms: 0, to_ms: 0,
  days: Array.from({ length: 7 }, (_, i) => ({ day: `2026-10-${19 + i}`, prs_opened: i, cost_usd: 200, active: true })),
  sessions: 556, scheduled_sessions: 0, active_days: 7, turns: 9000, cost_usd: 1540, models: [],
  prs_opened: 54, prs_merged: 48, prs_source: 'github', merges_unresolved: 0,
  commits: 120, files_edited: 300, lines_added: 9000, lines_removed: 100, ci_wait_ms: 0, tool_ms: 0,
  cost_per_merged_pr: 21.5,
  agents: [{ agent: 'claude', subagent: false, turns: 9000, cost_usd: 1540, sessions: 556 }],
  estimates: [],
} as unknown as Week

const nav = navigator as unknown as Record<string, unknown>
const orig = { share: nav.share, canShare: nav.canShare }
let upload: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.restoreAllMocks()
  resetShareCache()
  localStorage.clear()
  URL.createObjectURL = vi.fn(() => 'blob:card')
  URL.revokeObjectURL = vi.fn()
  vi.spyOn(api, 'weekFor').mockResolvedValue(week)
  vi.spyOn(api, 'settings').mockResolvedValue({} as Awaited<ReturnType<typeof api.settings>>)
  upload = vi.fn()
  ;(api as unknown as Record<string, unknown>).shareCard = upload
})
afterEach(() => { nav.share = orig.share; nav.canShare = orig.canShare })

describe('PhoneShareWeek', () => {
  it('opens the Week card and hands the share menu the PNG alone, uploading nothing', async () => {
    const shared: unknown[] = []
    nav.canShare = () => true
    nav.share = async (p: unknown) => { shared.push(p) }
    render(<PhoneShareWeek />)
    fireEvent.click(screen.getByRole('button', { name: /Share your week/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Share your week' })
    expect(dialog.textContent).toMatch(/nothing uploaded/)
    const btn = await screen.findByRole('button', { name: 'Share…' })
    await waitFor(() => expect(btn).not.toBeDisabled())
    fireEvent.click(btn)
    await waitFor(() => expect(shared.length).toBe(1))
    const p = shared[0] as { files?: File[]; text?: string; url?: string }
    expect(p.files?.length).toBe(1)
    expect(p.files![0]!.type).toBe('image/png')
    expect(p.files![0]!.name).toMatch(/^caprock-7d-1080x1350-/)
    expect(p.text).toBeUndefined()
    expect(p.url).toBeUndefined()
    expect(upload).not.toHaveBeenCalled()
    // Shared: the sheet closes.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('saves the picture where the browser cannot share a file', async () => {
    nav.canShare = undefined
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    render(<PhoneShareWeek />)
    fireEvent.click(screen.getByRole('button', { name: /Share your week/ }))
    const save = await screen.findByRole('button', { name: 'Save image' })
    fireEvent.click(save)
    expect(click).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('Saved to your downloads.')).toBeTruthy()
    expect(upload).not.toHaveBeenCalled()
  })

  it('says there is no card for an empty week', async () => {
    vi.spyOn(api, 'weekFor').mockResolvedValue({ ...week, sessions: 0 } as Week)
    nav.canShare = () => true
    nav.share = async () => {}
    render(<PhoneShareWeek />)
    fireEvent.click(screen.getByRole('button', { name: /Share your week/ }))
    expect(await screen.findByText(/no card yet/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Share…' })).toBeDisabled()
  })
})
