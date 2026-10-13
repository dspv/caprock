import { describe, expect, it } from 'vitest'
import type { Event } from './api'
import { MAX_TIME_BARS, barLabel, barLabelShort, bucketCost, bucketOf, bucketize, callAt, callsFromEvents, callsFromSeries, clock, cursorX, mergeCalls, readout, slotsFor, stepText, timeBars, topTools, type CallPoint } from './scrub'

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

describe('callAt', () => {
  it('reads the exact call under the pointer, whatever the bars fold', () => {
    expect(callAt(0, 100, 10)).toBe(0)
    expect(callAt(9.9, 100, 10)).toBe(0)
    expect(callAt(10, 100, 10)).toBe(1)
    expect(callAt(55, 100, 10)).toBe(5)
    // 640 calls across 290 px: one pixel is about two calls, still one exact call.
    expect(callAt(186, 290, 640)).toBe(410)
    expect(callAt(186.5, 290, 640)).toBe(411)
  })
  it('clamps past either end', () => {
    expect(callAt(-20, 100, 10)).toBe(0)
    expect(callAt(100, 100, 10)).toBe(9)
    expect(callAt(500, 100, 10)).toBe(9)
  })
  it('falls back to the newest with no width, and to nothing with no calls', () => {
    expect(callAt(5, 0, 4)).toBe(3)
    expect(callAt(5, 100, 0)).toBe(-1)
  })
})

