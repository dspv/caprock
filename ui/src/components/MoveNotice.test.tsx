import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CopySkipped, MovingLine, copySkippedText, movedPct } from './MoveNotice'
import type { Status } from '@/lib/api'
import { clearShared } from '@/lib/refresh'

const state = vi.hoisted(() => ({ status: {} as Partial<Status>, asked: 0 }))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: { ...actual.api, status: async () => { state.asked++; return state.status as Status } },
  }
})

afterEach(() => {
  vi.useRealTimers()
  clearShared()
  state.status = {}
  state.asked = 0
})

it('says older history is still loading while the move runs', async () => {
  state.status = { events_move: { moved: 250, total: 1000 } }
  render(<MovingLine />)
  await waitFor(() => expect(document.querySelector('[data-moving-line]')).not.toBeNull())
  expect(screen.getByText(/Older history is still loading/)).toBeInTheDocument()
  expect(screen.getByText('25%')).toBeInTheDocument()
})

it('says nothing when no move is running', async () => {
  state.status = {}
  render(<MovingLine />)
  await waitFor(() => expect(state.asked).toBeGreaterThan(0))
  await act(async () => {})
  expect(document.querySelector('[data-moving-line]')).toBeNull()
})

it('goes away once the move ends', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  state.status = { events_move: { moved: 999, total: 1000 } }
  render(<MovingLine />)
  await waitFor(() => expect(screen.getByText('99%')).toBeInTheDocument())
  state.status = {}
  await act(async () => { await vi.advanceTimersByTimeAsync(31_000) })
  await waitFor(() => expect(document.querySelector('[data-moving-line]')).toBeNull())
})

it('rounds down and never passes 100', () => {
  expect(movedPct({ moved: 999, total: 1000 })).toBe(99)
  expect(movedPct({ moved: 5, total: 0 })).toBe(100)
  expect(movedPct({ moved: 0, total: 0 })).toBe(0)
})

it('names the free and needed disk when no copy was made', () => {
  const text = copySkippedText({ before: 73, at: 1, free_bytes: 2 * 1024 ** 3, need_bytes: 5.5 * 1024 ** 3 })
  expect(text).toBe('No safety copy of the database was made before the upgrade: 2.0 GB free, 5.5 GB needed. Older Caprock versions cannot open the upgraded database.')
  render(<CopySkipped skip={{ before: 73, at: 1, free_bytes: 300 * 1024 ** 2, need_bytes: 1024 ** 3 }} />)
  expect(screen.getByText(/300 MB free, 1.0 GB needed/)).toBeInTheDocument()
})

it('says what failed when the copy could not be made for another reason', () => {
  expect(copySkippedText({ before: 73, at: 1, error: 'disk I/O error' })).toMatch(/it could not be made \(disk I\/O error\)\. Older Caprock versions/)
})
