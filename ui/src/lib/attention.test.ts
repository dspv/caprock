/**
 * Attention rules decide when to interrupt someone, so the discipline they
 * encode is pinned here: stay silent when nothing is wrong, don't fire on a
 * session that merely asked a question a moment ago, and never treat a large
 * bill as a problem in itself — spending is the job.
 */
import { describe, expect, it } from 'vitest'
import { findAttention } from './attention'
import type { LoopAlert, SessionSummary } from './api'

const NOW = Date.parse('2026-08-20T12:00:00Z')

function session(over: Partial<SessionSummary> & { session_id: string }): SessionSummary {
  return {
    project: 'caprock',
    status: 'active',
    last_event_at: NOW,
    activity: { health: 'working', phrase: 'editing a file', at: '2026-08-20T11:59:50Z' },
    stats: { cost_usd: 1, turns: 1, tool_calls: 1, files_touched: 1 },
    ...over,
  } as unknown as SessionSummary
}

function alert(over: Partial<LoopAlert> = {}): LoopAlert {
  return {
    kind: 'loop',
    session_id: 's-loop',
    tool: 'Bash',
    count: 8,
    window_min: 6,
    sample: 'go test ./...',
    first_ts: '2026-08-20T11:54:00Z',
    last_ts: '2026-08-20T11:59:00Z',
    ts: '2026-08-20T11:54:00Z',
    ...over,
  }
}

describe('findAttention', () => {
  it('says nothing when everything is fine', () => {
    const items = findAttention({ sessions: [session({ session_id: 'a' })], alerts: [], now: NOW })
    expect(items).toEqual([])
  })

  it('reports a loop with the evidence and what it has cost', () => {
    const items = findAttention({
      sessions: [session({ session_id: 's-loop', stats: { cost_usd: 12.4 } as never })],
      alerts: [alert()],
      now: NOW,
    })
    expect(items).toHaveLength(1)
    expect(items[0]!.title).toBe('Stuck in a loop')
    expect(items[0]!.detail).toContain('go test ./...')
    expect(items[0]!.detail).toContain('8×')
    expect(items[0]!.costUSD).toBe(12.4)
  })

  it('does not nag about a session that just asked a question', () => {
    const justAsked = session({
      session_id: 'a',
      activity: { health: 'waiting-on-you', phrase: 'asked you something', at: '2026-08-20T11:58:00Z' } as never,
    })
    expect(findAttention({ sessions: [justAsked], alerts: [], now: NOW })).toEqual([])
  })

  it('surfaces a session that has been waiting a long time', () => {
    const stale = session({
      session_id: 'a',
      activity: { health: 'waiting-on-you', phrase: 'asked you something', at: '2026-08-20T11:30:00Z' } as never,
    })
    const items = findAttention({ sessions: [stale], alerts: [], now: NOW })
    expect(items).toHaveLength(1)
    expect(items[0]!.title).toBe('Waiting on you')
    expect(items[0]!.severity).toBe('medium')
  })

  it('never flags a session merely for being expensive', () => {
    // Spending is the job. Only spending with nothing to show for it is news,
    // so this session has the work to match its bill.
    const pricey = session({ session_id: 'a', stats: { cost_usd: 900, turns: 5000, files_touched: 120 } as never })
    expect(findAttention({ sessions: [pricey], alerts: [], now: NOW })).toEqual([])
  })

  it('ignores ended sessions', () => {
    const ended = session({
      session_id: 'a',
      status: 'ended',
      activity: { health: 'error', phrase: 'it broke', at: '2026-08-20T11:00:00Z' } as never,
    })
    expect(findAttention({ sessions: [ended], alerts: [], now: NOW })).toEqual([])
  })

  it('puts the severe and the oldest first', () => {
    const waiting = session({
      session_id: 'w',
      activity: { health: 'waiting-on-you', phrase: 'asked', at: '2026-08-20T11:00:00Z' } as never,
    })
    const broken = session({
      session_id: 'e',
      activity: { health: 'error', phrase: 'it broke', at: '2026-08-20T11:50:00Z' } as never,
    })
    const items = findAttention({ sessions: [waiting, broken], alerts: [alert()], now: NOW })
    expect(items.map((i) => i.severity)).toEqual(['high', 'high', 'medium'])
    // Within high severity, the loop (11:54) is newer than the error (11:50).
    expect(items[0]!.sessionId).toBe('e')
  })
})