describe('bucketOf and cursorX', () => {
  it('finds the bar drawing a call', () => {
    const b = bucketize(640, 96)
    for (const i of [0, 6, 7, 411, 639]) {
      const k = bucketOf(b, i)
      expect(b[k]!.from).toBeLessThanOrEqual(i)
      expect(b[k]!.to).toBeGreaterThan(i)
    }
    expect(bucketOf([], 3)).toBe(-1)
  })
  it('puts the cursor at the call\'s own place inside its bar', () => {
    expect(cursorX(0, 10, 100)).toBe(5)
    expect(cursorX(9, 10, 100)).toBe(95)
    const b = bucketize(640, 96)
    const width = 288, slot = width / b.length
    const k = bucketOf(b, 411)
    const x = cursorX(411, 640, width)
    expect(x).toBeGreaterThanOrEqual(k * slot)
    expect(x).toBeLessThan((k + 1) * slot)
    expect(callAt(x, width, 640)).toBe(411)
    expect(bucketCost([pt(1, 0.25), pt(2, 0.5), pt(3, 1)], { from: 1, to: 3 })).toBe(1.5)
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
    const r = readout(calls, 1, now)!
    expect(r.title).toBe('Call 2 of 2')
    expect(r.cost).toBe('$0.08')
    expect(r.when).toBe(`${clock(T0 + 2000)} · ${'2m ago'}`)
    expect(r.model).toBe('Opus 5.5')
    expect(r.tokens).toBe('in 3 · cache read 120.0k · out 420')
    expect(r.did).toBe('Bash go test ./... · Read main.go · +1 more')
  })
  it('leaves out what the data does not say, never a zero', () => {
    const r = readout([pt(1, 0.02)], 0, now)!
    expect(r).toEqual({ title: 'Call 1 of 1', cost: '$0.02', when: expect.any(String) })
  })
  it('names one call even when thousands fold into each bar', () => {
    const calls = Array.from({ length: 3000 }, (_, i) => pt(i + 1, 0.01))
    expect(readout(calls, 1200, now)!.title).toBe('Call 1,201 of 3,000')
    expect(readout(calls, 3000, now)).toBeUndefined()
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

describe('the spend by time', () => {
  const at = (h: number, m = 0) => new Date(2026, 9, 11, h, m).getTime()
  const call = (id: number, ts: number, cost: number, tools: string[] = []): CallPoint => ({ id, ts, cost, tools: tools.map((tool) => ({ tool })) })

  it('draws bars by the clock, an idle stretch as an empty bar', () => {
    const { step, bars } = timeBars([call(1, at(10, 1), 0.5, ['Bash']), call(2, at(10, 2), 0.25, ['Bash', 'Edit']), call(3, at(12, 40), 1)])
    expect(step).toBe(5 * 60_000)
    expect(bars[0]!.start).toBe(at(10))
    expect(bars[0]!.cost).toBeCloseTo(0.75)
    expect(bars[0]!.calls).toBe(2)
    expect(topTools(bars[0]!)).toBe('Bash 2 · Edit 1')
    expect(bars.some((b) => b.calls === 0)).toBe(true)
    expect(bars.at(-1)!.cost).toBe(1)
    expect(bars.length).toBeLessThanOrEqual(MAX_TIME_BARS)
  })

  it('widens the step for a long session and names the stretch', () => {
    const { step, bars } = timeBars([call(1, at(9), 1), call(2, at(9) + 4 * 86_400_000, 2)])
    expect(step).toBe(3 * 3_600_000)
    expect(bars.length).toBeLessThanOrEqual(MAX_TIME_BARS)
    expect(stepText(step)).toBe('3 h')
    expect(barLabel(bars[0]!, step, at(9) + 4 * 86_400_000)).toMatch(/^\w{3} \d+ \w{3} 09:00–12:00$/)
    expect(barLabel(bars.at(-1)!, step, at(9) + 4 * 86_400_000)).toBe('Today 09:00–12:00')
  })

  it('names a stretch short enough to sit beside its figure', () => {
    const H = 3_600_000
    const sun = new Date(2026, 9, 11).getTime() // Sun 11 Oct, local midnight
    const now = sun + 3 * 86_400_000 + 10 * H
    const bar = (from: number, len: number) => ({ start: from, end: from + len })
    // Whole hours drop their minutes; the full label is 22 characters, this one 18.
    expect(barLabelShort(bar(sun + 6 * H, 6 * H), 6 * H, now)).toBe('Sun 11 Oct · 06–12')
    // A stretch that runs to midnight ends at 24, not 00.
    expect(barLabelShort(bar(sun + 18 * H, 6 * H), 6 * H, now)).toBe('Sun 11 Oct · 18–24')
    // Minutes stay when a stretch has them.
    expect(barLabelShort(bar(sun + 14 * H + 10 * 60_000, 10 * 60_000), 10 * 60_000, now)).toBe('Sun 11 Oct · 14:10–14:20')
    // Today and yesterday by name; a day-wide step is the day alone.
    expect(barLabelShort(bar(now - 4 * H, H), H, now)).toBe('Today · 06–07')
    expect(barLabelShort(bar(now - 28 * H, H), H, now)).toBe('Yesterday · 06–07')
    expect(barLabelShort(bar(sun, 86_400_000), 86_400_000, now)).toBe('Sun 11 Oct')
    // Across midnight to another hour: the full label, both days named.
    expect(barLabelShort(bar(sun + 22 * H, 3 * H), 3 * H, now)).toBe(barLabel(bar(sun + 22 * H, 3 * H), 3 * H, now))
  })
})

describe('timeBars for burn rate', () => {
  const H = 3_600_000
  // Local midnight, so bars and hours line up whatever the time zone.
  const day0 = new Date(2026, 9, 12, 0).getTime()
  const at = (id: number, ts: number, cost: number): CallPoint => ({ id, ts, cost })

  it('floors the step at an hour and counts an hour active only with five calls that cost something', () => {
    // Twelve minutes of work: by itself drawn in 5-minute bars, but a rate needs an hour.
    const calls = [0, 2, 4, 6, 8, 10, 12].map((m, i) => at(i, day0 + 9 * H + m * 60_000, 0.5))
    expect(timeBars(calls).step).toBe(5 * 60_000)
    expect(timeBars(calls).bars[0]!.activeHours).toBeUndefined()
    const t = timeBars(calls, 60)
    expect(t.step).toBe(H)
    expect(t.bars).toHaveLength(1)
    expect(t.bars[0]).toMatchObject({ activeHours: 1, activeCost: 3.5 })
  })

  it('leaves an idle hour and a thin hour with no active hour, so they have no rate rather than $0/h', () => {
    const busy = [0, 1, 2, 3, 4].map((m, i) => at(i, day0 + 9 * H + m * 60_000, 1))
    const thin = [at(10, day0 + 11 * H, 2), at(11, day0 + 11 * H + 60_000, 2)]
    const later = [0, 1, 2, 3, 4, 5].map((m, i) => at(20 + i, day0 + 12 * H + m * 60_000, 0.5))
    const t = timeBars([...busy, ...thin, ...later], 60)
    expect(t.step).toBe(H)
    expect(t.bars.map((b) => b.activeHours)).toEqual([1, 0, 0, 1])
    expect(t.bars.map((b) => b.activeCost)).toEqual([5, 0, 0, 3])
    // The thin hour's spend still counts as cost.
    expect(t.bars[2]!.cost).toBe(4)
    // Five free calls are not an active hour either.
    const free = timeBars([0, 1, 2, 3, 4].map((m, i) => at(i, day0 + m * 60_000, 0)), 60)
    expect(free.bars[0]!.activeHours).toBe(0)
  })

  it('counts every active hour inside a longer bar', () => {
    const hour = (h: number, cost: number, base: number) => [0, 1, 2, 3, 4].map((m) => at(base + m, day0 + h * H + m * 60_000, cost))
    // 50 hours of span: 1-hour bars would be too many, so they are 3 hours.
    const t = timeBars([...hour(0, 1, 0), ...hour(1, 2, 10), ...hour(50, 1, 20)], 60)
    expect(t.step).toBe(3 * H)
    expect(t.bars[0]).toMatchObject({ activeHours: 2, activeCost: 15 })
  })
})
