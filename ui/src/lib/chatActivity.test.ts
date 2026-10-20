import { describe, expect, it } from 'vitest'
import type { Event } from './api'
import { mergeEvents } from './chat'
import { donePhrase, fmtElapsed, openTurn, promptParts, promptPlain, stepPhrase } from './chatActivity'

const ev = (id: number, kind: string, payload: unknown = {}, extra: Partial<Event> = {}): Event => ({
  id, ts: new Date(Date.UTC(2026, 9, 19, 12, 0, id)).toISOString(), session_id: 's', source: 'hook', kind, payload, ...extra,
})

describe('openTurn', () => {
  it('is open from the prompt to the Stop, naming the call that has no result', () => {
    const prompt = ev(1, 'turn.user', { prompt: 'go' })
    expect(openTurn([prompt])).toEqual({ since: prompt.ts, step: '' })
    const pre = ev(2, 'tool.pre', { tool_name: 'Read', tool_use_id: 'a', tool_input: { file_path: '/repo/src/main.go' } }, { tool: 'Read' })
    expect(openTurn([prompt, pre])?.step).toBe('Reading main.go')
    const post = ev(3, 'tool.post', { tool_use_id: 'a' })
    expect(openTurn([prompt, pre, post])?.step).toBe('')
    expect(openTurn([prompt, pre, post, ev(4, 'agent.stop')])).toBeNull()
    expect(openTurn([prompt], true)).toBeNull()
  })

  it('a subagent\'s Stop and a harness notice do not end or start a turn', () => {
    const prompt = ev(1, 'turn.user', { prompt: 'go' })
    expect(openTurn([prompt, ev(2, 'agent.stop', {}, { agent_id: 'x' })])).not.toBeNull()
    expect(openTurn([ev(1, 'agent.stop'), ev(2, 'turn.user', { prompt: '<task-notification><summary>done</summary></task-notification>' })])).toBeNull()
    expect(openTurn([])).toBeNull()
  })
})

describe('donePhrase', () => {
  it('says a call in the past tense, in plain words', () => {
    expect(donePhrase('WebSearch', { query: 'rtx 3060 ti' })).toBe('Searched the web: rtx 3060 ti')
    expect(donePhrase('WebFetch', { url: 'https://example.com/a' })).toBe('Fetched https://example.com/a')
    expect(donePhrase('Read', { file_path: '/w/app/main.go' })).toBe('Read main.go')
    expect(donePhrase('Edit', { file_path: '/w/app/ui.tsx' })).toBe('Edited ui.tsx')
    expect(donePhrase('Bash', { command: 'npm test\nmore' })).toBe('Ran npm test')
    expect(donePhrase('Bash', {})).toBe('Ran a command')
    expect(donePhrase('Grep', { pattern: 'TODO' })).toBe('Searched for TODO')
    expect(donePhrase('Task', { description: 'review' })).toBe('Delegated: review')
    expect(donePhrase('TodoWrite', {})).toBe('Updated its plan')
    expect(donePhrase('mcp__caprock__sessions', {})).toBe('Called sessions')
    expect(donePhrase('Frobnicate', {})).toBe('Used Frobnicate')
  })
})

describe('stepPhrase', () => {
  it('reads a call as what it does', () => {
    expect(stepPhrase('Bash', { command: 'go test ./...\nmore' })).toBe('Running go test ./...')
    expect(stepPhrase('Grep', { pattern: 'TODO' })).toBe('Searching TODO')
    expect(stepPhrase('Task', { description: 'review the diff' })).toBe('Delegating: review the diff')
    expect(stepPhrase('Read', {})).toBe('Reading files')
  })
})

describe('fmtElapsed', () => {
  it('is m:ss, and h:mm:ss past an hour', () => {
    expect(fmtElapsed(42_000)).toBe('0:42')
    expect(fmtElapsed(5 * 60_000 + 3_000)).toBe('5:03')
    expect(fmtElapsed(3_600_000 + 61_000)).toBe('1:01:01')
  })
})

describe('promptParts', () => {
  it('words, one pasted block, words', () => {
    expect(promptParts('see this:\n<pasted_content id="p1">\na\nb\n</pasted_content id="p1">\nwhy?')).toEqual([
      { kind: 'text', text: 'see this:' },
      { kind: 'pasted', text: 'a\nb', lines: 2 },
      { kind: 'text', text: 'why?' },
    ])
  })

  it('drops a reminder and keeps a placeholder whose text was never recorded', () => {
    expect(promptParts('fix it <system-reminder>secret</system-reminder>[Pasted text #1 +12 lines]')).toEqual([
      { kind: 'text', text: 'fix it ' },
      { kind: 'pasted', text: '', lines: 12 },
    ])
    expect(promptPlain('a <pasted_content id="x">1\n2\n3</pasted_content id="x"> b')).toBe('a  [pasted · 3 lines]  b')
  })

  it('a plain prompt is one part', () => {
    expect(promptParts('μήνυμα 日本 🙂')).toEqual([{ kind: 'text', text: 'μήνυμα 日本 🙂' }])
  })
})

describe('mergeEvents', () => {
  it('replaces a held reply when its words arrive, and keeps the same array otherwise', () => {
    const first = ev(2, 'turn.assistant', { text: '' })
    const held = [ev(1, 'turn.user', { prompt: 'q' }), first]
    expect(mergeEvents(held, [first])).toBe(held)
    expect(mergeEvents(held, [{ ...first }])).toBe(held)
    const next = mergeEvents(held, [{ ...first, payload: { text: 'answer' } }])
    expect(next).not.toBe(held)
    expect(next.map((e) => e.id)).toEqual([1, 2])
    expect((next[1]!.payload as { text: string }).text).toBe('answer')
  })
})
