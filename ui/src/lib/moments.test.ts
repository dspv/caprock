/**
 * Moments — the rules that make "What happened" readable: reads are counted
 * and never shown, results are read from what was recorded and never guessed,
 * repeats in one thread fold, and a Stop is the end of a turn, not of a session.
 */
import { describe, expect, it } from 'vitest'
import { commandKind, commitMessage, momentLine, slimEvent, toMoments } from './moments'
import type { Event } from './api'

const T0 = Date.parse('2026-10-14T10:00:00.000Z')
let next = 1

function ev(kind: string, payload: Record<string, unknown>, opts: Partial<Event> & { at?: number } = {}): Event {
  const id = next++
  const { at = id * 1000, ...rest } = opts
  return { id, ts: new Date(T0 + at).toISOString(), session_id: 's1', source: 'hook', kind, payload, ...rest } as Event
}

/** A shell call: its start, and a hook result unless told otherwise. */
function bash(command: string, result: 'ok' | 'fail' | 'none' | 'interrupted' = 'ok', extra: Record<string, unknown> = {}, opts: Partial<Event> = {}): Event[] {
  const use = `tu${next}`
  const pre = ev('tool.pre', { tool_name: 'Bash', tool_use_id: use, cwd: '/r', tool_input: { command } }, { tool: 'Bash', ...opts })
  if (result === 'none') return [pre]
  if (result === 'fail') {
    return [pre, ev('tool.post', { tool_use_id: use, is_error: true, tool_response: 'Exit code 2\nFAIL ./x' }, { source: 'transcript', ...opts })]
  }
  return [pre, ev('tool.post', {
    tool_name: 'Bash', tool_use_id: use, tool_input: { command },
    tool_response: { stdout: 'ok', stderr: '', interrupted: result === 'interrupted', ...extra },
  }, { tool: 'Bash', ...opts })]
}

function edit(path: string, opts: Partial<Event> = {}): Event {
  return ev('tool.pre', { tool_name: 'Edit', tool_use_id: `e${next}`, cwd: '/r', tool_input: { file_path: path } }, { tool: 'Edit', ...opts })
}

const NOW = T0 + 3_600_000
const lines = (events: Event[], now = NOW) => toMoments(events, now).map((m) => momentLine(m))

describe('commandKind', () => {
  it('knows tests, builds and git from the program, not from a path', () => {
    expect(commandKind('cd ui && npx vitest run --maxWorkers=1 src/x.test.ts 2>&1 | tail -5')).toBe('test')
    expect(commandKind('go test ./internal/api/ -run TestX')).toBe('test')
    expect(commandKind('make check')).toBe('test')
    expect(commandKind('python3 -m pytest -q')).toBe('test')
    expect(commandKind('npm run build')).toBe('build')
    expect(commandKind('git -C /r commit -m "fix: x"')).toBe('commit')
    expect(commandKind('git push -u origin feat/x')).toBe('push')
    expect(commandKind('gh pr create --title "x" --body y')).toBe('pr')
    expect(commandKind('gh -R o/r pr view 5')).toBe('read')
  })

  it('treats look-arounds as reads', () => {
    for (const c of ['sed -n 150,260p internal/github/branchpulls.go', 'cat /tmp/x.output; echo ---; dig +short a.b', 'git status', 'ls -la', 'env -i HOME=/tmp curl -s http://x', 'for f in *; do grep -n x "$f"; done']) {
      expect(commandKind(c)).toBe('read')
    }
  })

  it('does not run the body of a heredoc as commands', () => {
    expect(commandKind("git commit -F - <<'EOF'\nfeat: x\n\nmake test\nEOF")).toBe('commit')
  })
})

describe('commitMessage', () => {
  it('reads -m and a heredoc, first line only', () => {
    expect(commitMessage('git commit -m "fix(ui): even rows\n\nbody"')).toBe('fix(ui): even rows')
    expect(commitMessage(`git commit -m "$(cat <<'EOF'\nfeat(now): moments\n\nmore\nEOF\n)"`)).toBe('feat(now): moments')
  })
})

