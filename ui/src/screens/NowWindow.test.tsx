/**
 * "Now" is a screen about now.
 *
 * A session that has not made a sound in days is history, whatever its status
 * column says — and the status alone cannot tell them apart, because an
 * observed agent's sessions are read out of its own database and arrive
 * already weeks old. Connecting OpenCode filled this screen with 97-day-old
 * rows marked idle: true, and useless.
 */
import { describe, expect, it } from 'vitest'
import { recentEnough, NOW_WINDOW_MS } from './Now'

const now = Date.UTC(2026, 8, 2, 12, 0, 0)
const ago = (ms: number) => ({ last_event_at: now - ms })

describe('what belongs on the Now screen', () => {
  it('keeps a session from an hour ago', () => {
    expect(recentEnough(ago(60 * 60 * 1000), now)).toBe(true)
  })

  it('keeps a session left overnight on Friday, seen on Monday', () => {
    // The reason the window is two days and not one.
    expect(recentEnough(ago(47 * 60 * 60 * 1000), now)).toBe(true)
  })

  it('drops a session from three months ago', () => {
    expect(recentEnough(ago(97 * 24 * 60 * 60 * 1000), now)).toBe(false)
  })

  it('shows a session whose timestamp is missing', () => {
    // Not knowing when something happened is not evidence that it was long
    // ago, and hiding a live session is the worse mistake.
    expect(recentEnough({ last_event_at: null }, now)).toBe(true)
    expect(recentEnough({}, now)).toBe(true)
  })

  it('uses a window measured in days, not minutes', () => {
    // Guards against someone "tidying" this into an idle timeout: this is
    // about what is worth looking at, not about what is running.
    expect(NOW_WINDOW_MS).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000)
  })
})
