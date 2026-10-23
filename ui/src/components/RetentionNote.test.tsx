/** The Lifetime screen's line about Claude Code deleting old transcripts, and its button. */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Retention } from '@/lib/api'

const h = vi.hoisted(() => ({
  retention: undefined as unknown,
  kept: 0,
  keepFails: '' as string,
  paired: false,
}))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    isPairedDevice: () => h.paired,
    api: {
      ...actual.api,
      retention: async () => h.retention,
      keepTranscripts: async () => {
        if (h.keepFails) throw new actual.ApiError(409, h.keepFails)
        h.kept++
        return { days: 36500, set: true, offer: false, keep_days: 36500 }
      },
    },
  }
})

import { KEPT_SHOWN_MS, RetentionNote, retentionLine, shortDay } from './RetentionNote'

const unset: Retention = { days: 30, set: false, offer: true, keep_days: 36500 }
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0) })

describe('RetentionNote', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    h.retention = unset
    h.kept = 0
    h.keepFails = ''
    h.paired = false
  })
  afterEach(() => { vi.useRealTimers() })

  it('says why the history starts where it does, and keeps them on a click', async () => {
    render(<RetentionNote earliest="2026-09-20" />)
    await settle()
    expect(screen.getByText(/deletes conversations older than 30 days, so the history before 20 Sept? was gone before Caprock saw it/)).toBeTruthy()
    fireEvent.click(screen.getByText('Keep them from now on'))
    await settle()
    expect(h.kept).toBe(1)
    expect(screen.getByText('Kept from now on.')).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(KEPT_SHOWN_MS) })
    expect(document.querySelector('[data-retention]')).toBeNull()
  })

  it('says nothing for a period the user chose over 90 days', async () => {
    h.retention = { days: 365, set: true, offer: false, keep_days: 36500 }
    render(<RetentionNote earliest="2026-09-20" />)
    await settle()
    expect(document.querySelector('[data-retention]')).toBeNull()
  })

  it('a settings file that is not valid JSON is refused, and the line says nothing was changed', async () => {
    h.keepFails = 'parse settings.json: invalid character (fix or move the file; Caprock will not overwrite an unparsable settings.json)'
    render(<RetentionNote earliest="2026-09-20" />)
    await settle()
    fireEvent.click(screen.getByText('Keep them from now on'))
    await settle()
    expect(screen.getByRole('alert').textContent).toMatch(/Nothing was changed: .*will not overwrite/)
    expect(screen.getByText('Keep them from now on')).toBeTruthy()
  })

  it('is the machine\'s own: a paired device gets no line', async () => {
    h.paired = true
    render(<RetentionNote earliest="2026-09-20" />)
    await settle()
    expect(document.querySelector('[data-retention]')).toBeNull()
  })
})

describe('retention words', () => {
  const now = new Date(2026, 9, 24)
  it('names the period and the first day', () => {
    expect(retentionLine(30, '2026-09-20', now)).toMatch(/^Claude Code deletes conversations older than 30 days, so the history before 20 Sept? was gone before Caprock saw it\.$/)
    expect(retentionLine(1, undefined, now)).toBe('Claude Code deletes conversations older than 1 day, so older history was gone before Caprock saw it.')
    expect(shortDay('2025-12-01', now)).toMatch(/2025/)
    expect(shortDay('nope', now)).toBeUndefined()
  })
})
