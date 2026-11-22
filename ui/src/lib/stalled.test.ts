import { describe, expect, it } from 'vitest'
import type { SessionSummary } from './api'
import { STALL_MS } from './chatActivity'
import { fmtAgeCompact, stalledAge, stalledWord } from './stalled'

const now = Date.parse('2026-11-22T22:00:00Z')
const row = (p: Partial<SessionSummary>) => ({
  turn_open: true, status: 'idle', last_event_at: now - 2 * 86_400_000,
  activity: { phrase: 'was reading your prompt', at: '', health: 'idle' }, ...p,
}) as SessionSummary

describe('fmtAgeCompact', () => {
  it('says an age in one whole unit: minutes, hours, then days', () => {
    expect(fmtAgeCompact(25 * 60_000)).toBe('25m')
    expect(fmtAgeCompact(59 * 60_000 + 59_000)).toBe('59m')
    expect(fmtAgeCompact(60 * 60_000)).toBe('1h')
    expect(fmtAgeCompact(2 * 3_600_000 + 50 * 60_000)).toBe('2h')
    expect(fmtAgeCompact(12 * 3_600_000)).toBe('12h')
    expect(fmtAgeCompact(23 * 3_600_000 + 59 * 60_000)).toBe('23h')
    expect(fmtAgeCompact(24 * 3_600_000)).toBe('1d')
    expect(fmtAgeCompact(2 * 86_400_000 + 5 * 3_600_000)).toBe('2d')
    expect(fmtAgeCompact(-5000)).toBe('0m')
  })
  it('makes the row\'s words', () => {
    expect(stalledWord(2 * 86_400_000)).toBe('no reply 2d')
  })
})

describe('stalledAge', () => {
  it('is the time since the last event once an open turn has been quiet for STALL_MS', () => {
    expect(stalledAge(row({}), now)).toBe(2 * 86_400_000)
    expect(stalledAge(row({ last_event_at: now - STALL_MS }), now)).toBe(STALL_MS)
  })
  it('is null under STALL_MS: a working agent logs something every few seconds', () => {
    expect(stalledAge(row({ last_event_at: now - STALL_MS + 1000 }), now)).toBeNull()
  })
  it('is null with no open turn, for an ended session, or without a last event', () => {
    expect(stalledAge(row({ turn_open: undefined }), now)).toBeNull()
    expect(stalledAge(row({ status: 'ended' }), now)).toBeNull()
    expect(stalledAge(row({ last_event_at: 0 }), now)).toBeNull()
  })
  it('is null while something waits on you, or a loop has its own mark', () => {
    expect(stalledAge(row({}), now, true)).toBeNull()
    expect(stalledAge(row({ activity: { phrase: '', at: '', health: 'waiting-on-you' } }), now)).toBeNull()
    expect(stalledAge(row({ activity: { phrase: '', at: '', health: 'looping' } }), now)).toBeNull()
  })
})
