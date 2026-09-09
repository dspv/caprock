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
    expect(items[0]!.title).toBe('Waiting for you')
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

describe('the removed "lots of turns, few files" rule', () => {
  const base = (over: Partial<SessionSummary> & { session_id: string }): SessionSummary => ({
    project: 'p',
    status: 'ended',
    last_event_at: NOW - 60_000,
    activity: { health: 'idle', phrase: 'was responding', at: '2026-08-20T11:59:00Z' },
    stats: { cost_usd: 0, turns: 0, tool_calls: 0, files_touched: 0 },
    ...over,
  } as unknown as SessionSummary)

  // These are the three sessions the rule ever fired on, on a real machine.
  // Every one was a false positive: they made 636, 418 and 288 Bash calls, and
  // `files_touched` counts only Edit/Write/MultiEdit/NotebookEdit — so the work
  // was real and simply invisible to the counter. The third shipped three
  // releases while the banner said "no files touched".
  it.each([
    ['0 files, $48, 357 turns — shipped three releases', { cost_usd: 48.58, turns: 357, files_touched: 0 }],
    ['1 file, $78, 1401 turns', { cost_usd: 78.06, turns: 1401, files_touched: 1 }],
    ['1 file, $56, 731 turns', { cost_usd: 56.42, turns: 731, files_touched: 1 }],
  ])('says nothing about %s', (_label, stats) => {
    const s = base({ session_id: 'a', stats: stats as never })
    expect(findAttention({ sessions: [s], alerts: [], now: NOW })).toEqual([])
  })

  it('says nothing however extreme the shape gets', () => {
    // No threshold to tune: the counter cannot see Bash edits at any cost or
    // turn count, so there is no version of this rule that is not guessing.
    const s = base({ session_id: 'a', stats: { cost_usd: 5000, turns: 20000, files_touched: 0 } as never })
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

/**
 * The spend cap can only pause sessions Caprock started (rule 7), so whether
 * it could have acted has to reach the banner. Measured on the owner's
 * database: 122 of the 127 sessions that did real work were started by hand —
 * so without this the "a cap that stops this" button sat beside a loop no cap
 * would have touched, nearly every time it appeared.
 */
describe('whether a cap could have acted', () => {
  it('carries session ownership onto the loop item', () => {
    const owned = findAttention({
      sessions: [session({ session_id: 's-loop', owned: true })], alerts: [alert()], now: NOW,
    })
    expect(owned.find((i) => i.id.startsWith('loop-'))?.owned).toBe(true)

    const theirs = findAttention({
      sessions: [session({ session_id: 's-loop', owned: false })], alerts: [alert()], now: NOW,
    })
    expect(theirs.find((i) => i.id.startsWith('loop-'))?.owned).toBe(false)
  })
})

// The waiting row says it once. It read "Waiting on you · caprock · waiting for
// you" — the same sentence twice, in two prepositions, the repeat in grey as
// though it were evidence. The other rows carry the activity phrase because
// theirs adds something (an error names what broke); this one's phrase is the
// fixed string the title already is.
describe('the waiting row', () => {
  it('does not repeat itself', () => {
    const s = {
      session_id: 'w', project: 'caprock', status: 'idle',
      last_event_at: NOW - 20 * 60_000,
      activity: { health: 'waiting-on-you', phrase: 'waiting for you', at: '2026-08-20T11:40:00Z' },
    } as unknown as SessionSummary
    const [item] = findAttention({ sessions: [s], alerts: [], now: NOW })
    expect(item!.title).toBe('Waiting for you')
    expect(item!.detail).toBe('')
    // Whatever the phrase says, it must not be echoed under a title that
    // already says it.
    expect(item!.detail.toLowerCase()).not.toContain('waiting')
  })
})

/**
 * The context tax is the one figure on this banner attributable to the loop's
 * own calls. It goes in the evidence, beside "ran it 8x", and it is never
 * allowed to read as the price of the loop — the money column still carries
 * the session total, and the two must stay distinguishable.
 */
describe('loop context tax', () => {
  it('states what the repeated calls paid to re-read the conversation', () => {
    const items = findAttention({
      sessions: [session({ session_id: 's-loop' })],
      alerts: [alert({ tax_usd: 2.34 })],
      now: NOW,
    })
    expect(items[0]!.detail).toContain('$2.34 in context')
    // Never phrased as what the loop cost: that number cannot be computed
    // honestly and printing it here was wrong twice before.
    expect(items[0]!.detail).not.toMatch(/cost/i)
  })

  it('omits the figure when the calls could not be priced', () => {
    const items = findAttention({
      sessions: [session({ session_id: 's-loop' })],
      alerts: [alert()],
      now: NOW,
    })
    expect(items[0]!.detail).not.toContain('$')
    expect(items[0]!.detail).toContain('ran go test ./...')
  })

  it('omits a rounding-error tax rather than printing $0.00', () => {
    const items = findAttention({
      sessions: [session({ session_id: 's-loop' })],
      alerts: [alert({ tax_usd: 0.0004 })],
      now: NOW,
    })
    expect(items[0]!.detail).not.toContain('$')
  })

  it('says the tax is a floor when some calls could not be priced', () => {
    const items = findAttention({
      sessions: [session({ session_id: 's-loop' })],
      alerts: [alert({ count: 12, tax_usd: 2.34, tax_priced_calls: 8 })],
      now: NOW,
    })
    expect(items[0]!.detail).toContain('at least $2.34 in context')
  })

  it('states the tax flat when every call was priced', () => {
    const items = findAttention({
      sessions: [session({ session_id: 's-loop' })],
      alerts: [alert({ count: 8, tax_usd: 2.34, tax_priced_calls: 8 })],
      now: NOW,
    })
    expect(items[0]!.detail).toContain('$2.34 in context')
    expect(items[0]!.detail).not.toContain('at least')
  })

  it('keeps the session total in the money column, apart from the tax', () => {
    const items = findAttention({
      sessions: [session({ session_id: 's-loop', stats: { cost_usd: 58.85, turns: 9, tool_calls: 40, files_touched: 3 } as never })],
      alerts: [alert({ tax_usd: 2.34 })],
      now: NOW,
    })
    expect(items[0]!.costUSD).toBe(58.85)
    expect(items[0]!.detail).toContain('$2.34')
  })
})
