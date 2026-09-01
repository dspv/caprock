import { describe, expect, it } from 'vitest'
import { live } from './live'

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