describe('toMoments', () => {
  it('counts reads and shows none of them', () => {
    const evs = [...bash('sed -n 1,20p a.go'), ...bash('cat b.go'), ...bash('ls'), edit('/r/ui/src/A.tsx')]
    const ms = toMoments(evs, NOW)
    expect(ms).toHaveLength(1)
    expect(ms[0]!.kind).toBe('edit')
    expect(ms[0]!.quiet).toBe(3)
  })

  it('folds edits in one thread into a file list with their folder', () => {
    const evs = [edit('/r/ui/src/components/A.tsx'), ...bash('grep x'), edit('/r/ui/src/components/B.tsx'), edit('/r/ui/src/components/C.tsx'), edit('/r/ui/src/components/A.tsx')]
    const [l] = lines(evs)
    expect(l!.text).toBe('edited 3 files in ui/src/components')
    expect(l!.detail).toBe('A.tsx, B.tsx +1')
  })

  it('keeps parallel subagents in their own lanes', () => {
    const a = { agent_id: 'ag1' }
    const b = { agent_id: 'ag2' }
    const evs = [edit('/r/a.go', a), edit('/r/b.go', b), edit('/r/c.go', a), edit('/r/d.go', b)]
    const ms = toMoments(evs, NOW)
    expect(ms).toHaveLength(2)
    expect(ms.every((m) => m.files!.length === 2)).toBe(true)
  })

  it('says tests passed only when a result says so', () => {
    expect(lines(bash('go test ./...'))[0]).toMatchObject({ text: 'tests passed', tone: 'ok' })
    expect(lines(bash('go test ./...', 'fail'))[0]).toMatchObject({ text: 'tests failed (exit 2)', tone: 'danger' })
    expect(lines(bash('go test ./...', 'interrupted'))[0]!.text).toBe('tests interrupted')
  })

  it('says a test with no result is running, then that no result was recorded', () => {
    const evs = bash('npx vitest run', 'none')
    const started = Date.parse(evs[0]!.ts)
    expect(lines(evs, started + 60_000)[0]!.text).toBe('running tests…')
    expect(lines(evs, started + 3_600_000)[0]!.text).toBe('ran tests — no result recorded')
  })

  it('calls lint and vet checks, by the program and not a path with "test" in it', () => {
    expect(lines(bash('go vet ./testdata/fakeclaude/'))[0]!.text).toBe('checks passed')
  })

  it('names a commit by its message, a push by its branch, a PR by number and title', () => {
    const evs = [
      ...bash('git commit -m "feat(now): what happened"'),
      ...bash('git push -u origin feat/activity 2>&1'),
      ...bash('gh pr create --title "feat(now): moments" --body x', 'ok', { gitOperation: { pr: { number: 602, url: 'u', action: 'created' } } }),
    ]
    const ls = lines(evs)
    expect(ls).toContainEqual(expect.objectContaining({ text: 'committed', detail: 'feat(now): what happened' }))
    expect(ls).toContainEqual(expect.objectContaining({ text: 'pushed', detail: 'feat/activity' }))
    expect(ls).toContainEqual(expect.objectContaining({ text: 'opened PR #602', detail: 'feat(now): moments' }))
  })

  it('shows a command that changes things and failed, never a failed read', () => {
    expect(lines(bash('grep -n nothing x.go', 'fail'))).toHaveLength(0)
    expect(lines(bash('python3 shots.py --out x', 'fail'))[0]).toMatchObject({ text: 'command failed (exit 2)', detail: 'python3 shots.py' })
  })

  it('reads a Stop as the end of a turn, with what Claude said', () => {
    const [l] = lines([ev('agent.stop', { last_assistant_message: '**Done.** Released 0.117.0\n\nmore' })])
    expect(l).toMatchObject({ text: 'your turn', detail: 'Done. Released 0.117.0' })
    expect(lines([ev('session.end', {})])[0]!.text).toBe('session ended')
  })

  it('names a subagent by its task, and only its last stop is its finish', () => {
    const use = 'tA'
    const evs = [
      ev('tool.pre', { tool_name: 'Agent', tool_use_id: use, tool_input: { description: 'Fix PTY width' } }, { tool: 'Agent' }),
      ev('tool.post', { tool_name: 'Agent', tool_use_id: use, tool_input: { description: 'Fix PTY width' }, tool_response: { agentId: 'ag9', status: 'async_launched' } }, { tool: 'Agent' }),
      ev('agent.stop', { agent_type: 'general-purpose', last_assistant_message: 'Waiting.' }, { agent_id: 'ag9' }),
      edit('/r/x.go', { agent_id: 'ag9' }),
      ev('agent.stop', { agent_type: 'general-purpose', last_assistant_message: 'Done.' }, { agent_id: 'ag9' }),
    ]
    const ms = toMoments(evs, NOW)
    expect(ms.filter((m) => m.kind === 'subagent.done')).toHaveLength(1)
    expect(ms.find((m) => m.kind === 'subagent')!.detail).toBe('Fix PTY width')
    expect(ms.find((m) => m.kind === 'edit')!.agent).toBe('Fix PTY width')
  })

  it("drops Claude Code's own helper agents", () => {
    expect(toMoments([ev('agent.stop', { agent_type: '', last_assistant_message: 'Running tests' }, { agent_id: 'h1' })], NOW)).toHaveLength(0)
  })

  it('does not count a /compact restart as a session start', () => {
    expect(toMoments([ev('agent.spawn', { source: 'compact' })], NOW)).toHaveLength(0)
    expect(lines([ev('agent.spawn', { source: 'resume' })])[0]!.text).toBe('session resumed')
  })

  it('keeps moment ids stable when more events arrive', () => {
    const first = [edit('/r/a.go')]
    const id = toMoments(first, NOW)[0]!.id
    expect(toMoments([...first, edit('/r/b.go')], NOW)[0]!.id).toBe(id)
  })

  it('survives events with no payload', () => {
    expect(() => toMoments([{ id: 9999, ts: 'x', session_id: 's', source: 'hook', kind: 'tool.pre', payload: null } as Event], NOW)).not.toThrow()
  })
})

describe('slimEvent', () => {
  it('keeps the command and the result flags, not the output', () => {
    const big = 'x'.repeat(30_000)
    const e = slimEvent(ev('tool.post', { tool_use_id: 'u', tool_input: { command: 'go test' }, tool_response: { stdout: big, interrupted: false, gitOperation: { pr: { number: 1 } } } }))
    const p = e.payload as { tool_input: { command: string }; tool_response: Record<string, unknown> }
    expect(p.tool_input.command).toBe('go test')
    expect(p.tool_response.stdout).toBeUndefined()
    expect(p.tool_response.gitOperation).toEqual({ pr: { number: 1 } })
  })
})
