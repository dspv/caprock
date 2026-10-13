import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FRAME_BATCH_MS, frameBatch } from './framebatch'

describe('frameBatch', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('applies everything pushed in a window at once, in order', () => {
    const got: number[][] = []
    const b = frameBatch<number>((items) => got.push(items))
    for (let i = 0; i < 5; i++) b.push(i)
    expect(got).toEqual([])
    vi.advanceTimersByTime(FRAME_BATCH_MS)
    expect(got).toEqual([[0, 1, 2, 3, 4]])
    b.push(5)
    vi.advanceTimersByTime(FRAME_BATCH_MS)
    expect(got).toEqual([[0, 1, 2, 3, 4], [5]])
  })

  it('drops what is queued on cancel', () => {
    const apply = vi.fn()
    const b = frameBatch<number>(apply)
    b.push(1)
    b.cancel()
    vi.advanceTimersByTime(FRAME_BATCH_MS * 4)
    expect(apply).not.toHaveBeenCalled()
    b.push(2)
    vi.advanceTimersByTime(FRAME_BATCH_MS)
    expect(apply).toHaveBeenCalledWith([2])
  })
})
