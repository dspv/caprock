import { describe, expect, it } from 'vitest'
import type { CompactionView, SessionSummary } from './api'
import { COMPACT_WATCH_MS, compactIcon, compactOffer, compactPhase, keptLine, resultLine } from './compact'

type S = Pick<SessionSummary, 'agent' | 'status' | 'owned' | 'detached' | 'context'>
const s = (p: Partial<S> = {}): S => ({
  agent: 'claude', status: 'active', owned: true, detached: false,
  context: { tokens: 467_121, window: 1_000_000, pct: 46.7, next_call_usd: 0.2 }, ...p,
})

describe('who is offered compaction', () => {
  it('a live Claude Code session Caprock started presses; someone else’s terminal types', () => {
    expect(compactOffer(s())).toBe('press')
    expect(compactOffer(s({ owned: false }))).toBe('type')
    expect(compactOffer(s({ detached: true }))).toBe('type')
  })
  it('nothing under 100k tokens, for another agent, an ended session, or a viewer phone', () => {
    expect(compactOffer(s({ context: { tokens: 99_999, window: 200_000, pct: 50, next_call_usd: 0 } }))).toBe('none')
    expect(compactOffer(s({ context: undefined }))).toBe('none')
    expect(compactOffer(s({ agent: 'codex' }))).toBe('none')
    expect(compactOffer(s({ status: 'ended' }))).toBe('none')
    expect(compactOffer(s(), false)).toBe('none')
  })
  it('the collapsed line’s icon only from 60% full', () => {
    expect(compactIcon(s())).toBe(false)
    expect(compactIcon(s({ context: { tokens: 130_000, window: 200_000, pct: 65, next_call_usd: 0 } }))).toBe(true)
    expect(compactIcon(s({ context: { tokens: 90_000, window: 100_000, pct: 90, next_call_usd: 0 } }))).toBe(false)
  })
})

describe('what it says', () => {
  it('names where “usually stays” comes from: the labelled reference, then this machine’s own from five', () => {
    const ref = keptLine(undefined)
    expect(ref.text).toBe('Usually ~15% stays')
    expect(ref.source).toBe('measured on one machine: 70 automatic compactions, 2026-09-29 – 2026-10-25; 9 in 10 kept 25% or less')
    const own = keptLine({ count: 12, median_kept: 0.183, p90_kept: 0.3, median_pre: 400_000, median_post: 70_000, from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 9, 26) })
    expect(own.text).toBe('Usually ~18% stays')
    expect(own.source).toBe('median of 12 compactions measured here, 2026-10-01 – 2026-10-26; 9 in 10 kept 30% or less')
  })
  it('the measured before → after, the after once a reply has measured it', () => {
    const now = Date.UTC(2026, 9, 27, 12)
    expect(resultLine({ at: now - 1000, trigger: 'manual', pre_tokens: 467_121, post_tokens: 61_388 }, now, true)).toBe('Compacted: 467.1k → 61.4k tokens')
    expect(resultLine({ at: now - 3 * 3600_000, trigger: 'auto', pre_tokens: 467_121, post_tokens: 61_388 }, now)).toBe('Auto-compacted 3h ago: 467.1k → 61.4k tokens')
    expect(resultLine({ at: now, trigger: 'manual', pre_tokens: 467_121 }, now, true)).toBe('Compacted from 467.1k tokens · the size after shows with the next reply')
  })
})

describe('the phase', () => {
  const now = Date.UTC(2026, 9, 27, 12)
  const v = (p: Partial<CompactionView> = {}): CompactionView => ({ session_id: 's1', running: false, queued: false, ...p })
  it('the daemon’s running and queued, then the boundary the press made', () => {
    expect(compactPhase(v(), undefined, now)).toEqual({ kind: 'idle' })
    expect(compactPhase(v({ queued: true }), undefined, now)).toEqual({ kind: 'queued' })
    expect(compactPhase(v({ running: true }), undefined, now)).toEqual({ kind: 'running' })
    const press = { at: now - 5000, sent: true }
    expect(compactPhase(v(), press, now)).toEqual({ kind: 'running' })
    expect(compactPhase(v(), { ...press, sent: false }, now)).toEqual({ kind: 'queued' })
    const last = { at: now - 2000, trigger: 'manual', pre_tokens: 467_121 }
    expect(compactPhase(v({ last }), press, now)).toEqual({ kind: 'done', last })
  })
  it('an older boundary is not the press’s, and a press stops being watched', () => {
    const press = { at: Date.UTC(2026, 9, 27, 11, 59), sent: true }
    expect(compactPhase(v({ last: { at: press.at - 60_000, trigger: 'auto', pre_tokens: 1 } }), press, press.at + 1000).kind).toBe('running')
    expect(compactPhase(v(), press, press.at + COMPACT_WATCH_MS + 1).kind).toBe('idle')
  })
})
