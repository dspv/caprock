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
    const pricey = session({ session_id: 'a', stats: { cost_usd: 900 } as never })
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
