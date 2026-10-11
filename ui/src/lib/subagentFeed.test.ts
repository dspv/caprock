import { describe, expect, it } from 'vitest'
import type { Event, SubagentCall } from './api'
import { followSubagent, needsClamp } from './subagentFeed'

let id = 100
function ev(p: Partial<Event> & { kind: string }): Event {
  return { id: ++id, ts: new Date(Date.UTC(2026, 9, 12, 1, 0, id - 100)).toISOString(), session_id: 's', agent_id: 'a', source: 'hook', payload: {}, ...p } as Event
}

describe('followSubagent', () => {
  const base: SubagentCall[] = [{ id: 1, tool_use_id: 'r1', tool: 'Read', detail: 'x.go', started_at: 0, ended_at: 5 }]
  it('appends a live call with its short line, once across both planes', () => {
    const pre = ev({ kind: 'tool.pre', tool: 'Bash', payload: { tool_use_id: 'b1', tool_input: { command: 'go test ./...\nmore' } } })
    let calls = followSubagent(base, pre, 's', 'a')
    expect(calls.map((c) => [c.tool, c.detail, c.ended_at])).toEqual([['Read', 'x.go', 5], ['Bash', 'go test ./...', undefined]])
    calls = followSubagent(calls, { ...pre, id: pre.id + 50, source: 'transcript' }, 's', 'a')
    expect(calls).toHaveLength(2)
  })
  it('closes a call on its result and marks an error', () => {
    const pre = ev({ kind: 'tool.pre', tool: 'Bash', payload: { tool_use_id: 'b2' } })
    let calls = followSubagent(base, pre, 's', 'a')
    calls = followSubagent(calls, ev({ kind: 'tool.post', payload: { tool_use_id: 'b2', is_error: true } }), 's', 'a')
    expect(calls[1]!.ended_at).toBeGreaterThanOrEqual(calls[1]!.started_at)
    expect(calls[1]!.error).toBe(true)
  })
  it('ignores another agent, the main thread and other kinds', () => {
    expect(followSubagent(base, ev({ kind: 'tool.pre', tool: 'Read', agent_id: 'b', payload: { tool_use_id: 'z' } }), 's', 'a')).toBe(base)
    expect(followSubagent(base, ev({ kind: 'tool.pre', tool: 'Read', agent_id: undefined, payload: { tool_use_id: 'z' } }), 's', 'a')).toBe(base)
    expect(followSubagent(base, ev({ kind: 'turn.assistant' }), 's', 'a')).toBe(base)
  })
})

describe('needsClamp', () => {
  it('folds past six lines or a long paragraph', () => {
    expect(needsClamp('one\ntwo')).toBe(false)
    expect(needsClamp('1\n2\n3\n4\n5\n6\n7')).toBe(true)
    expect(needsClamp('x'.repeat(500))).toBe(true)
  })
})
