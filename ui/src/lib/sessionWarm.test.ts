import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const diff = vi.fn((id: string) => Promise.resolve({ root: `/r/${id}`, files: [] }))
const calls = vi.fn((_id: string) => Promise.resolve([]))
const warmEvents = vi.fn()
vi.mock('./api', () => ({ api: { diff: (id: string) => diff(id), sessionCalls: (id: string) => calls(id) } }))
vi.mock('./sessionEvents', () => ({ warmSessionEvents: (id: string) => warmEvents(id) }))

const { KEPT, WARM_FRESH_MS, keepDiff, keptCalls, keptDiff, resetSessionWarm, warmSession } = await import('./sessionWarm')

describe('sessionWarm', () => {
  beforeEach(() => { vi.useFakeTimers(); resetSessionWarm(); diff.mockClear(); calls.mockClear(); warmEvents.mockClear() })
  afterEach(() => vi.useRealTimers())

  it('a hovered tab reads its calls, working tree and call series ahead, once', async () => {
    warmSession('s1')
    warmSession('s1')
    await vi.runAllTimersAsync()
    expect(warmEvents).toHaveBeenCalledWith('s1')
    expect(diff).toHaveBeenCalledTimes(1)
    expect(calls).toHaveBeenCalledTimes(1)
    expect(keptDiff('s1')?.root).toBe('/r/s1')
    expect(keptCalls('s1')?.id).toBe('s1')
    // Fresh: a second hover asks nothing.
    warmSession('s1')
    expect(diff).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(WARM_FRESH_MS + 1)
    warmSession('s1')
    expect(diff).toHaveBeenCalledTimes(2)
  })

  it('a shell reads its working tree alone', () => {
    warmSession('sh', false)
    expect(warmEvents).not.toHaveBeenCalled()
    expect(calls).not.toHaveBeenCalled()
    expect(diff).toHaveBeenCalledTimes(1)
  })

  it('keeps the newest KEPT sessions', () => {
    for (let i = 0; i <= KEPT; i++) keepDiff(`s${i}`, { root: '', files: [] } as never)
    expect(keptDiff('s0')).toBeUndefined()
    expect(keptDiff(`s${KEPT}`)).toBeDefined()
  })
})
