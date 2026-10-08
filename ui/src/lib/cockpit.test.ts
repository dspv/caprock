import { describe, expect, it } from 'vitest'
import type { Event, SessionSummary, Summary } from './api'
import {
  askLine, cockpitState, commandGist, fmtRun, planWindowsFor, requester, runShare, runningTool, subagentWaiting, toolDetail, toolKind, toolRuns, turnCosts,
  RUNNING_STALE_MS,
} from './cockpit'

let id = 0
function ev(p: Partial<Event> & { kind: string; ts: string }): Event {
  return { id: ++id, session_id: 's', source: 'hook', payload: {}, ...p } as Event
}
const T = (s: number) => new Date(Date.UTC(2026, 9, 8, 12, 0, s)).toISOString()

describe('toolRuns', () => {
  it('joins each call to its result by tool_use_id and times it', () => {
    const runs = toolRuns([
      ev({ kind: 'tool.pre', ts: T(0), tool: 'Bash', payload: { tool_use_id: 'a', tool_input: { command: 'go test ./...\nmore' } } }),
      ev({ kind: 'tool.pre', ts: T(1), tool: 'Edit', payload: { tool_use_id: 'b', tool_input: { file_path: '/w/internal/session.go' } } }),
      ev({ kind: 'tool.post', ts: T(2), tool: 'Edit', payload: { tool_use_id: 'b' } }),
      ev({ kind: 'tool.post', ts: T(40), tool: 'Bash', payload: { tool_use_id: 'a', is_error: true } }),
    ])
    expect(runs.map((r) => [r.tool, r.kind, r.detail, (r.endMs ?? 0) - r.startMs, r.failed])).toEqual([
      ['Bash', 'run', 'go test ./...', 40_000, true],
      ['Edit', 'edit', 'session.go', 1000, false],
    ])
  })

  it('keeps a call seen on both planes once, and leaves a call with no result open', () => {
    const runs = toolRuns([
      ev({ kind: 'tool.pre', ts: T(0), tool: 'Read', payload: { tool_use_id: 'r' } }),
      ev({ kind: 'tool.pre', ts: T(0), tool: 'Read', source: 'transcript', payload: { tool_use_id: 'r' } }),
      ev({ kind: 'tool.pre', ts: T(3), tool: 'Grep', payload: { tool_use_id: 'g', tool_input: { pattern: 'func New' } } }),
    ])
    expect(runs).toHaveLength(2)
    expect(runs[1]!.endMs).toBeUndefined()
    expect(runs[1]!.detail).toBe('func New')
  })

  it('matches a result without an id to the oldest open call of its tool', () => {
    const runs = toolRuns([
      ev({ kind: 'tool.pre', ts: T(0), tool: 'Bash' }),
      ev({ kind: 'tool.pre', ts: T(1), tool: 'Bash' }),
      ev({ kind: 'tool.post', ts: T(5), tool: 'Bash' }),
    ])
    expect(runs[0]!.endMs! - runs[0]!.startMs).toBe(5000)
    expect(runs[1]!.endMs).toBeUndefined()
  })

  it('leaves out a subagent’s own steps', () => {
    expect(toolRuns([
      ev({ kind: 'tool.pre', ts: T(0), tool: 'Read', agent_id: 'sub-1' }),
      ev({ kind: 'tool.pre', ts: T(0), tool: 'Read', payload: { sidechain: true } }),
    ])).toEqual([])
  })
})

describe('runningTool', () => {
  const now = Date.parse(T(30))
  it('is the newest call while it has no result', () => {
    const runs = toolRuns([ev({ kind: 'tool.pre', ts: T(20), tool: 'Bash' })])
    expect(runningTool(runs, now)?.tool).toBe('Bash')
  })
  it('is nothing once the newest call answered, or when it is too old to be running', () => {
    const done = toolRuns([
      ev({ kind: 'tool.pre', ts: T(0), tool: 'Bash', payload: { tool_use_id: 'x' } }),
      ev({ kind: 'tool.post', ts: T(1), tool: 'Bash', payload: { tool_use_id: 'x' } }),
    ])
    expect(runningTool(done, now)).toBeUndefined()
    const old = toolRuns([ev({ kind: 'tool.pre', ts: T(0), tool: 'Bash' })])
    expect(runningTool(old, Date.parse(T(0)) + RUNNING_STALE_MS + 1)).toBeUndefined()
  })
})

describe('turnCosts', () => {
  it('reads only priced assistant turns, each once', () => {
    const a = ev({ kind: 'turn.assistant', ts: T(0), cost_usd: 0.12 })
    const out = turnCosts([
      a, a,
      ev({ kind: 'turn.assistant', ts: T(1) }),
      ev({ kind: 'turn.user', ts: T(2), cost_usd: 1 }),
      ev({ kind: 'turn.assistant', ts: T(3), cost_usd: 0 }),
    ])
    expect(out.map((t) => t.cost)).toEqual([0.12, 0])
  })

  it('leaves out a subagent’s turns: the spark is the session’s own calls', () => {
    const out = turnCosts([
      ev({ kind: 'turn.assistant', ts: T(0), cost_usd: 0.5 }),
      ev({ kind: 'turn.assistant', ts: T(1), cost_usd: 0.01, agent_id: 'sub' }),
      ev({ kind: 'turn.assistant', ts: T(2), cost_usd: 0.02, payload: { sidechain: true } }),
    ])
    expect(out.map((t) => t.cost)).toEqual([0.5])
  })
})

