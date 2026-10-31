import { describe, expect, it } from 'vitest'
import type { CompactionEstimate, CompactionView, SessionSummary } from './api'
import { COMPACT_WATCH_MS, compactIcon, compactInfo, compactLine, compactOffer, compactPhase, keptLine, savingOf, savingsPath, tokShort } from './compact'

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
    expect(ref.text).toBe('~15% stays')
    expect(ref.source).toBe('measured on one machine: 70 automatic compactions, 2026-09-29 – 2026-10-25; 9 in 10 kept 25% or less')
    const own = keptLine({ count: 12, median_kept: 0.183, p90_kept: 0.3, median_pre: 400_000, median_post: 70_000, from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 9, 26) })
    expect(own.text).toBe('~18% stays')
    expect(own.source).toBe('median of 12 compactions measured here, 2026-10-01 – 2026-10-26; 9 in 10 kept 30% or less')
  })
  it('one line: when, before → after, and the estimated cost once the daemon has made it', () => {
    const now = Date.UTC(2026, 9, 27, 12)
    const c = { at: now - 32 * 3600_000, trigger: 'auto', pre_tokens: 442_446, post_tokens: 19_177 }
    expect(compactLine(c, undefined, now)).toBe('32h ago · 442k → 19k')
    const est: CompactionEstimate = { at: c.at, warm: true, est_cost_usd: 0.0935, est_saved_usd: 13.5, turns_after: 165, series: [], pricing_version: 'p' }
    expect(compactLine(c, est, now)).toBe('32h ago · 442k → 19k · cost ≈ $0.09')
    // Another compaction's estimate is never borrowed.
    expect(compactLine(c, { ...est, at: c.at - 1 }, now)).toBe('32h ago · 442k → 19k')
    expect(compactLine({ at: now, trigger: 'manual', pre_tokens: 467_121 }, undefined, now)).toBe('now · from 467k · the after shows with the next reply')
    expect([tokShort(950), tokShort(19_177), tokShort(1_250_000), tokShort(999_600)]).toEqual(['950', '19k', '1.3M', '1M'])
  })
  it('the savings curve: this compaction’s, once a call followed, a step per point ending top right', () => {
    const c = { at: 1000, trigger: 'auto', pre_tokens: 400_000, post_tokens: 20_000 }
    const series = [{ at: 1000, saved_usd: 0 }, { at: 2000, saved_usd: 1 }, { at: 3000, saved_usd: 2 }]
    const est: CompactionEstimate = { at: 1000, warm: true, est_saved_usd: 2, turns_after: 2, series, pricing_version: 'p' }
    expect(savingOf(c, est)).toBe(est)
    expect(savingOf(c, { ...est, turns_after: 0, series: series.slice(0, 1) })).toBeUndefined()
    expect(savingOf({ ...c, at: 5 }, est)).toBeUndefined()
    expect(savingsPath(series, 300, 20)).toBe('M0 19.0 L150.0 19.0 L150.0 10.0 L300.0 10.0 L300.0 1.0')
    expect(savingsPath(series.slice(0, 1), 300, 20)).toBe('')
  })
  it('the ⓘ names the assumptions behind every ≈', () => {
    const c = { at: 1000, trigger: 'auto', pre_tokens: 400_000, post_tokens: 20_000 }
    const est: CompactionEstimate = { at: 1000, model: 'claude-opus-5-5', warm: false, summary_tokens_est: 4800, est_cost_usd: 1.7, est_saved_usd: 2, turns_after: 2, series: [], pricing_version: 'p' }
    const info = compactInfo(keptLine(undefined), c, est)
    expect(info.map((p) => p.lead)).toEqual(['/compact', '~15% stays', 'Cost ≈', 'Saved ≈'])
    expect(info[2]!.text).toMatch(/5 minutes, or 1 hour/)
    expect(info[2]!.text).toMatch(/~5k tokens\) as output, at claude-opus-5-5's list prices\. This one: cache cold\./)
    expect(info[3]!.text).toBe("Each of the 2 calls since re-read 380k fewer tokens, at its model's cache-read price. An estimate; not counted against the cost above.")
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
