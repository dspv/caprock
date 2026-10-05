import { describe, expect, it } from 'vitest'
import type { Event } from './api'
import { compareEvents, mergeEvents, toMessages, toolLine } from './chat'

const BASE = Date.UTC(2026, 9, 5, 12, 0, 0)

function ev(id: number, over: Partial<Event> = {}): Event {
  return {
    id,
    ts: new Date(BASE + id * 1000).toISOString(),
    session_id: 's',
    source: 'hook',
    kind: 'turn.user',
    payload: { prompt: `message ${id}` },
    ...over,
  }
}

/** A deterministic shuffle, so a failure reproduces. */
function shuffle<T>(xs: T[], seed = 7): T[] {
  const out = xs.slice()
  let s = seed
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2 ** 31
    const j = s % (i + 1)
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

describe('mergeEvents', () => {
  it('50 events out of order and 10 duplicates, one at a time: server order, each once', () => {
    const server = Array.from({ length: 50 }, (_, i) => ev(i + 1))
    const delivery = shuffle([...server, ...shuffle(server, 3).slice(0, 10)])
    let held: readonly Event[] = []
    for (const e of delivery) held = mergeEvents(held, [e])
    expect(held.map((e) => e.id)).toEqual(server.map((e) => e.id))
    expect(toMessages(held).map((m) => m.text)).toEqual(server.map((e) => `message ${e.id}`))
  })

  it('orders by time, then id — a backfilled event with a new id lands where its time puts it', () => {
    const late = ev(99, { ts: new Date(BASE + 2500).toISOString() })
    const held = mergeEvents([ev(1), ev(2), ev(3), ev(4)], [late])
    expect(held.map((e) => e.id)).toEqual([1, 2, 99, 3, 4])
  })

  it('a replayed page changes nothing, and returns the same array', () => {
    const held = mergeEvents([], [ev(1), ev(2)])
    expect(mergeEvents(held, [ev(2), ev(1)])).toBe(held)
  })

  it('breaks a tie on time by id, as the daemon does', () => {
    const ts = new Date(BASE).toISOString()
    expect(compareEvents({ ts, id: 5 }, { ts, id: 4 })).toBeGreaterThan(0)
  })
})

describe('toMessages', () => {
  it('a tool call is one line, with its result joined to it; subagent steps and empty turns are left out', () => {
    const events: Event[] = [
      ev(1, { payload: { prompt: 'Γειά σου — 日本語のテスト 🚀' } }),
      ev(2, { kind: 'turn.assistant', payload: { text: '', tools: ['Bash'] } }),
      ev(3, { kind: 'tool.pre', tool: 'Bash', payload: { tool_use_id: 'u1', tool_input: { command: 'go test ./...\nsecond line' } } }),
      ev(4, { kind: 'tool.post', payload: { tool_use_id: 'u1', tool_response: 'ok', is_error: false } }),
      ev(5, { kind: 'tool.pre', tool: 'Read', agent_id: 'sub-1', payload: { tool_use_id: 'u2', tool_input: { file_path: '/x' } } }),
      ev(6, { kind: 'turn.assistant', payload: { text: 'Done.' } }),
      ev(7, { kind: 'tool.pre', tool: 'Edit', payload: { tool_use_id: 'u3', tool_input: { file_path: '/a.go' } } }),
    ]
    const msgs = toMessages(events)
    expect(msgs.map((m) => [m.id, m.kind])).toEqual([[1, 'user'], [3, 'tool'], [6, 'assistant'], [7, 'tool']])
    expect(msgs[0]!.text).toBe('Γειά σου — 日本語のテスト 🚀')
    expect(msgs[1]!.text).toBe('Bash  go test ./...')
    expect(msgs[1]!.result).toBe('ok')
    expect(msgs[3]!.result).toBeUndefined()
  })

  it('a failed tool call says so', () => {
    const msgs = toMessages([
      ev(1, { kind: 'tool.pre', tool: 'Bash', payload: { tool_use_id: 'u', tool_input: { command: 'false' } } }),
      ev(2, { kind: 'tool.post', payload: { tool_use_id: 'u', tool_response: 'exit 1', is_error: true } }),
    ])
    expect(msgs[0]!.failed).toBe(true)
  })

  it('toolLine names the tool when there is no argument', () => {
    expect(toolLine('TodoWrite', { todos: [] })).toBe('TodoWrite')
  })
})
