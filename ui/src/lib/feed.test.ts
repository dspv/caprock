/**
 * Feed phrasing — the rules that keep the activity feed readable: only events a
 * human would want to see become lines, paths are shortened to a basename, and
 * the buffer stays a bounded window rather than a growing log.
 */
import { describe, expect, it } from 'vitest'
import { pushItem, toFeedItem, type FeedItem } from './feed'
import type { Event } from './api'

function ev(kind: string, payload: unknown, id = 1): Event {
  return {
    id,
    ts: '2026-08-20T10:00:00.000Z',
    session_id: 's1',
    source: 'hook',
    kind,
    payload,
  } as Event
}

describe('toFeedItem', () => {
  it('describes an edit by file name, not full path', () => {
    const it_ = toFeedItem(ev('tool.pre', { tool_name: 'Edit', tool_input: { file_path: '/Users/x/dev/caprock/ui/src/App.tsx' } }))
    expect(it_?.text).toBe('editing')
    expect(it_?.detail).toBe('App.tsx')
  })

  it('describes a shell command and clips a long one', () => {
    const long = 'go test ./... -run TestSomethingVeryLongIndeed -v -count=1 -timeout 30s -race'
    const it_ = toFeedItem(ev('tool.pre', { tool_name: 'Bash', tool_input: { command: long } }))
    expect(it_?.text).toBe('running')
    expect(it_!.detail!.length).toBeLessThanOrEqual(52)
    expect(it_!.detail!.endsWith('…')).toBe(true)
  })

  it('drops successful tool results but keeps failures', () => {
    expect(toFeedItem(ev('tool.post', { is_error: false }))).toBeNull()
    const failed = toFeedItem(ev('tool.post', { is_error: true }))
    expect(failed?.tone).toBe('danger')
  })

  it('drops the high-volume kinds that would drown the feed', () => {
    for (const kind of ['turn.assistant', 'turn.user', 'cost.tick', 'mail.sent']) {
      expect(toFeedItem(ev(kind, {}))).toBeNull()
    }
  })

  it('marks a verified task as the good news it is', () => {
    const done = toFeedItem(ev('task.done', {}))
    expect(done?.tone).toBe('ok')
    expect(done?.text).toContain('verified')
  })

  it('falls back to the tool name for a tool it has no phrasing for', () => {
    const it_ = toFeedItem(ev('tool.pre', { tool_name: 'SomeNewTool', tool_input: {} }))
    expect(it_?.detail).toBe('SomeNewTool')
  })

  it('carries the project through so a row can name the repo', () => {
    const it_ = toFeedItem(ev('tool.pre', { tool_name: 'Read', tool_input: { file_path: 'a/b.go' } }), 'caprock')
    expect(it_?.project).toBe('caprock')
  })

  it('survives an event with no payload', () => {
    expect(() => toFeedItem(ev('tool.pre', null))).not.toThrow()
  })
})

describe('pushItem', () => {
  const item = (id: string): FeedItem => ({ id, ts: 1, sessionId: 's', icon: '·', text: 't', tone: 'normal' })

  it('puts the newest first and caps the buffer', () => {
    let items: FeedItem[] = []
    for (let i = 0; i < 80; i++) items = pushItem(items, item(String(i)), 60)
    expect(items).toHaveLength(60)
    expect(items[0]!.id).toBe('79')
  })

  it('ignores a repeat of the item already at the head', () => {
    const items = pushItem(pushItem([], item('a')), item('a'))
    expect(items).toHaveLength(1)
  })
})

describe('shell lines stay readable', () => {
  it('collapses long absolute paths so the command stays visible', () => {
    const cmd = 'cat /private/tmp/claude-501/-Users-ds-dev-caprock/8e968de8/scratchpad/notes.md'
    const it_ = toFeedItem(ev('tool.pre', { tool_name: 'Bash', tool_input: { command: cmd } }))
    expect(it_!.detail).toContain('cat')
    expect(it_!.detail).toContain('notes.md')
    expect(it_!.detail).not.toContain('/private/tmp/claude-501')
  })
})

describe('seeding beside live frames', () => {
  it('keeps history when a live row already arrived', () => {
    // A live frame lands first; the seeded history must not be discarded.
    const liveRow = { id: '99', ts: 500, sessionId: 's', icon: '·', text: 'live', tone: 'normal' as const }
    const history = [
      { id: '3', ts: 300, sessionId: 's', icon: '·', text: 'older', tone: 'normal' as const },
      { id: '4', ts: 400, sessionId: 's', icon: '·', text: 'newer', tone: 'normal' as const },
    ]
    const seen = new Set([liveRow].map((i) => i.id))
    const merged = [liveRow, ...history.filter((i) => !seen.has(i.id))]
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 60)
    expect(merged.map((i) => i.id)).toEqual(['99', '4', '3'])
  })
})

/**
 * A /clear is the one event that explains why a session's cost and context
 * just went back to zero, and it is the user's doing rather than Claude's.
 * With no case of its own it fell through to the default, which drops the
 * event — so the numbers reset with nothing on screen accounting for it.
 */
describe('a cleared context', () => {
  it('gets a line of its own, not the compact one', () => {
    const item = toFeedItem(ev('context.clear', {}))
    expect(item).not.toBeNull()
    expect(item!.text).toBe('context cleared')
    // "compacted its context" would describe an event that did not happen.
    expect(item!.text).not.toContain('compact')
  })
})
