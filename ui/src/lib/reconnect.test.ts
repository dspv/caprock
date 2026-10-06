/**
 * The shared reconnect policy (WP-13): full jitter between 0.5 s and a 15 s
 * cap, forever; an attempt at once when the page or the network comes back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CONNECT_TIMEOUT_MS, DEAD_MS, PROBE_MS, SUSPECT_MS, isSuspect, RECONNECT_MAX_MS, RECONNECT_MIN_MS, Reconnector,
  isConnectStuck, isProbeLost, isSilent, onNetworkWake, reconnectDelay,
} from './reconnect'

describe('reconnectDelay', () => {
  it('starts at 0.5 s and never passes 15 s', () => {
    expect(reconnectDelay(0, () => 0.99)).toBeLessThanOrEqual(RECONNECT_MIN_MS)
    for (let n = 0; n < 60; n++) {
      expect(reconnectDelay(n, () => 0)).toBe(RECONNECT_MIN_MS)
      expect(reconnectDelay(n, () => 1)).toBeLessThanOrEqual(RECONNECT_MAX_MS)
    }
    expect(reconnectDelay(10, () => 1)).toBe(RECONNECT_MAX_MS)
  })

  it('is full jitter: any delay from the floor to the ceiling, not only its upper half', () => {
    // Half jitter (the terminal's old policy) never went below half the
    // ceiling; full jitter spreads phones that lost the same Wi-Fi.
    let seed = 7
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31 }
    const samples = Array.from({ length: 2000 }, () => reconnectDelay(20, rand)).sort((a, b) => a - b)
    expect(samples[0]).toBeLessThan(RECONNECT_MAX_MS / 10)
    expect(samples[samples.length - 1]).toBeGreaterThan(RECONNECT_MAX_MS * 0.95)
    const median = samples[samples.length / 2]!
    expect(median).toBeGreaterThan(RECONNECT_MAX_MS * 0.4)
    expect(median).toBeLessThan(RECONNECT_MAX_MS * 0.6)
  })

  it('doubles its ceiling per attempt', () => {
    expect([0, 1, 2, 3, 4, 5].map((n) => reconnectDelay(n, () => 1))).toEqual([500, 1000, 2000, 4000, 8000, 15000])
  })
})

describe('liveness', () => {
  it('asks a socket silent for SUSPECT_MS for a round trip, once', () => {
    expect(isSuspect(0, 0, SUSPECT_MS - 1)).toBe(false)
    expect(isSuspect(0, 0, SUSPECT_MS)).toBe(true)
    expect(isSuspect(0, SUSPECT_MS, SUSPECT_MS + 500)).toBe(false)
    expect(SUSPECT_MS + PROBE_MS).toBeLessThan(DEAD_MS)
  })

  it('takes a socket for dead within DEAD_MS of the last thing it said', () => {
    expect(isSilent(0, DEAD_MS - 2_000)).toBe(false)
    expect(isSilent(0, DEAD_MS)).toBe(true)
  })

  it('gives up on an attempt hung opening', () => {
    expect(isConnectStuck(0, 0, CONNECT_TIMEOUT_MS)).toBe(false)
    expect(isConnectStuck(0, 0, CONNECT_TIMEOUT_MS + 1)).toBe(true)
    expect(isConnectStuck(1, 0, CONNECT_TIMEOUT_MS * 5)).toBe(false)
  })

  it('drops a woken socket that did not answer its ping', () => {
    expect(isProbeLost(0, 0, 60_000)).toBe(false) // no probe
    expect(isProbeLost(1_000, 1_000, 1_000 + PROBE_MS)).toBe(true)
    expect(isProbeLost(1_000, 1_500, 1_000 + PROBE_MS)).toBe(false) // answered
    expect(isProbeLost(1_000, 900, 1_000 + PROBE_MS - 1)).toBe(false) // not yet
  })
})

describe('Reconnector', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('retries forever, reports the attempt and the next try, and resets once live', () => {
    const connect = vi.fn()
    const seen: number[] = []
    const r = new Reconnector({ connect, random: () => 1, onChange: (s) => seen.push(s.attempt) })
    const start = Date.now()
    r.fail()
    expect(r.status).toEqual({ attempt: 0, nextAt: start + 500, downSince: start })
    vi.advanceTimersByTime(499)
    expect(connect).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(connect).toHaveBeenCalledTimes(1)
    expect(r.status.attempt).toBe(1)
    expect(r.status.nextAt).toBeNull()
    // A thousand failures later it is still trying, 15 s apart at most.
    for (let i = 0; i < 1000; i++) { r.fail(); vi.advanceTimersByTime(RECONNECT_MAX_MS) }
    expect(connect).toHaveBeenCalledTimes(1001)
    expect(r.status.downSince).toBe(start)
    r.succeed()
    expect(r.status).toEqual({ attempt: 0, nextAt: null, downSince: null })
    expect(seen.at(-1)).toBe(0)
  })

  it('never schedules two attempts for one loss', () => {
    const connect = vi.fn()
    const r = new Reconnector({ connect, random: () => 0 })
    r.fail(); r.fail(); r.fail()
    vi.advanceTimersByTime(RECONNECT_MAX_MS)
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('retries at once when asked, instead of at the end of the backoff', () => {
    const connect = vi.fn()
    const r = new Reconnector({ connect, random: () => 1 })
    for (let i = 0; i < 8; i++) { r.fail(); vi.advanceTimersByTime(RECONNECT_MAX_MS) }
    r.fail()
    expect(connect).toHaveBeenCalledTimes(8)
    r.retryNow()
    expect(connect).toHaveBeenCalledTimes(9)
    // The pending timer went with it.
    vi.advanceTimersByTime(RECONNECT_MAX_MS)
    expect(connect).toHaveBeenCalledTimes(9)
  })

  it('retries at once when the network came back during an attempt that then failed', () => {
    const connect = vi.fn()
    const r = new Reconnector({ connect, random: () => 1 })
    for (let i = 0; i < 8; i++) { r.fail(); vi.advanceTimersByTime(RECONNECT_MAX_MS) }
    r.expedite() // "online" while attempt 8 is still opening
    r.fail() // …and then it fails
    vi.advanceTimersByTime(0)
    expect(connect).toHaveBeenCalledTimes(9)
    r.fail() // the one after that backs off as usual
    vi.advanceTimersByTime(RECONNECT_MAX_MS - 1)
    expect(connect).toHaveBeenCalledTimes(9)
  })

  it('cancel leaves nothing scheduled', () => {
    const connect = vi.fn()
    const r = new Reconnector({ connect })
    r.fail()
    r.cancel()
    vi.advanceTimersByTime(60_000)
    expect(connect).not.toHaveBeenCalled()
    expect(r.status.nextAt).toBeNull()
  })
})

describe('onNetworkWake', () => {
  let hidden = false
  beforeEach(() => {
    hidden = false
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => (hidden ? 'hidden' : 'visible'))
  })
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('wakes on visible, online, pageshow and a network type change — never while hidden', () => {
    const listeners = new Set<() => void>()
    const connection = {
      addEventListener: (_t: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_t: string, fn: () => void) => listeners.delete(fn),
    }
    Object.defineProperty(navigator, 'connection', { configurable: true, value: connection })
    const wake = vi.fn()
    const off = onNetworkWake(wake)
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('online'))
    window.dispatchEvent(new Event('pageshow'))
    for (const fn of listeners) fn()
    expect(wake).toHaveBeenCalledTimes(4)
    hidden = true
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('online'))
    expect(wake).toHaveBeenCalledTimes(4)
    hidden = false
    off()
    window.dispatchEvent(new Event('online'))
    expect(wake).toHaveBeenCalledTimes(4)
    expect(listeners.size).toBe(0)
    delete (navigator as { connection?: unknown }).connection
  })
})
