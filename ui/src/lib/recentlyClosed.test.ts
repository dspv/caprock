import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from './api'
import type { Tab } from './tabs'
import {
  RECENTLY_CLOSED_EVENT, RECENTLY_CLOSED_KEY, RECENTLY_CLOSED_MAX, closedAgo, closedEntries, forgetClosed,
  loadRecentlyClosed, parseRecentlyClosed, recordClosed, reopenPlan, shownClosed, withClosed, type ClosedTab,
} from './recentlyClosed'

const NOW = Date.UTC(2026, 9, 20, 12, 0)
const entry = (id: string, at = NOW): ClosedTab => ({ sessionId: id, title: `T ${id}`, projectId: 'p', cwd: '/w/p', closedAt: at })
const sess = (p: Partial<SessionSummary>) => ({ session_id: 's', cwd: '/w/p', status: 'ended', owned: true, ...p }) as SessionSummary

beforeEach(() => localStorage.clear())

describe('the list', () => {
  it('keeps the newest first, each session once, capped', () => {
    let list: ClosedTab[] = []
    for (let i = 0; i < RECENTLY_CLOSED_MAX + 5; i++) list = withClosed(list, [entry(`s${i}`, NOW + i)])
    expect(list).toHaveLength(RECENTLY_CLOSED_MAX)
    expect(list[0]!.sessionId).toBe(`s${RECENTLY_CLOSED_MAX + 4}`)
    // Closed again: back to the front, not twice.
    list = withClosed(list, [entry('s10', NOW + 100)])
    expect(list[0]!.sessionId).toBe('s10')
    expect(list.filter((e) => e.sessionId === 's10')).toHaveLength(1)
  })

  it('survives a reload, says so on window, and drops one once reopened', () => {
    const heard = vi.fn()
    window.addEventListener(RECENTLY_CLOSED_EVENT, heard)
    recordClosed([entry('a')])
    recordClosed([entry('b')])
    expect(loadRecentlyClosed().map((e) => e.sessionId)).toEqual(['b', 'a'])
    forgetClosed('b')
    expect(loadRecentlyClosed().map((e) => e.sessionId)).toEqual(['a'])
    expect(heard).toHaveBeenCalledTimes(3)
    window.removeEventListener(RECENTLY_CLOSED_EVENT, heard)
  })

  it('reads a damaged store as empty and skips bad rows', () => {
    expect(parseRecentlyClosed('{oops')).toEqual([])
    expect(parseRecentlyClosed(JSON.stringify([{ sessionId: '' }, 3, entry('ok')]))).toEqual([entry('ok')])
    localStorage.setItem(RECENTLY_CLOSED_KEY, 'null')
    expect(loadRecentlyClosed()).toEqual([])
  })

  it('lists five, leaving out a session that has a tab again', () => {
    const list = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => entry(id))
    expect(shownClosed(list, new Set(['b'])).map((e) => e.sessionId)).toEqual(['a', 'c', 'd', 'e', 'f'])
  })
})

describe('what a close puts on it', () => {
  const pane = (id: string, kind: 'session' | 'shell' | 'observe' | 'file' | 'page', sessionId: string) => ({ type: 'pane' as const, id, target: { kind, sessionId } })
  const sessions = new Map([
    ['a1', sess({ session_id: 'a1', title: 'Agent one', cwd: '/w/p/a' })],
    ['sh', sess({ session_id: 'sh', kind: 'shell' })],
    ['o1', sess({ session_id: 'o1', title: 'Watched', owned: false })],
  ])
  const name = (s: SessionSummary) => s.title ?? ''

  it('takes an agent tab under its own title, with its folder', () => {
    const tab: Tab = { id: 't', projectId: 'p', root: pane('x', 'session', 'a1'), focusedPaneId: 'x', title: 'My tab' }
    expect(closedEntries(tab, undefined, sessions, 'My tab', name, NOW)).toEqual([{ sessionId: 'a1', title: 'My tab', projectId: 'p', cwd: '/w/p/a', closedAt: NOW }])
  })

  it('never a shell, a file or a page; a watched session is kept', () => {
    for (const [kind, id] of [['shell', 'sh'], ['file', 'f'], ['page', 'page:1']] as const) {
      const tab: Tab = { id: 't', projectId: 'p', root: pane('x', kind, id), focusedPaneId: 'x', title: 'x' }
      expect(closedEntries(tab, undefined, sessions, 'x', name, NOW), kind).toEqual([])
    }
    // A shell tab's session is a "session" leaf whose summary says shell.
    const shellTab: Tab = { id: 't', projectId: 'p', root: pane('x', 'session', 'sh'), focusedPaneId: 'x', title: 'shell' }
    expect(closedEntries(shellTab, undefined, sessions, 'shell', name, NOW)).toEqual([])
    const watched: Tab = { id: 't', projectId: 'p', root: pane('x', 'observe', 'o1'), focusedPaneId: 'x', title: 'Watched' }
    expect(closedEntries(watched, undefined, sessions, 'Watched', name, NOW).map((e) => e.sessionId)).toEqual(['o1'])
  })

  it('from a split, only the closing pane, named by its session', () => {
    const tab: Tab = {
      id: 't', projectId: 'p', focusedPaneId: 'x', title: 'Agent one',
      root: { type: 'split', id: 'sp', direction: 'row', sizes: [0.5, 0.5], children: [pane('x', 'session', 'a1'), pane('y', 'session', 'sh')] },
    }
    expect(closedEntries(tab, 'y', sessions, 'Agent one', name, NOW)).toEqual([])
    expect(closedEntries(tab, 'x', sessions, 'Agent one', name, NOW).map((e) => e.title)).toEqual(['Agent one'])
  })
})

describe('bringing one back', () => {
  it('a tab already open comes to the front', () => {
    expect(reopenPlan(entry('a'), sess({ status: 'active' }), true)).toEqual({ do: 'tab' })
  })

  it('a live process gets its tab again', () => {
    const s = sess({ status: 'idle' })
    expect(reopenPlan(entry('a'), s, false)).toEqual({ do: 'open', session: s })
  })

  it('an ended one is continued in its folder, in the mode it last ran in', () => {
    expect(reopenPlan(entry('a'), sess({ cwd: '/w/p/x', resume: { ok: true, permission_mode: 'bypassPermissions' } }), false))
      .toEqual({ do: 'resume', cwd: '/w/p/x', permissionMode: 'bypassPermissions', checked: true })
    // No longer on the list: its folder from when it closed.
    expect(reopenPlan(entry('a'), undefined, false)).toEqual({ do: 'resume', cwd: '/w/p', checked: false })
    // Listed as ended before its resume answer came: not checked either, so its page is asked first.
    expect(reopenPlan(entry('a'), sess({ cwd: '/w/p/x' }), false)).toEqual({ do: 'resume', cwd: '/w/p/x', checked: false })
  })

  it('one that cannot be continued here opens read-only; one with nowhere to go, its page', () => {
    const s = sess({ resume: { ok: false, reason: 'transcript gone' } })
    expect(reopenPlan(entry('a'), s, false)).toEqual({ do: 'open', session: s })
    expect(reopenPlan({ ...entry('a'), cwd: undefined }, undefined, false)).toEqual({ do: 'page' })
  })
})

it('says its age quietly', () => {
  expect(closedAgo(NOW - 20_000, NOW)).toBe('now')
  expect(closedAgo(NOW - 2 * 60_000, NOW)).toBe('2 min')
  expect(closedAgo(NOW - 61 * 60_000, NOW)).toBe('1 h')
  expect(closedAgo(NOW - 3 * 24 * 3600_000, NOW)).toBe('3 d')
})
