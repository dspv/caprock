import { describe, expect, it } from 'vitest'
import type { Event, SessionSummary, Subagent, Summary } from './api'
import {
  askLine, chipGroups, chipLayout, cockpitState, commandGist, fmtRun, planWindowsFor, requester, runShare, runningTool, subagentChips, subagentDoing, subagentInitial, subagentWaiting, toolDetail, toolKind, toolRuns, turnCosts,
  MAX_SUBAGENT_CHIPS, RUNNING_STALE_MS,
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

describe('subagentDoing', () => {
  it('takes the daemon’s phrase and says where it came from', () => {
    expect(subagentDoing({ doing: 'Rerun the store tests', doing_from: 'call', tool: 'Bash', detail: 'go test ./...' })).toEqual({ text: 'Rerun the store tests', from: 'call' })
    expect(subagentDoing({ doing: 'Editing Cockpit.tsx', doing_from: 'tool', description: 'Fix rows' })).toEqual({ text: 'Editing Cockpit.tsx', from: 'tool' })
  })
  it('falls back, for a daemon that predates it, to the task and then the raw call', () => {
    expect(subagentDoing({ description: 'Fix rows', tool: 'Read', detail: 'a.go' })).toEqual({ text: 'Fix rows', from: 'task' })
    expect(subagentDoing({ tool: 'mcp__github__get_pr', detail: '#12' })).toEqual({ text: 'github·get_pr #12', from: 'tool' })
    expect(subagentDoing({})).toEqual({ text: '', from: '' })
  })
})

describe('subagentInitial', () => {
  it('is the type’s letter, the same one the hero chip shows', () => {
    expect(subagentInitial('general-purpose')).toBe('G')
    expect(subagentInitial('Explore')).toBe('E')
    expect(subagentInitial('Plan')).toBe('P')
    expect(subagentInitial(undefined)).toBe('·')
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

describe('a Codex exec in the tool list', () => {
  it('shows the command its script ran', () => {
    expect(toolDetail('exec', { command: "const r = await tools.exec_command({cmd:\"git status --short\",\"workdir\":\"/p\",\"max_output_tokens\":500});text(r.output)\n" })).toBe('git status --short')
    expect(toolDetail('exec', { command: "const patch = \"*** Begin Patch\\n*** Update File: ui/src/lib/chat.ts\\n@@\";\ntext(await tools.apply_patch(patch));" })).toBe('apply_patch ui/src/lib/chat.ts')
    expect(toolDetail('Bash', { command: 'ls\nmore' })).toBe('ls')
  })
  it('ends a run at the interrupted mark, so it never reads as running', () => {
    const runs = toolRuns([
      ev({ kind: 'tool.pre', ts: T(0), tool: 'exec', payload: { tool_use_id: 'x', tool_input: { command: "const r = await tools.exec_command({cmd:\"git status --short\",\"workdir\":\"/p\",\"max_output_tokens\":500});text(r.output)\n" } } }),
      ev({ kind: 'tool.post', ts: T(9), tool: 'exec', payload: { tool_use_id: 'x', tool_response: '', interrupted: true } }),
    ])
    expect(runningTool(runs, Date.parse(T(10)))).toBeUndefined()
  })
})

describe('subagentChips', () => {
  const a = (id: string, type?: string, extra: Partial<Subagent> = {}): Subagent =>
    ({ agent_id: id, agent_type: type, tool_calls: 1, started_at: 1, last_at: 2, running: true, asking: false, ...extra }) as Subagent
  it('draws the working first, then the finished muted, up to max, and counts the working left out', () => {
    const subs = {
      working: [a('1', 'Explore', { description: 'find the table', model_display: 'Haiku 4.5' }), a('2', 'general-purpose'), a('3', 'Plan'), a('4', 'Explore'), a('5', 'Explore'), a('6')],
      finished: 1, recent: [{ agent_id: 'd', agent_type: 'Plan', tool_calls: 3, started_at: 1, stopped_at: 2 }],
    }
    const { chips, more } = subagentChips(subs, null, 4)
    expect(chips.map((c) => c.initial)).toEqual(['E', 'G', 'P', 'E'])
    expect(more).toBe(2)
    expect(chips[0]!.label).toBe('Explore · find the table · Haiku 4.5 · working')
    expect(chips[0]!.tone).toBe(chips[3]!.tone)
  })
  it('fills spare places with the recently finished, and marks one asking as waiting', () => {
    const subs = { working: [a('1', 'Explore', { asking: true })], finished: 2, recent: [{ agent_id: 'd', tool_calls: 3, started_at: 1, stopped_at: 2 }] }
    const { chips, more } = subagentChips(subs)
    expect(chips.map((c) => [c.initial, c.state])).toEqual([['E', 'waiting'], ['·', 'done']])
    expect(chips[1]!.label).toBe('subagent · finished')
    expect(more).toBe(0)
  })
  it('has nothing to draw without the list', () => {
    expect(subagentChips(undefined)).toEqual({ chips: [], more: 0 })
  })
  // "Lay them out in fives so you can see by fives how many there are"
  // (owner, 2026-10-14, translated).
  it('groups the chips in fives', () => {
    const working = Array.from({ length: 12 }, (_, i) => a(String(i), 'Explore'))
    const { chips, more } = subagentChips({ working, finished: 0 })
    expect(chips).toHaveLength(12)
    expect(more).toBe(0)
    expect(chipGroups(chips).map((g) => g.length)).toEqual([5, 5, 2])
    const many = subagentChips({ working: Array.from({ length: MAX_SUBAGENT_CHIPS + 3 }, (_, i) => a(String(i))), finished: 0 })
    expect(many.chips).toHaveLength(MAX_SUBAGENT_CHIPS)
    expect(many.more).toBe(3)
  })
  it('keeps the chips in the order the subagents started, whatever order the daemon sends', () => {
    const subs = {
      working: [a('c', 'Plan', { started_at: 30 }), a('a', 'Explore', { started_at: 10 })],
      finished: 1, recent: [{ agent_id: 'b', agent_type: 'general-purpose', tool_calls: 3, started_at: 20, stopped_at: 25 }],
    }
    expect(subagentChips(subs).chips.map((c) => [c.id, c.state])).toEqual([['a', 'working'], ['b', 'done'], ['c', 'working']])
    // One finishing changes its state, not its place.
    const later = { working: [a('c', 'Plan', { started_at: 30 })], finished: 2, recent: [{ agent_id: 'a', agent_type: 'Explore', tool_calls: 4, started_at: 10, stopped_at: 40 }, subs.recent[0]!] }
    expect(subagentChips(later).chips.map((c) => [c.id, c.state])).toEqual([['a', 'done'], ['b', 'done'], ['c', 'working']])
  })
  it('wraps onto two lines at full size, then goes compact, then caps with +N — from the width', () => {
    // 230px beside "N working" in a 324px inspector: two groups of five a line.
    expect(chipLayout(230, 0)).toEqual({ compact: false, room: 20 })
    expect(chipLayout(230, 20)).toEqual({ compact: false, room: 20 })
    expect(chipLayout(230, 21)).toEqual({ compact: true, room: 30 })
    expect(chipLayout(230, 30)).toEqual({ compact: true, room: 30 })
    // More than two compact lines: the second line leaves room for "+N".
    expect(chipLayout(200, 40)).toEqual({ compact: true, room: 25 })
    // A wider inspector holds more before it shrinks them.
    expect(chipLayout(340, 25)).toEqual({ compact: false, room: 30 })
    // Never less than one group a line.
    expect(chipLayout(40, 3)).toEqual({ compact: false, room: 10 })
  })
})
