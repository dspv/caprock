/**
 * The dashboard renders whatever the daemon and Claude Code hand it, and a tool
 * call is arbitrary JSON — an MCP server can name a tool `Read` and give
 * `file_path` any shape it likes. These pin the cases where a wrong-typed or
 * absent field used to throw, freeze the live stream, or print garbage.
 *
 * The Go narrator already does this job defensively with a typed struct; these
 * are the TypeScript half of the same contract.
 */
import { describe, expect, it } from 'vitest'
import { pushItem, toFeedItem, type FeedItem } from './feed'
import { findAttention } from './attention'
import { fmtDuration, fmtPct, fmtTokens, fmtUSD } from './format'
import type { Event, LoopAlert, SessionSummary } from './api'

function ev(payload: unknown, kind = 'tool.pre'): Event {
  return { id: 1, ts: '2026-08-20T10:00:00Z', session_id: 's', source: 'hook', kind, payload } as Event
}

describe('feed survives wrong-typed tool arguments', () => {
  // Each of these threw before, and the throw escaped into ws.onmessage —
  // outside React, where no ErrorBoundary can catch it — starving every later
  // subscriber and freezing the dashboard on stale numbers.
  const hostile: [string, unknown][] = [
    ['array file_path', { tool_name: 'Read', tool_input: { file_path: ['/a', '/b'] } }],
    ['object file_path', { tool_name: 'Write', tool_input: { file_path: { path: '/a' } } }],
    ['array command', { tool_name: 'Bash', tool_input: { command: ['ls', '-la'] } }],
    ['numeric command', { tool_name: 'Bash', tool_input: { command: 42 } }],
    ['numeric pattern', { tool_name: 'Grep', tool_input: { pattern: 42 } }],
    ['object url', { tool_name: 'WebFetch', tool_input: { url: { href: 'x' } } }],
    ['null tool_input', { tool_name: 'Read', tool_input: null }],
    ['numeric tool_name', { tool_name: 42, tool_input: {} }],
    ['payload is a string', 'not an object'],
    ['payload is null', null],
  ]
  for (const [name, payload] of hostile) {
    it(`does not throw on ${name}`, () => {
      expect(() => toFeedItem(ev(payload))).not.toThrow()
    })
  }

  it('drops a row it cannot describe rather than inventing one', () => {
    const item = toFeedItem(ev({ tool_name: 'Read', tool_input: { file_path: ['/a'] } }))
    // A non-string path yields no usable detail, so there is nothing to say.
    expect(item).toBeNull()
  })

  it('never splits an emoji in a preview', () => {
    const cmd = 'echo ' + '👨‍👩‍👧‍👦'.repeat(20)
    const item = toFeedItem(ev({ tool_name: 'Bash', tool_input: { command: cmd } }))
    expect(item!.detail).not.toMatch(/[\uD800-\uDFFF]$/)
  })
})

describe('pushItem keeps React keys unique', () => {
  const item = (id: string): FeedItem => ({ id, ts: 1, sessionId: 's', icon: '·', text: 't', tone: 'normal' })
  it('ignores an id already in the window, not only at the head', () => {
    let items = pushItem([], item('a'))
    items = pushItem(items, item('b'))
    items = pushItem(items, item('a')) // replayed out of order
    expect(items.map((i) => i.id)).toEqual(['b', 'a'])
  })
})

describe('attention survives a partial session', () => {
  const base = { session_id: 'x', project: 'p', status: 'active', last_event_at: 0 }
  it('does not throw when stats or activity are absent', () => {
    const sessions = [
      { ...base } as unknown as SessionSummary,
      { ...base, activity: { health: 'error', phrase: 'broke', at: '' } } as unknown as SessionSummary,
    ]
    expect(() => findAttention({ sessions, alerts: [], now: Date.now() })).not.toThrow()
  })

  it('does not throw on absent collections', () => {
    const bad = { sessions: undefined, alerts: undefined, now: Date.now() } as never
    expect(() => findAttention(bad)).not.toThrow()
  })

  it('never prints a literal "undefined" in the loudest banner on the product', () => {
    const alert = { kind: 'loop', session_id: 'x', tool: 'Bash', sample: 'go test' } as unknown as LoopAlert
    const [item] = findAttention({ sessions: [], alerts: [alert], now: Date.now() })
    expect(item!.detail).not.toContain('undefined')
  })
})

describe('formatters never render garbage', () => {
  it('falls back to an em dash rather than NaN or Infinity', () => {
    for (const bad of [NaN, Infinity, -Infinity, undefined, null, 'abc' as never]) {
      expect(fmtUSD(bad)).toBe('—')
      expect(fmtTokens(bad)).toBe('—')
      expect(fmtPct(bad)).toBe('—')
      expect(fmtDuration(bad as number)).toBe('—')
    }
  })

  it('fmtDuration no longer prints "NaNh NaNm" for an empty range', () => {
    // avg_session_sec is a 0/0 on the Go side when a range holds no sessions.
    expect(fmtDuration(Number.NaN)).toBe('—')
    expect(fmtDuration(0)).toBe('0ms')
  })

  it('fmtPct clamps a digits argument instead of throwing', () => {
    expect(() => fmtPct(5, 200)).not.toThrow()
    expect(() => fmtPct(5, -1)).not.toThrow()
  })

  it('still formats real values', () => {
    expect(fmtUSD(12.5)).toBe('$12.50')
    expect(fmtTokens(1_500_000)).toBe('1.50M')
    expect(fmtPct(23.456, 1)).toBe('23.5%')
  })
})
