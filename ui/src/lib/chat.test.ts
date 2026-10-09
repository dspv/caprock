import { describe, expect, it } from 'vitest'
import type { Event } from './api'
import { codexScript, compareEvents, mergeEvents, noticeLine, toMessages, toolCommand, toolInputText, toolLine } from './chat'

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

describe('what Claude Code writes into the user turn', () => {
  it('turns a background task notification into its one-line summary', () => {
    const xml = '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command &quot;Wait for CI&quot; completed (exit code 0)</summary>\n</task-notification>'
    expect(noticeLine(xml)).toBe('Background command "Wait for CI" completed (exit code 0)')
  })
  it('leaves a real prompt alone, even one that mentions a tag', () => {
    expect(noticeLine('why does <task-notification> show up in the chat?')).toBeNull()
    expect(noticeLine('Fix the login bug')).toBeNull()
  })
  it('names a slash command by its command', () => {
    expect(noticeLine('<command-name>/clear</command-name>\n<command-message>clear</command-message>')).toBe('/clear')
  })
})

/** Rows as the daemon stores a Codex session (source `codex`), shapes copied from a real one. */
describe('a Codex session', () => {
  const codex = (id: number, over: Partial<Event>): Event => ev(id, { source: 'codex' as Event['source'], ...over })
  const execScript = 'const r = await tools.exec_command({cmd:"git status --short; git log -1 --oneline","workdir":"/p","max_output_tokens":500});text(r.output)\n'

  it('shows the prompt, the command each exec ran, and every finished call as done', () => {
    const msgs = toMessages([
      codex(1, { kind: 'turn.user', payload: { prompt: 'Why is the Windows job red?', cwd: '/p' } }),
      codex(2, { kind: 'tool.pre', tool: 'exec', payload: { tool_name: 'exec', tool_use_id: 'call_1', tool_input: { command: execScript } } }),
      codex(3, { kind: 'turn.assistant', payload: { text: '' } }),
      codex(4, { kind: 'tool.post', tool: 'exec', payload: { tool_use_id: 'call_1', tool_response: 'Script completed\nOutput:\n M chat.ts', is_error: false } }),
      codex(5, { kind: 'tool.pre', tool: 'shell', payload: { tool_use_id: 'call_2', tool_input: { command: 'go test ./...', argv: ['bash', '-lc', 'go test ./...'] } } }),
      codex(6, { kind: 'tool.post', tool: 'shell', payload: { tool_use_id: 'call_2', tool_response: 'FAIL', is_error: true, exit_code: 1 } }),
      codex(7, { kind: 'turn.assistant', payload: { text: 'The test sets HOME.' } }),
    ])
    expect(msgs.map((m) => m.kind)).toEqual(['user', 'tool', 'tool', 'assistant'])
    expect(msgs[0]!.text).toBe('Why is the Windows job red?')
    expect(msgs[1]!.text).toBe('exec  git status --short; git log -1 --oneline')
    expect(msgs[1]!.result).toContain('M chat.ts')
    expect(msgs[1]!.failed).toBe(false)
    expect(msgs[2]!.text).toBe('shell  go test ./...')
    expect(msgs[2]!.failed).toBe(true)
    expect(msgs[2]!.exitCode).toBe(1)
  })

  it('reads rows stored before the daemon unwrapped a function call', () => {
    const shell = { command: '{"command":["bash","-lc","ls -la"],"workdir":"/p"}' }
    expect(toolLine('shell', shell)).toBe('shell  ls -la')
    expect(toolInputText('shell', shell)).toBe('ls -la')
    const js = { command: '{"code":"let tab = await cua.getBrowser();","title":"Opening the page"}' }
    expect(toolLine('js', js)).toBe('js  Opening the page')
    expect(toolInputText('js', js)).toBe('let tab = await cua.getBrowser();')
    expect(toolLine('wait', { command: '{"cell_id":"11","yield_time_ms":10000}' })).toBe('wait')
  })

  it('reads the command out of an exec script, in every way it is written', () => {
    expect(codexScript(execScript)).toEqual({ line: 'git status --short; git log -1 --oneline', detail: 'git status --short; git log -1 --oneline', call: 'exec_command' })
    expect(codexScript('const r = await tools.exec_command({"cmd":"echo \\"hi\\"\\nls","yield_time_ms":1000});')).toEqual({ line: 'echo "hi"', detail: 'echo "hi"\nls', call: 'exec_command' })
    expect(codexScript("await tools.exec_command({cmd:'rg -n \\'x\\' src'})")!.line).toBe("rg -n 'x' src")
    expect(codexScript('const patch = "*** Begin Patch\\n*** Update File: ui/src/lib/chat.ts\\n@@";\ntext(await tools.apply_patch(patch));')!.line).toBe('apply_patch ui/src/lib/chat.ts')
    expect(codexScript('const r=await tools.write_stdin({session_id:51470,chars:""});text(r.output)')!.line).toBe('write_stdin')
    // A command passed by a variable is not guessed at: the call is named.
    expect(codexScript('const r = await Promise.all(cmds.map(cmd=>tools.exec_command({cmd})))')!.line).toBe('exec_command')
    expect(codexScript('echo plain')).toBeNull()
    expect(toolLine('exec', { command: 'echo plain' })).toBe('exec  echo plain')
  })
})

