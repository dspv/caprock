import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { live, useLiveTick } from './live'

describe('live store', () => {
  it('collects alerts and bumps tick on session/event frames', () => {
    const t0 = live.getState().tick
    live.handle({ type: 'event', data: { id: 1, ts: '', session_id: 's', source: 'hook', kind: 'tool.pre', payload: {} } })
    live.handle({ type: 'alert', data: { kind: 'loop', session_id: 's', tool: 'Bash', count: 5, window_min: 3, sample: 'Bash: x', first_ts: '', last_ts: '', ts: '' } })
    const st = live.getState()
    expect(st.tick).toBe(t0 + 2)
    expect(st.alerts).toHaveLength(1)
    expect(st.lastEvent?.kind).toBe('tool.pre')
    live.dismissAlert('s')
    expect(live.getState().alerts).toHaveLength(0)
  })
})

describe('loop alerts are one per session', () => {
  it('replaces an earlier alert for the same session instead of stacking', () => {
    // A session that loops twice produced two identical banners — same tool,
    // same count, same cost — which reads as a rendering bug.
    const store = new (live.constructor as new () => typeof live)()
    const alert = (ts: string) => ({
      type: 'alert' as const,
      data: { kind: 'loop' as const, session_id: 's1', tool: 'Bash', count: 5, window_min: 3, sample: 'x', first_ts: ts, last_ts: ts, ts },
    })
    store.handle(alert('2026-08-20T10:00:00Z'))
    store.handle(alert('2026-08-20T11:00:00Z'))
    const { alerts } = store.getState()
    expect(alerts).toHaveLength(1)
    expect(alerts[0]!.ts).toBe('2026-08-20T11:00:00Z')
  })
})

/**
 * A queued reconnect can outlive the document that scheduled it.
 *
 * A test mounts something that opens the socket, it does not connect, and a
 * retry is queued 500ms out. The test ends, jsdom is torn down, and the timer
 * fires into a window with no `location`. Harmless in a browser, where the page
 * is going away anyway — and on CI it is an unhandled ReferenceError that failed
 * a release whose 478 tests had every one of them passed. It does not reproduce
 * locally, because it depends on which test happens to be running when the
 * timer comes due.
 */
describe('reconnecting after the page has gone', () => {
  it('gives up quietly rather than throwing into a torn-down document', () => {
    const saved = globalThis.location
    delete (globalThis as { location?: unknown }).location
    try {
      expect(() => live.start()).not.toThrow()
    } finally {
      globalThis.location = saved
    }
  })
})

/**
 * Twice now a release has failed with every test passing: a debounce timer
 * fired after the run had torn the DOM down, and `window` was gone. The timer
 * outliving its component is the real defect — a screen closed inside the
 * debounce window sets state on something that no longer exists — and the
 * broken release was only how we noticed.
 */
describe('the live tick timer does not outlive its component', () => {
  it('cancels a pending debounce on unmount', () => {
    vi.useFakeTimers()
    try {
      const { unmount } = render(<TickProbe />)
      act(() => { live.handle({ type: 'session', data: { session_id: 's', tick: 1 } as never }) })
      unmount()
      // Nothing left to fire: if the timer survived, it would call setState on
      // an unmounted component here.
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

function TickProbe() {
  return <span>{useLiveTick(400)}</span>
}

/** A /v1/live socket the test plays the daemon for. */
class FakeLiveSocket {
  static OPEN = 1
  static CLOSED = 3
  static all: FakeLiveSocket[] = []
  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) { FakeLiveSocket.all.push(this) }
  send(d: string) { this.sent.push(d) }
  close() { if (this.readyState !== FakeLiveSocket.CLOSED) this.drop() }
  // Daemon side.
  accept() { this.readyState = FakeLiveSocket.OPEN; this.onopen?.() }
  frame(v: unknown) { this.onmessage?.({ data: JSON.stringify(v) }) }
  drop() { this.readyState = FakeLiveSocket.CLOSED; this.onclose?.() }
}

describe('live replay', () => {
  const lastSocket = () => FakeLiveSocket.all[FakeLiveSocket.all.length - 1]!
  const since = (s: FakeLiveSocket) => new URL(s.url).searchParams.get('since')
  const fresh = () => new (live.constructor as new () => typeof live)()

  beforeEach(() => {
    FakeLiveSocket.all = []
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeLiveSocket)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('resumes from the last seq, applies each missed frame once, and shows a notify missed while offline', () => {
    const store = fresh()
    const seen: string[] = []
    store.onFrame((f) => seen.push(`${f.type}:${f.seq}`))
    store.start()
    const s1 = lastSocket()
    expect(since(s1)).toBeNull() // a first connect asks for nothing
    s1.accept()
    s1.frame({ type: 'hello', seq: 100, data: { server_time: 0, reset: false } })
    s1.frame({ type: 'session', seq: 101, data: {} })
    s1.drop()

    vi.advanceTimersByTime(500)
    const s2 = lastSocket()
    expect(since(s2)).toBe('101')
    s2.accept()
    s2.frame({ type: 'hello', seq: 101, data: { server_time: 0, reset: false } })
    s2.frame({ type: 'event', seq: 102, data: { id: 1, ts: '', session_id: 's', source: 'hook', kind: 'tool.pre', payload: {} } })
    s2.frame({ type: 'notify', seq: 103, data: { id: 'n1', kind: 'approval', session_id: 's', title: 'Approve?', body: 'rm -rf build' } })
    s2.frame({ type: 'notify', seq: 103, data: { id: 'n1', kind: 'approval', session_id: 's', title: 'Approve?', body: 'rm -rf build' } }) // a duplicate
    expect(seen).toEqual(['hello:100', 'session:101', 'hello:101', 'event:102', 'notify:103'])
    expect(store.getState().notifications.map((n) => n.id)).toEqual(['n1'])
  })

  it('refetches on reset and resumes from the reset seq', () => {
    const store = fresh()
    store.start()
    const s1 = lastSocket()
    s1.accept()
    s1.frame({ type: 'hello', seq: 5, data: { server_time: 0 } })
    s1.drop()
    vi.advanceTimersByTime(500)
    const s2 = lastSocket()
    s2.accept()
    const tick = store.getState().tick
    s2.frame({ type: 'hello', seq: 9000, data: { server_time: 0, reset: true } })
    s2.frame({ type: 'reset', seq: 9000, data: { seq: 9000 } })
    expect(store.getState().tick).toBe(tick + 1)
    s2.frame({ type: 'session', seq: 9001, data: {} })
    s2.drop()
    vi.advanceTimersByTime(500)
    expect(since(lastSocket())).toBe('9001')
  })

  it('answers a ping, pings every 10 s, and reconnects after 25 s of silence', () => {
    const store = fresh()
    store.start()
    const s1 = lastSocket()
    s1.accept()
    s1.frame({ type: 'hello', seq: 1, data: { server_time: 0 } })
    s1.frame({ type: 'ping', seq: 1, data: 77 })
    expect(s1.sent).toContain('{"pong":77}')
    vi.advanceTimersByTime(10_000)
    expect(s1.sent.some((m) => m.startsWith('{"ping":'))).toBe(true)
    expect(FakeLiveSocket.all).toHaveLength(1)
    vi.advanceTimersByTime(21_000) // past 25 s with nothing heard (checked every 5 s)
    expect(s1.readyState).toBe(FakeLiveSocket.CLOSED)
    vi.advanceTimersByTime(500)
    expect(FakeLiveSocket.all).toHaveLength(2)
    expect(since(lastSocket())).toBe('1')
  })
})
