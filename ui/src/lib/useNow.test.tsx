import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SLOW_NOW_MS, useNow, useNowFor } from './useNow'

let vis: DocumentVisibilityState = 'visible'
/** Advances time `ms` at a time, one act each, so each tick is its own render. */
const step = (ms: number, times: number) => { for (let i = 0; i < times; i++) act(() => { vi.advanceTimersByTime(ms) }) }
const setVis = (v: DocumentVisibilityState) => { vis = v; document.dispatchEvent(new Event('visibilitychange')) }

describe('the clocks a hidden window does not run', () => {
  beforeEach(() => {
    vis = 'visible'
    vi.useFakeTimers()
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => vis)
  })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('stops while hidden and reads the time at once on showing', () => {
    let renders = 0
    const Probe = () => { renders++; return <span data-testid="n">{useNow(1000)}</span> }
    const { getByTestId, unmount } = render(<Probe />)
    act(() => { setVis('hidden') })
    const before = renders
    act(() => { vi.advanceTimersByTime(30_000) })
    expect(renders).toBe(before)
    expect(vi.getTimerCount()).toBe(0)
    act(() => { setVis('visible') })
    expect(Number(getByTestId('n').textContent)).toBe(Date.now())
    unmount()
  })

  it('ticks every second while something is fresh, and slowly once nothing is', () => {
    let renders = 0
    const Probe = ({ latest }: { latest: number }) => { renders++; return <span>{useNowFor(latest)}</span> }
    const { rerender, unmount } = render(<Probe latest={Date.now()} />)
    let before = renders
    step(1000, 5)
    expect(renders - before).toBe(5)
    // Nothing new for two minutes: the clock slows to SLOW_NOW_MS.
    act(() => { vi.advanceTimersByTime(120_000) })
    before = renders
    step(1000, (SLOW_NOW_MS * 2) / 1000)
    expect(renders - before).toBe(2)
    // A new event: per second again, from now.
    rerender(<Probe latest={Date.now()} />)
    before = renders
    step(1000, 3)
    expect(renders - before).toBe(3)
    unmount()
  })
})