describe('subagentWaiting', () => {
  const p = { id: 'p', tool: 'Bash', detail: 'ls', since: '', agent_id: 'b' }
  it('is its own newest event, or a prompt it asked among those outstanding', () => {
    expect(subagentWaiting({ agent_id: 'a', asking: true })).toBe(true)
    expect(subagentWaiting({ agent_id: 'b', asking: false }, p)).toBe(true)
    expect(subagentWaiting({ agent_id: 'a', asking: false }, p)).toBe(false)
    expect(subagentWaiting({ agent_id: 'c', asking: false }, { ...p, waiting: [p, { ...p, id: 'q', agent_id: 'c' }] })).toBe(true)
    expect(subagentWaiting({ agent_id: 'a', asking: false }, null)).toBe(false)
  })
})

describe('who asks', () => {
  it('names a subagent by its type, and the agent for the main thread', () => {
    expect(askLine({ tool: 'Bash', agent_id: 'a', agent_type: 'general-purpose' })).toBe('Subagent (general-purpose) wants to run Bash')
    expect(askLine({ tool: 'Write', agent_id: 'a' })).toBe('Subagent wants to use Write')
    expect(askLine({ tool: 'Bash' })).toBe('Claude wants to run Bash')
    expect(requester({ agent_id: 'a', agent_type: 'subagent' })).toBe('Subagent')
  })
})

describe('commandGist', () => {
  it('skips the set-up a command starts with', () => {
    expect(commandGist('C=/private/tmp/caps3; rm -f $C/*; ls')).toEqual({ gist: 'rm -f $C/*', more: true })
    expect(commandGist('cd ~/dev/web && export X=1 && npm run build')).toEqual({ gist: 'npm run build', more: true })
    expect(commandGist('go test ./...')).toEqual({ gist: 'go test ./...', more: false })
    expect(commandGist('A=1')).toEqual({ gist: 'A=1', more: false })
    expect(commandGist('').gist).toBe('')
  })
  it('clips a long first step and says so', () => {
    const g = commandGist('x'.repeat(300), 50)
    expect([...g.gist]).toHaveLength(50)
    expect(g.more).toBe(true)
  })
})

describe('cockpitState', () => {
  const s = (health: string, status = 'active') => ({ status, activity: { phrase: '', at: '', health } }) as unknown as SessionSummary
  it('puts an ended process and a pending prompt ahead of the narrated health', () => {
    expect(cockpitState(s('working'), true)).toBe('waiting')
    expect(cockpitState(s('working', 'ended'), true)).toBe('ended')
    expect(cockpitState(s('working'), false)).toBe('working')
    expect(cockpitState(s('error'), false)).toBe('looping')
    expect(cockpitState(s('idle'), false)).toBe('idle')
  })
})

describe('planWindowsFor', () => {
  const w = { used_percentage: 41, resets_at: 1 }
  const summary = { rate_limits: { five_hour: w }, codex_rate_limits: { seven_day: w } } as unknown as Summary
  it('gives each agent its own windows and the rest none — never an invented zero', () => {
    expect(planWindowsFor(undefined, summary)?.five_hour).toBe(w)
    expect(planWindowsFor('claude', summary)?.five_hour).toBe(w)
    expect(planWindowsFor('codex', summary)?.seven_day).toBe(w)
    expect(planWindowsFor('opencode', summary)).toBeUndefined()
    expect(planWindowsFor('claude', { rate_limits: {} } as unknown as Summary)).toBeUndefined()
    expect(planWindowsFor('claude', undefined)).toBeUndefined()
  })
})

describe('formatting', () => {
  it('names a duration in a column’s width', () => {
    expect(fmtRun(340)).toBe('0.3s')
    expect(fmtRun(1234)).toBe('1.2s')
    expect(fmtRun(38_000)).toBe('38s')
    expect(fmtRun(124_000)).toBe('2m 04s')
  })
  it('scales a bar so short calls still show and the longest fills it', () => {
    expect(runShare(40_000, 40_000)).toBe(1)
    expect(runShare(300, 40_000)).toBeGreaterThan(0.04)
    expect(runShare(0, 40_000)).toBe(0)
  })
  it('classifies the agents’ tools and reads their arguments', () => {
    expect(toolKind('exec_command')).toBe('run')
    expect(toolKind('mcp__github__get_pr')).toBe('mcp')
    expect(toolDetail('exec', { command: ['bash', '-lc', 'ls'] })).toBe('bash -lc ls')
    expect(toolDetail('mcp__github__get_pr', {})).toBe('github·get_pr')
    expect(toolDetail('Grep', { pattern: 'func New', path: '/w/acme' })).toBe('func New')
    expect(toolDetail('LS', { path: '/w/acme' })).toBe('acme')
  })
})
