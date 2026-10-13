import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { blinkWhileVisible, coalesce, everyWhileVisible, markPageVisibility } from './visible'

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

describe('a hidden page wakes for nothing', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    state = 'visible'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => state)
  })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('keeps no timer at all while hidden, and one again when shown', () => {
    const stop = everyWhileVisible(() => {}, 1000)
    expect(vi.getTimerCount()).toBe(1)
    setVisibility('hidden')
    expect(vi.getTimerCount()).toBe(0)
    setVisibility('visible')
    expect(vi.getTimerCount()).toBe(1)
    stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('marks the document while hidden, which pauses every animation', () => {
    const stop = markPageVisibility()
    expect(document.documentElement.hasAttribute('data-page-hidden')).toBe(false)
    setVisibility('hidden')
    expect(document.documentElement.hasAttribute('data-page-hidden')).toBe(true)
    setVisibility('visible')
    expect(document.documentElement.hasAttribute('data-page-hidden')).toBe(false)
    stop()
  })

  it('blinks a terminal cursor only while shown, and only when asked to', () => {
    const term = { options: { cursorBlink: true as boolean | undefined } }
    const stop = blinkWhileVisible(term, true)
    setVisibility('hidden')
    expect(term.options.cursorBlink).toBe(false)
    setVisibility('visible')
    expect(term.options.cursorBlink).toBe(true)
    stop()
    const still = { options: { cursorBlink: false as boolean | undefined } }
    const stop2 = blinkWhileVisible(still, false)
    setVisibility('hidden')
    setVisibility('visible')
    expect(still.options.cursorBlink).toBe(false)
    stop2()
  })
})

describe('coalesce', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    state = 'visible'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => state)
  })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('runs once per window however often it is asked', () => {
    const fn = vi.fn()
    const c = coalesce(fn, 250)
    for (let i = 0; i < 20; i++) c.ask()
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(250)
    expect(fn).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    expect(fn).toHaveBeenCalledTimes(1)
    c.ask()
    c.flush()
    expect(fn).toHaveBeenCalledTimes(2)
    c.ask()
    c.cancel()
    vi.advanceTimersByTime(1000)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('waits while the page is hidden and runs at once when it is shown', () => {
    const fn = vi.fn()
    const c = coalesce(fn, 250)
    setVisibility('hidden')
    c.ask()
    vi.advanceTimersByTime(60_000)
    c.ask()
    expect(fn).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    setVisibility('visible')
    expect(fn).toHaveBeenCalledTimes(1)
    c.cancel()
  })
})
