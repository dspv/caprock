import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FOCUS_MIN_MS, usePoll } from './usePoll'
import { forgetDeckAnswers, isReading, KEPT_FAINT_MS, writeDeck } from './deckCache'

const setHidden = (hidden: boolean) => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') })
}

afterEach(() => { forgetDeckAnswers(); localStorage.clear(); setHidden(false); vi.useRealTimers() })

// Owner, 2026-11-20, translated: "I open it, see red, click around and it
// fixes itself — CI statuses must load faster".
describe('usePoll', () => {
  it('asks at once on mount, and again at once when the window comes to the front', async () => {
    const read = vi.fn(async () => ({ n: 1 }))
    renderHook(() => usePoll(true, 'k', read, () => false))
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    // A focus right after a read asks nothing: a quick switch back and forth is one read.
    act(() => { window.dispatchEvent(new Event('focus')) })
    expect(read).toHaveBeenCalledTimes(1)
    // Later, the window brought to the front asks at once, not at the next interval.
    const t0 = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(t0 + FOCUS_MIN_MS + 1)
    act(() => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    vi.restoreAllMocks()
  })

  it('asks nothing while the window is hidden, focus or not, and at once when it is shown', async () => {
    setHidden(true)
    const read = vi.fn(async () => ({ n: 1 }))
    renderHook(() => usePoll(true, 'k', read, () => false))
    act(() => { window.dispatchEvent(new Event('focus')) })
    await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
    expect(read).not.toHaveBeenCalled()
    setHidden(false)
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1))
  })

  it('asks nothing while off, focus or not', async () => {
    const read = vi.fn(async () => ({ n: 1 }))
    renderHook(() => usePoll(false, 'k', read, () => false))
    act(() => { window.dispatchEvent(new Event('focus')) })
    await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
    expect(read).not.toHaveBeenCalled()
  })

  it('marks an old kept copy as being read until a settled answer lands', async () => {
    writeDeck('stats:/w', { n: 0 }, Date.now() - 25 * 60_000)
    let answer: (v: { n: number; refreshing?: boolean }) => void = () => {}
    const read = vi.fn(() => new Promise<{ n: number; refreshing?: boolean }>((r) => { answer = r }))
    const { unmount } = renderHook(() => usePoll(true, 'k', read, () => false, 12_000, 'stats:/w'))
    // Before the first paint: never drawn at full strength first.
    expect(isReading('stats:/w')).toBe(true)
    // An answer the daemon kept while it composes a newer one is not settled.
    await act(async () => { answer({ n: 1, refreshing: true }) })
    expect(isReading('stats:/w')).toBe(true)
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2), { timeout: 3_000 })
    await act(async () => { answer({ n: 2 }) })
    expect(isReading('stats:/w')).toBe(false)
    unmount()
  })

  it('does not mark a copy younger than KEPT_FAINT_MS, and unmarks on the way out', () => {
    writeDeck('young', { n: 0 }, Date.now() - KEPT_FAINT_MS / 2)
    writeDeck('old', { n: 0 }, Date.now() - KEPT_FAINT_MS * 2)
    const never = () => new Promise<{ n: number }>(() => {})
    renderHook(() => usePoll(true, 'a', never, () => false, 12_000, 'young'))
    const { unmount } = renderHook(() => usePoll(true, 'b', never, () => false, 12_000, 'old'))
    expect(isReading('young')).toBe(false)
    expect(isReading('old')).toBe(true)
    unmount()
    expect(isReading('old')).toBe(false)
  })
})
