import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateStatus } from './api'

const h = vi.hoisted(() => ({ calls: 0, reply: undefined as unknown, fail: false }))
vi.mock('./api', async (orig) => {
  const actual = await orig<typeof import('./api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      checkUpdateSoon: async () => {
        h.calls++
        if (h.fail) throw new Error('offline')
        return h.reply
      },
    },
  }
})

import { SOON_MS, askSoon, onWindowFront, resetSoon, soonDue } from './updatesoon'

const MIN = 60_000
const T0 = 1_800_000_000_000
const on: UpdateStatus = { enabled: true, current: 'v0.123.1', update_available: false, checked_at: T0 }

beforeEach(() => {
  resetSoon()
  h.calls = 0
  h.fail = false
  h.reply = { ...on, latest: 'v0.124.0', update_available: true, checked_at: T0 + 12 * MIN }
})
afterEach(() => { vi.restoreAllMocks() })

describe('a release check when the window comes to the front', () => {
  it('is due ten minutes after the last check, not sooner', () => {
    expect(SOON_MS).toBe(10 * MIN)
    expect(soonDue(on, T0 + 9 * MIN, 0)).toBe(false)
    expect(soonDue(on, T0 + 10 * MIN, 0)).toBe(true)
  })

  it('never while checks are off, or before the status is known', () => {
    expect(soonDue({ ...on, enabled: false }, T0 + 60 * MIN, 0)).toBe(false)
    expect(soonDue(undefined, T0 + 60 * MIN, 0)).toBe(false)
  })

  it('counts this page’s own last ask as well as the daemon’s check', () => {
    expect(soonDue(on, T0 + 30 * MIN, T0 + 25 * MIN)).toBe(false)
    expect(soonDue(on, T0 + 35 * MIN, T0 + 25 * MIN)).toBe(true)
    // Never checked by the daemon: due at once.
    expect(soonDue({ ...on, checked_at: undefined }, T0, 0)).toBe(true)
  })

  it('asks the daemon at most once per ten minutes, however often focused', async () => {
    const st = { ...on, checked_at: T0 - 20 * MIN }
    expect(await askSoon(st, T0)).toMatchObject({ latest: 'v0.124.0', update_available: true })
    for (let m = 1; m < 10; m++) expect(askSoon(st, T0 + m * MIN)).toBeNull()
    expect(h.calls).toBe(1)
    await askSoon(st, T0 + 10 * MIN)
    expect(h.calls).toBe(2)
  })

  it('shares one request among everyone asking in the same moment', async () => {
    const st = { ...on, checked_at: T0 - 20 * MIN }
    const a = askSoon(st, T0)
    const b = askSoon(st, T0)
    expect(a).not.toBeNull()
    expect(b).toBe(a)
    await a
    expect(h.calls).toBe(1)
  })

  it('a failed ask resolves to nothing and still waits ten minutes', async () => {
    h.fail = true
    const st = { ...on, checked_at: T0 - 20 * MIN }
    expect(await askSoon(st, T0)).toBeUndefined()
    expect(askSoon(st, T0 + 5 * MIN)).toBeNull()
    expect(h.calls).toBe(1)
  })

  it('fires on window focus and when the page is shown', () => {
    const fn = vi.fn()
    const stop = onWindowFront(fn)
    window.dispatchEvent(new Event('focus'))
    expect(fn).toHaveBeenCalledTimes(1)
    const vis = vi.spyOn(document, 'visibilityState', 'get')
    vis.mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    vis.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(fn).toHaveBeenCalledTimes(2)
    stop()
    window.dispatchEvent(new Event('focus'))
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
