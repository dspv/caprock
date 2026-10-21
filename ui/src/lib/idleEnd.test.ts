import { describe, expect, it } from 'vitest'
import type { SessionSummary } from './api'
import { IDLE_ENDED_LINGER_MS, idleEnded, idleEndedRecently, idleEndedText, idleEndedWord } from './idleEnd'
import { isBackgroundSession } from './sidebar'

const NOW = Date.UTC(2026, 9, 21, 12)
const s = (p: Partial<SessionSummary>) => ({
  session_id: 's', cwd: '/w/alpha', status: 'ended', owned: true, title: 'A chat', started_at: NOW - 30 * 3_600_000,
  last_event_at: NOW - 30 * 3_600_000, activity: { phrase: '', at: '', health: 'ended' }, ...p,
}) as SessionSummary

describe('idleEndedText', () => {
  it('names the window that ended it', () => {
    expect(idleEndedText(s({ idle_ended_at: NOW, idle_ended_after_ms: 12 * 3_600_000 }))).toBe('Ended after 12 h idle')
    expect(idleEndedText(s({ idle_ended_at: NOW, idle_ended_after_ms: 2 * 3_600_000 }))).toBe('Ended after 2 h idle')
    expect(idleEndedText(s({ idle_ended_at: NOW, idle_ended_after_ms: 24 * 3_600_000 }))).toBe('Ended after 24 h idle')
    expect(idleEndedText(s({ idle_ended_at: NOW }))).toBe('Ended while idle')
    expect(idleEndedWord(s({ idle_ended_at: NOW, idle_ended_after_ms: 12 * 3_600_000 }))).toBe('12 h idle · continue')
    expect(idleEndedWord(s({}))).toBe('')
  })

  it('says nothing for a session ended otherwise, or continued since', () => {
    expect(idleEndedText(s({}))).toBe('')
    // Continued: the daemon clears the mark, and a live one never reads as ended.
    expect(idleEndedText(s({ status: 'active', idle_ended_at: NOW, idle_ended_after_ms: 1 }))).toBe('')
    expect(idleEnded(undefined)).toBe(false)
  })
})

describe('idleEndedRecently', () => {
  it('keeps the row for a day after the end', () => {
    const one = s({ idle_ended_at: NOW - 1000, idle_ended_after_ms: 12 * 3_600_000 })
    expect(idleEndedRecently(one, NOW)).toBe(true)
    expect(idleEndedRecently(one, NOW + IDLE_ENDED_LINGER_MS)).toBe(false)
  })

  it('is never folded into Background, though nothing happened in it for a day', () => {
    const one = s({ idle_ended_at: NOW - 1000, idle_ended_after_ms: 24 * 3_600_000 })
    expect(isBackgroundSession(one, { now: NOW })).toBe(false)
    expect(isBackgroundSession(s({}), { now: NOW })).toBe(true)
  })
})
