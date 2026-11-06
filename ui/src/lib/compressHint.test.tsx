/**
 * The sidebar footer's hint to turn Compress tool output on: when it shows,
 * what it says, where a click goes, and that *Not now* and the switch hide it.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, type Status } from './api'
import {
  COMPRESS_HINT_TARGET, MIN_SAVING, SNOOZE_KEY, SNOOZE_MS, STORAGE_SECTION, compressHintShown, compressHintText,
  noteCompressChanged, reloadCompressSnooze, type CompressOffer,
} from './compressHint'
import { SidebarFooter } from '@/components/SidebarFooter'

const offer: CompressOffer = { db_bytes: 2_524_000_000, est_saving_bytes: 1_010_000_000, sample_rows: 2000, measured_at: 1 }
const now = 1_790_000_000_000

describe('compressHintShown', () => {
  it('shows a saving worth a line, and nothing else', () => {
    expect(compressHintShown(offer, 0, now)).toBe(true)
    expect(compressHintShown(undefined, 0, now)).toBe(false)
    expect(compressHintShown({ ...offer, est_saving_bytes: MIN_SAVING - 1 }, 0, now)).toBe(false)
    expect(compressHintShown({ ...offer, est_saving_bytes: MIN_SAVING }, 0, now)).toBe(true)
    expect(compressHintShown({ ...offer, sample_rows: 0 }, 0, now)).toBe(false)
    expect(compressHintShown({ ...offer, db_bytes: 0 }, 0, now)).toBe(false)
  })
  it('stays hidden until a snooze runs out', () => {
    expect(compressHintShown(offer, now + 1, now)).toBe(false)
    expect(compressHintShown(offer, now, now)).toBe(true)
  })
  it('says the size and the estimate, as an estimate', () => {
    expect(compressHintText(offer)).toBe('Database 2.5GB · compressing frees about 1.0GB')
  })
})

describe('the footer hint', () => {
  let status: ReturnType<typeof vi.spyOn>
  const answer = (o?: CompressOffer) => status.mockResolvedValue({ compress_offer: o } as Status)
  const footer = (folded = false) =>
    render(<SidebarFooter folded={folded} onToggleFold={() => {}} dashboardActive={false} onDashboard={() => {}} onSettings={() => {}} />)

  beforeEach(() => {
    reloadCompressSnooze()
    status = vi.spyOn(api, 'status')
    location.hash = ''
  })
  afterEach(() => { status.mockRestore() })

  it('is absent with no offer: compression on, nothing measured, or a small install', async () => {
    answer(undefined)
    footer()
    await waitFor(() => expect(status).toHaveBeenCalled())
    expect(document.querySelector('[data-compress-hint]')).toBeNull()
  })

  it('is absent below the threshold', async () => {
    answer({ ...offer, est_saving_bytes: 120_000_000 })
    footer()
    await waitFor(() => expect(status).toHaveBeenCalled())
    expect(document.querySelector('[data-compress-hint]')).toBeNull()
  })

  it('opens Settings on the switch, scrolls to it and lights it, and turns nothing on', async () => {
    answer(offer)
    const save = vi.spyOn(api, 'saveSettings')
    footer()
    const line = await screen.findByText('Database 2.5GB · compressing frees about 1.0GB')
    // The page the hint leads to, with the switch on it.
    const section = document.createElement('section')
    section.id = STORAGE_SECTION
    const sw = document.createElement('div')
    sw.setAttribute('data-compress-tool-output', '')
    const scrolled = vi.fn()
    sw.scrollIntoView = scrolled
    section.appendChild(sw)
    document.body.appendChild(section)
    fireEvent.click(line)
    expect(location.hash).toBe(COMPRESS_HINT_TARGET)
    await waitFor(() => expect(scrolled).toHaveBeenCalledWith({ block: 'center' }))
    expect(sw.hasAttribute('data-compress-lit')).toBe(true)
    expect(save).not.toHaveBeenCalled()
    section.remove()
    save.mockRestore()
  })

  it('Not now hides it for 30 days, remembered', async () => {
    answer(offer)
    footer()
    await screen.findByText(/compressing frees about/)
    const before = Date.now()
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(document.querySelector('[data-compress-hint]')).toBeNull()
    const until = Number(localStorage.getItem(SNOOZE_KEY))
    expect(until).toBeGreaterThanOrEqual(before + SNOOZE_MS)
    expect(until).toBeLessThanOrEqual(Date.now() + SNOOZE_MS)
  })

  it('goes as soon as the switch is turned on', async () => {
    answer(offer)
    footer()
    await screen.findByText(/compressing frees about/)
    answer(undefined)
    act(() => noteCompressChanged(true))
    expect(document.querySelector('[data-compress-hint]')).toBeNull()
  })

  it('folded: one database glyph with a dot, the sentence in its tooltip', async () => {
    answer(offer)
    footer(true)
    const glyph = await waitFor(() => {
      const b = document.querySelector<HTMLButtonElement>('button[data-compress-hint]')
      expect(b).not.toBeNull()
      return b!
    })
    expect(glyph.title).toContain('Database 2.5GB · compressing frees about 1.0GB')
    expect(glyph.title).toContain('an estimate from 2,000 of your tool calls')
    expect(glyph.querySelector('[data-hint-dot]')).not.toBeNull()
    fireEvent.click(glyph)
    expect(location.hash).toBe(COMPRESS_HINT_TARGET)
  })

  it('a paired device never asks', async () => {
    localStorage.setItem('caprock.device.token', 'x')
    answer(offer)
    footer()
    await new Promise((r) => setTimeout(r, 10))
    expect(document.querySelector('[data-compress-hint]')).toBeNull()
  })
})
