import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { everyWhileVisible } from './visible'

let state: DocumentVisibilityState = 'visible'
const setVisibility = (v: DocumentVisibilityState) => {
  state = v
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('everyWhileVisible', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    state = 'visible'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => state)
  })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('ticks while visible, rests while hidden, and catches up once on showing', () => {
    const fn = vi.fn()
    const stop = everyWhileVisible(fn, 1000)
    vi.advanceTimersByTime(2000)
    expect(fn).toHaveBeenCalledTimes(2)
    setVisibility('hidden')
    vi.advanceTimersByTime(10_000)
    expect(fn).toHaveBeenCalledTimes(2)
    setVisibility('visible')
    expect(fn).toHaveBeenCalledTimes(3)
    stop()
    vi.advanceTimersByTime(5000)
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('keeps a slower pace while hidden when asked to', () => {
    const fn = vi.fn()
    const stop = everyWhileVisible(fn, 5_000, 30_000)
    setVisibility('hidden')
    vi.advanceTimersByTime(25_000)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(5_000)
    expect(fn).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(30_000)
    expect(fn).toHaveBeenCalledTimes(2)
    stop()
  })

  it('does not run on showing when no tick was missed', () => {
    const fn = vi.fn()
    const stop = everyWhileVisible(fn, 1000)
    setVisibility('hidden')
    setVisibility('visible')
    expect(fn).not.toHaveBeenCalled()
    stop()
  })
})
