import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'
import { TABS_HEARTBEAT_MS, useReportTabs, VIEWER_KEY, viewerId } from './reportTabs'

beforeEach(() => { localStorage.clear(); vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('useReportTabs', () => {
  it('says the whole list at once, again when it changes, and every few minutes', () => {
    const put = vi.spyOn(api, 'putTabs').mockResolvedValue(undefined)
    const { rerender } = renderHook(({ ids }) => useReportTabs(ids), { initialProps: { ids: ['b', 'a', 'a'] } })
    expect(put).toHaveBeenCalledTimes(1)
    const viewer = put.mock.calls[0]![0]
    // In tab-strip order, each once: the phone home lists them so.
    expect(put.mock.calls[0]![1]).toEqual(['b', 'a'])
    // The same list again is no change.
    rerender({ ids: ['b', 'a'] })
    expect(put).toHaveBeenCalledTimes(1)
    // A drag is: the new order is said at once.
    rerender({ ids: ['a', 'b'] })
    expect(put).toHaveBeenLastCalledWith(viewer, ['a', 'b'])
    rerender({ ids: ['a'] })
    expect(put).toHaveBeenLastCalledWith(viewer, ['a'])
    vi.advanceTimersByTime(TABS_HEARTBEAT_MS)
    expect(put).toHaveBeenCalledTimes(4)
    // Every tab closed: an empty list, said too.
    rerender({ ids: [] })
    expect(put).toHaveBeenLastCalledWith(viewer, [])
  })

  it('keeps one viewer id per browser', () => {
    const id = viewerId()
    expect(localStorage.getItem(VIEWER_KEY)).toBe(id)
    expect(viewerId()).toBe(id)
  })
})
