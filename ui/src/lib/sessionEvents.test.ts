import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const recent = vi.fn((_id: string, _kinds: readonly string[], _n: number) => Promise.resolve([]))
const offs: (() => void)[] = []
vi.mock('./api', () => ({ api: { recentMainEvents: (id: string, k: readonly string[], n: number) => recent(id, k, n) } }))
vi.mock('./live', () => ({ live: { onFrame: () => { const off = vi.fn(); offs.push(off); return off } } }))

const { heldSessions, LINGER, LINGER_MS, resetSessionEvents, useSessionEvents, warmSessionEvents } = await import('./sessionEvents')
const { renderHook } = await import('@testing-library/react')

describe('sessionEvents: a session no panel reads lingers', () => {
  beforeEach(() => { vi.useFakeTimers(); recent.mockClear(); resetSessionEvents() })
  afterEach(() => { resetSessionEvents(); vi.useRealTimers() })

  it('read again soon after its last reader went, it is not fetched again', () => {
    const a = renderHook(() => useSessionEvents('s1'))
    expect(recent).toHaveBeenCalledTimes(1)
    a.unmount()
    expect(heldSessions()).toBe(1)
    renderHook(() => useSessionEvents('s1'))
    expect(recent).toHaveBeenCalledTimes(1)
  })

  it('goes after LINGER_MS unread, listener and all', () => {
    renderHook(() => useSessionEvents('s1')).unmount()
    vi.advanceTimersByTime(LINGER_MS + 1)
    expect(heldSessions()).toBe(0)
  })

  it('keeps only the LINGER newest unread', () => {
    for (let i = 0; i < LINGER + 3; i++) renderHook(() => useSessionEvents(`s${i}`)).unmount()
    expect(heldSessions()).toBe(LINGER)
  })

  it('a warmed session is fetched once, and its first reader draws from it', () => {
    warmSessionEvents('w')
    warmSessionEvents('w')
    expect(recent).toHaveBeenCalledTimes(1)
    renderHook(() => useSessionEvents('w'))
    expect(recent).toHaveBeenCalledTimes(1)
  })
})
