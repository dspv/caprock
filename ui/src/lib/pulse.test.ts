/**
 * The pulse model. What matters here is that a bar means exactly what the
 * legend says it means, and that the repeat count cannot be inflated by calls
 * that carry no intent — the mockup's first version reported every session as
 * looping and was worthless because of it.
 */
import { describe, expect, it } from 'vitest'
import { buildPulse, signature, trackState, PULSE_MINUTES, REPEAT_FLOOR } from './pulse'
import type { Event } from './api'

const NOW = Date.parse('2026-08-21T12:00:00Z')

function ev(over: Partial<Event> & { kind: string }, minutesAgo = 0): Event {
  return {
    id: Math.random(),
    ts: new Date(NOW - minutesAgo * 60_000).toISOString(),
    session_id: 's',
    source: 'hook',
    payload: {},
    ...over,
  } as Event
}

describe('buildPulse', () => {
  it('puts an event in the minute it happened', () => {
    const p = buildPulse([ev({ kind: 'turn.assistant' }, 5)], NOW, 60)
    const filled = p.bars.map((b, i) => (b.n > 0 ? i : -1)).filter((i) => i >= 0)
    expect(filled).toHaveLength(1)
    // 5 minutes ago in a 60-minute window ending now: bucket 55 of 0..59.
    expect(filled[0]).toBe(55)
  })

  it('separates model turns from tool calls, because they are drawn differently', () => {
    const p = buildPulse(
      [ev({ kind: 'turn.assistant' }, 1), ev({ kind: 'tool.pre' }, 1), ev({ kind: 'tool.post' }, 1)],
      NOW,
      60,
    )
    const bar = p.bars.find((b) => b.n > 0)!
    expect(bar.n).toBe(3)
    expect(bar.turns).toBe(1)
    expect(bar.tools).toBe(2)
  })

  it('ignores events older than the window rather than piling them into the first bar', () => {
    // Clamping instead of dropping would draw a spike that never happened.
    const p = buildPulse([ev({ kind: 'turn.assistant' }, 500)], NOW, 60)
    expect(p.bars.every((b) => b.n === 0)).toBe(true)
  })

  it('survives an event with an unparseable timestamp', () => {
    const bad = { ...ev({ kind: 'turn.assistant' }), ts: 'not a date' } as Event
    expect(() => buildPulse([bad], NOW, 60)).not.toThrow()
  })

  it('is not confused by events arriving out of order', () => {
    // A live frame routinely lands before the backfill that precedes it.
    const events = [ev({ kind: 'turn.assistant' }, 1), ev({ kind: 'turn.assistant' }, 30)]
    const forwards = buildPulse(events, NOW, 60)
    const backwards = buildPulse([...events].reverse(), NOW, 60)
    expect(backwards.bars).toEqual(forwards.bars)
  })

  it('returns a full window of bars even with no events at all', () => {
    const p = buildPulse([], NOW)
    expect(p.bars).toHaveLength(PULSE_MINUTES)
    expect(p.repeats).toBe(0)
  })
})

describe('repeat counting', () => {
  function toolCall(command: string, minutesAgo: number): Event {
    return ev({ kind: 'tool.pre', tool: 'Bash', payload: { tool_input: { command } } as never }, minutesAgo)
  }

  it('counts the same call with the same arguments', () => {
    const events = Array.from({ length: 12 }, (_, i) => toolCall('go test ./...', 5 - i * 0.2))
    const p = buildPulse(events, NOW, 60)
    expect(p.repeats).toBe(12)
    expect(p.repeatSample).toContain('go test')
  })

  it('does not count different calls as repeats', () => {
    const events = Array.from({ length: 12 }, (_, i) => toolCall(`echo run-${i}`, 5 - i * 0.2))
    expect(buildPulse(events, NOW, 60).repeats).toBe(1)
  })

  it('ignores placeholder commands entirely', () => {
    // An agent calls `Bash true` as a no-op hundreds of times — 665 of 31,490
    // Bash calls on the author's machine. Counting those reported every
    // session as looping, which is how the first mockup was useless.
    const events = Array.from({ length: 40 }, (_, i) => toolCall('true', 5 - i * 0.1))
    expect(buildPulse(events, NOW, 60).repeats).toBe(0)
  })

  it('forgets repeats that fall outside the six-minute window', () => {
    // Ten identical calls spread over an hour is not the same as ten in a row.
    const spread = Array.from({ length: 10 }, (_, i) => toolCall('go build ./...', 55 - i * 6))
    expect(buildPulse(spread, NOW, 60).repeats).toBeLessThan(REPEAT_FLOOR)
  })

  it('does not count model turns as repeats', () => {
    const turns = Array.from({ length: 20 }, (_, i) => ev({ kind: 'turn.assistant' }, 5 - i * 0.2))
    expect(buildPulse(turns, NOW, 60).repeats).toBe(0)
  })
})

describe('signature', () => {
  it('ignores fields that carry no intent', () => {
    const a = signature(ev({ kind: 'tool.pre', tool: 'Bash', payload: { tool_input: { command: 'ls', description: 'one' } } as never }))
    const b = signature(ev({ kind: 'tool.pre', tool: 'Bash', payload: { tool_input: { command: 'ls', description: 'another' } } as never }))
    expect(a!.sig).toBe(b!.sig)
  })

  it('returns null for anything that is not a tool call', () => {
    expect(signature(ev({ kind: 'turn.assistant' }))).toBeNull()
    expect(signature(ev({ kind: 'tool.pre' }))).toBeNull() // no tool name
  })

  it('does not throw on a hostile payload', () => {
    for (const payload of [null, 'text', 42, [], { tool_input: 'not an object' }, { tool_input: { a: [1, { b: 2 }] } }]) {
      expect(() => signature(ev({ kind: 'tool.pre', tool: 'Bash', payload: payload as never }))).not.toThrow()
    }
  })
})

describe('trackState', () => {
  it('reports a repeat count as a count, never as a verdict', () => {
    // Polling a file with repeated Reads is legitimate and looks identical to
    // being stuck; only the person working knows which it was.
    const s = trackState({ bars: [{ n: 1, turns: 0, tools: 1 }], repeats: 48, repeatSample: 'Read /tmp/x' })
    expect(s.kind).toBe('repeat')
    expect(s.label).toBe('×48 same call')
    expect(s.label.toLowerCase()).not.toContain('stuck')
    expect(s.label.toLowerCase()).not.toContain('loop')
  })

  it('says quiet when nothing happened', () => {
    expect(trackState({ bars: [{ n: 0, turns: 0, tools: 0 }], repeats: 0, repeatSample: '' }).kind).toBe('quiet')
  })

  it('says working for ordinary activity', () => {
    expect(trackState({ bars: [{ n: 5, turns: 2, tools: 3 }], repeats: 3, repeatSample: '' }).kind).toBe('working')
  })
})