describe('spent with little to show', () => {
  const base = (over: Partial<SessionSummary> & { session_id: string }): SessionSummary => ({
    project: 'p',
    status: 'ended',
    last_event_at: NOW - 60_000,
    activity: { health: 'idle', phrase: 'was responding', at: '2026-08-20T11:59:00Z' },
    stats: { cost_usd: 0, turns: 0, tool_calls: 0, files_touched: 0 },
    ...over,
  } as unknown as SessionSummary)

  it('surfaces a session that burned money and touched almost nothing', () => {
    // The real case: 1,401 turns, 1 file, $78 — previously unreachable, because
    // every other rule skips ended sessions.
    const s = base({ session_id: 'a', stats: { cost_usd: 78.06, turns: 1401, files_touched: 1 } as never })
    const items = findAttention({ sessions: [s], alerts: [], now: NOW })
    expect(items).toHaveLength(1)
    expect(items[0]!.title).toBe('Lots of turns, few files')
    expect(items[0]!.detail).toContain('1 file')
    expect(items[0]!.costUSD).toBe(78.06)
  })

  it('says nothing about a session that spent money and produced work', () => {
    const s = base({ session_id: 'a', stats: { cost_usd: 1497, turns: 12527, files_touched: 400 } as never })
    expect(findAttention({ sessions: [s], alerts: [], now: NOW })).toEqual([])
  })

  it('ignores a cheap session however little it touched', () => {
    const s = base({ session_id: 'a', stats: { cost_usd: 2, turns: 900, files_touched: 0 } as never })
    expect(findAttention({ sessions: [s], alerts: [], now: NOW })).toEqual([])
  })

  it('ignores a short expensive session — that is just a big turn', () => {
    const s = base({ session_id: 'a', stats: { cost_usd: 60, turns: 12, files_touched: 0 } as never })
    expect(findAttention({ sessions: [s], alerts: [], now: NOW })).toEqual([])
  })

  it('does not raise last month as if it were actionable', () => {
    const s = base({
      session_id: 'a',
      last_event_at: NOW - 30 * 24 * 3600 * 1000,
      activity: { health: 'idle', phrase: 'x', at: '2026-07-21T12:00:00Z' } as never,
      stats: { cost_usd: 78, turns: 1401, files_touched: 1 } as never,
    })
    expect(findAttention({ sessions: [s], alerts: [], now: NOW })).toEqual([])
  })
})

/**
 * Running out of plan window stops every session at once, so it is worth an
 * interruption — but only near the end, and only when the numbers can be
 * believed. An alert that fires early, or that can never clear, is one people
 * learn to scroll past.
 */
describe('plan-limit alerts', () => {
  const soon = (h: number) => (NOW + h * 3600 * 1000) / 1000

  it('warns when a window is nearly spent', () => {
    const out = findAttention({
      sessions: [], alerts: [], now: NOW,
      limits: { five_hour: { used_percentage: 92, resets_at: soon(1) } },
    })
    expect(out).toHaveLength(1)
    expect(out[0]?.title).toMatch(/5-hour.*92%/)
    expect(out[0]?.severity).toBe('medium')
  })

  it('is loud once the window is almost gone', () => {
    const out = findAttention({
      sessions: [], alerts: [], now: NOW,
      limits: { seven_day: { used_percentage: 97, resets_at: soon(20) } },
    })
    expect(out[0]?.severity).toBe('high')
  })

  it('stays quiet below the threshold', () => {
    // The Cost screen already colours 85% amber. Firing wherever a colour
    // changes trains people to ignore the banner.
    const out = findAttention({
      sessions: [], alerts: [], now: NOW,
      limits: { five_hour: { used_percentage: 86, resets_at: soon(1) } },
    })
    expect(out).toEqual([])
  })

  it('does not fire on a window whose clock cannot be believed', () => {
    // The 5-hour window once announced a reset in 2030. An alert built on a
    // stale percentage would never clear, so it is not raised at all.
    const stale = findAttention({
      sessions: [], alerts: [], now: NOW,
      limits: { five_hour: { used_percentage: 99, resets_at: Date.parse('2030-01-01') / 1000 } },
    })
    expect(stale).toEqual([])

    const past = findAttention({
      sessions: [], alerts: [], now: NOW,
      limits: { seven_day: { used_percentage: 99, resets_at: (NOW - 60_000) / 1000 } },
    })
    expect(past).toEqual([])
  })

  it('is about the account, not a session', () => {
    // The banner links every item to a session; an account-level item has none,
    // and an empty id produced a dead link labelled with nothing.
    const out = findAttention({
      sessions: [], alerts: [], now: NOW,
      limits: { five_hour: { used_percentage: 95, resets_at: soon(2) } },
    })
    expect(out[0]?.sessionId).toBe('')
  })
})