/**
 * A call that never gets a result. rollout-chat.jsonl's second request is the
 * real shape: an exec call, then turn_aborted with no output, which the daemon
 * stores as a `tool.post` marked `interrupted`.
 */
describe('a call its turn ended without answering', () => {
  const codex = (id: number, over: Partial<Event>): Event => ev(id, { source: 'codex' as Event['source'], ...over })
  const call = (id: number, use: string) => codex(id, { kind: 'tool.pre', tool: 'exec', payload: { tool_name: 'exec', tool_use_id: use, tool_input: { command: "const r = await tools.exec_command({cmd:\"git status --short\",\"workdir\":\"/p\",\"max_output_tokens\":500});text(r.output)\n" } } })
  const prompt = (id: number) => codex(id, { kind: 'turn.user', payload: { prompt: 'Fix it and run the tests again', cwd: '/p' } })
  const state = (m: ReturnType<typeof toMessages>[number]) => (m.interrupted ? 'interrupted' : m.result === undefined ? 'running' : 'done')

  it('reads interrupted once Codex wrote that its turn aborted', () => {
    const msgs = toMessages([
      prompt(1),
      call(2, 'call_exec2'),
      codex(3, { kind: 'tool.post', tool: 'exec', payload: { tool_name: 'exec', tool_use_id: 'call_exec2', tool_response: '', is_error: false, interrupted: true } }),
    ])
    expect(msgs.map((m) => m.kind)).toEqual(['user', 'tool'])
    expect(state(msgs[1]!)).toBe('interrupted')
    expect(msgs[1]!.interrupted).toBe(true)
    expect(msgs[1]!.result).toBeUndefined()
    expect(msgs[1]!.failed).toBeUndefined()
  })

  it('reads interrupted once the next prompt, a Stop or the end of the session came', () => {
    expect(toMessages([prompt(1), call(2, 'a'), prompt(3)]).map((m) => m.interrupted)).toEqual([undefined, true, undefined])
    expect(toMessages([call(1, 'a'), ev(2, { kind: 'agent.stop', payload: { stop_reason: 'end_turn' } })])[0]!.interrupted).toBe(true)
    expect(toMessages([call(1, 'a')], { ended: true })[0]!.interrupted).toBe(true)
  })

  it('still runs while nothing has ended its turn — only the current call', () => {
    const msgs = toMessages([prompt(1), call(2, 'a'), codex(3, { kind: 'turn.assistant', payload: { text: '' } })])
    expect(state(msgs[1]!)).toBe('running')
    // A subagent stopping, or a notice Claude Code wrote for itself, ends nothing.
    expect(state(toMessages([call(1, 'a'), ev(2, { kind: 'agent.stop', agent_id: 'sub1', payload: {} })])[0]!)).toBe('running')
    expect(state(toMessages([call(1, 'a'), ev(2, { kind: 'turn.user', payload: { prompt: '<task-notification><summary>build done</summary></task-notification>' } })])[0]!)).toBe('running')
  })

  it('shows a real output over the mark, whichever came first', () => {
    const out = codex(4, { kind: 'tool.post', tool: 'exec', payload: { tool_use_id: 'a', tool_response: 'Script completed', is_error: false } })
    const mark = codex(3, { kind: 'tool.post', tool: 'exec', payload: { tool_use_id: 'a', tool_response: '', interrupted: true } })
    for (const evs of [[call(1, 'a'), mark, out], [call(1, 'a'), { ...out, id: 3 }, { ...mark, id: 4 }]]) {
      const m = toMessages(evs)[0]!
      expect(m.interrupted).toBeUndefined()
      expect(m.result).toBe('Script completed')
    }
  })

  it('never marks a call that has its result', () => {
    const msgs = toMessages([call(1, 'a'), codex(2, { kind: 'tool.post', payload: { tool_use_id: 'a', tool_response: 'ok' } }), prompt(3)], { ended: true })
    expect(msgs[0]!.interrupted).toBeUndefined()
    expect(msgs[0]!.result).toBe('ok')
  })
})

describe('toolCommand', () => {
  it('is what a call ran, for every place that describes one', () => {
    expect(toolCommand('exec', { command: "const r = await tools.exec_command({cmd:\"git status --short\",\"workdir\":\"/p\",\"max_output_tokens\":500});text(r.output)\n" })).toBe('git status --short')
    expect(toolCommand('exec', { command: "const patch = \"*** Begin Patch\\n*** Update File: ui/src/lib/chat.ts\\n@@\";\ntext(await tools.apply_patch(patch));" })).toBe('apply_patch ui/src/lib/chat.ts')
    expect(toolCommand('exec', { command: "const r = await tools.web__run({search_query:[{q:\"site:caprock.dev\"}]})" })).toBe('web__run')
    expect(toolCommand('shell', { command: '{"command":["bash","-lc","ls -la"]}' })).toBe('ls -la')
    expect(toolCommand('Bash', { command: 'go test ./...' })).toBe('go test ./...')
    expect(toolCommand('Read', { file_path: '/a' })).toBe('')
  })
})
