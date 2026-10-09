import { describe, expect, it } from 'vitest'
import type { Event } from './api'
import { barAt, bucketCost, bucketize, callsFromEvents, callsFromSeries, clock, mergeCalls, readout, slotsFor, type CallPoint } from './scrub'

const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)
const pt = (id: number, cost: number, p: Partial<CallPoint> = {}): CallPoint => ({ id, ts: T0 + id * 1000, cost, ...p })

describe('bucketize', () => {
  it('draws one bar per call while they fit', () => {
    expect(bucketize(3, 10)).toEqual([{ from: 0, to: 1 }, { from: 1, to: 2 }, { from: 2, to: 3 }])
  })
  it('folds thousands of calls into contiguous runs that cover every call once', () => {
    const b = bucketize(3000, 100)
    expect(b).toHaveLength(100)
    expect(b[0]).toEqual({ from: 0, to: 30 })
    expect(b[99]).toEqual({ from: 2970, to: 3000 })
    for (let i = 1; i < b.length; i++) expect(b[i]!.from).toBe(b[i - 1]!.to)
  })
  it('keeps run sizes within one of each other', () => {
    const sizes = bucketize(10, 4).map((x) => x.to - x.from)
    expect(sizes.reduce((a, s) => a + s, 0)).toBe(10)
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1)
  })
  it('has no bars for no calls', () => {
    expect(bucketize(0, 50)).toEqual([])
  })
  it('fits the slots to the width', () => {
    expect(slotsFor(300)).toBe(100)
    expect(slotsFor(0)).toBe(1)
  })
})

describe('barAt', () => {
  it('reads the bar under the pointer', () => {
    expect(barAt(0, 100, 10)).toBe(0)
    expect(barAt(9.9, 100, 10)).toBe(0)
    expect(barAt(10, 100, 10)).toBe(1)
    expect(barAt(55, 100, 10)).toBe(5)
  })
  it('clamps past either end', () => {
    expect(barAt(-20, 100, 10)).toBe(0)
    expect(barAt(100, 100, 10)).toBe(9)
    expect(barAt(500, 100, 10)).toBe(9)
  })
  it('falls back to the newest with no width, and to nothing with no bars', () => {
    expect(barAt(5, 0, 4)).toBe(3)
    expect(barAt(5, 100, 0)).toBe(-1)
  })
})

describe('readout', () => {
  const now = T0 + 3 * 60_000
  it('states one call: position, time, model, cost, tokens and the tools it asked for', () => {
    const calls = [
      pt(1, 0.01),
      pt(2, 0.08, {
        model: 'Opus 5.5', tokens: { in: 3, out: 420, cache_read: 120_000, cache_write: 0 },
        tools: [{ tool: 'Bash', detail: 'go test ./...' }, { tool: 'Read', detail: 'main.go' }], toolCount: 3,
      }),
    ]
    const r = readout(calls, { from: 1, to: 2 }, now)!
    expect(r.title).toBe('Call 2 of 2')
    expect(r.cost).toBe('$0.08')
    expect(r.when).toBe(`${clock(T0 + 2000)} · ${'2m ago'}`)
    expect(r.model).toBe('Opus 5.5')
    expect(r.tokens).toBe('in 3 · cache read 120.0k · out 420')
    expect(r.did).toBe('Bash go test ./... · Read main.go · +1 more')
  })
  it('leaves out what the data does not say, never a zero', () => {
    const r = readout([pt(1, 0.02)], { from: 0, to: 1 }, now)!
    expect(r).toEqual({ title: 'Call 1 of 1', cost: '$0.02', when: expect.any(String) })
  })
  it('states a run as a range with its sum, labelled a total', () => {
    const calls = [pt(1, 0.25, { model: 'Opus 5.5' }), pt(2, 0.5, { model: 'Opus 5.5' }), pt(3, 1, { model: 'Sonnet 5' })]
    const r = readout(calls, { from: 0, to: 3 }, now)!
    expect(r.title).toBe('Calls 1–3 of 3')
    expect(r.cost).toBe('$1.75 total')
    expect(r.model).toBe('2 models')
    expect(r.tokens).toBeUndefined()
    expect(r.did).toBeUndefined()
    expect(bucketCost(calls, { from: 1, to: 3 })).toBe(1.5)
  })
  it('sums a run\'s tokens only when every call reports them', () => {
    const t = { in: 1, out: 2, cache_read: 3, cache_write: 4 }
    expect(readout([pt(1, 1, { tokens: t }), pt(2, 1, { tokens: t })], { from: 0, to: 2 }, now)!.tokens)
      .toBe('in 2 · cache read 6 · cache write 8 · out 4')
    expect(readout([pt(1, 1, { tokens: t }), pt(2, 1)], { from: 0, to: 2 }, now)!.tokens).toBeUndefined()
  })
  it('formats large positions with separators', () => {
    const calls = Array.from({ length: 3000 }, (_, i) => pt(i + 1, 0.01))
    expect(readout(calls, { from: 1200, to: 1240 }, now)!.title).toBe('Calls 1,201–1,240 of 3,000')
  })
})

describe('series', () => {
  it('reads the daemon\'s calls, preferring the short model name', () => {
    const [c] = callsFromSeries([{ id: 7, ts: T0, model: 'claude-opus-5-5', model_display: 'Opus 5.5', cost_usd: 0.1, tools: [{ tool: 'Bash', detail: 'ls' }], tool_count: 1 }])
    expect(c).toEqual({ id: 7, ts: T0, cost: 0.1, model: 'Opus 5.5', tokens: undefined, tools: [{ tool: 'Bash', detail: 'ls' }], toolCount: 1 })
  })
  it('joins held turns to their tool calls by message id and skips unpriced and subagent turns', () => {
    const ts = new Date(T0).toISOString()
    const ev = (p: Partial<Event>): Event => ({ id: 0, ts, session_id: 's', source: 'transcript', kind: '', payload: {}, ...p })
    const calls = callsFromEvents([
      ev({ id: 1, kind: 'turn.assistant', cost_usd: 0.3, model: 'claude-opus-5', payload: { message_id: 'm1' } }),
      ev({ id: 2, kind: 'tool.pre', tool: 'Bash', payload: { message_id: 'm1', tool_input: { command: 'go test ./...' } } }),
      ev({ id: 3, kind: 'turn.assistant', payload: { message_id: 'm2' } }),
      ev({ id: 4, kind: 'turn.assistant', cost_usd: 1, agent_id: 'sub', payload: { message_id: 'm3' } }),
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.tools).toEqual([{ tool: 'Bash', detail: 'go test ./...' }])
  })
  it('adds the calls made since the series was read, once', () => {
    const merged = mergeCalls([pt(1, 1), pt(2, 2)], [pt(2, 9), pt(3, 3)])
    expect(merged.map((c) => [c.id, c.cost])).toEqual([[1, 1], [2, 2], [3, 3]])
  })
})
