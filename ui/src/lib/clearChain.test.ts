import { describe, expect, it } from 'vitest'
import { clearMoves, clearSuccessor, clearedParts } from './clearChain'
import type { SessionSummary } from './api'
import type { Tab } from './tabs'

const s = (id: string, over: Partial<SessionSummary> = {}) =>
  ({ session_id: id, status: 'ended', last_event_at: 0, started_at: 0, ...over }) as SessionSummary
const byId = (...list: SessionSummary[]) => new Map(list.map((x) => [x.session_id, x]))
const tab = (id: string, sessionId: string, kind: 'session' | 'observe' | 'shell' = 'session'): Tab =>
  ({ id, projectId: 'p', title: id, focusedPaneId: `${id}-pane`, root: { type: 'pane', id: `${id}-pane`, target: { kind, sessionId } } })

describe('clearSuccessor', () => {
  it('follows /clear after /clear to the newest session in the process', () => {
    const list = byId(
      s('a', { pid: 10, started_at: 1 }),
      s('b', { pid: 10, started_at: 2, parent_session: 'a' }),
      s('c', { pid: 10, started_at: 3, parent_session: 'b', status: 'active' }),
    )
    expect(clearSuccessor('a', list)).toBe('c')
    expect(clearSuccessor('b', list)).toBe('c')
    expect(clearSuccessor('c', list)).toBeUndefined()
  })

  it('never follows a fork, live original or not', () => {
    const live = byId(s('orig', { pid: 10, status: 'active' }), s('fork', { pid: 20, parent_session: 'orig', status: 'active' }))
    expect(clearSuccessor('orig', live)).toBeUndefined()
    const ended = byId(s('orig', { pid: 10 }), s('fork', { pid: 20, parent_session: 'orig', status: 'active' }))
    expect(clearSuccessor('orig', ended)).toBeUndefined()
  })

  it('follows nothing without a pid on both ends', () => {
    expect(clearSuccessor('a', byId(s('a'), s('b', { parent_session: 'a' })))).toBeUndefined()
    expect(clearSuccessor('a', byId(s('a', { pid: 10 }), s('b', { parent_session: 'a' })))).toBeUndefined()
  })
})

describe('clearedParts', () => {
  it('lists the earlier parts of the process, oldest first, and stops at a fork', () => {
    const list = byId(
      s('root', { pid: 5 }),
      s('a', { pid: 10, parent_session: 'root' }),
      s('b', { pid: 10, parent_session: 'a' }),
      s('c', { pid: 10, parent_session: 'b', status: 'active' }),
    )
    expect(clearedParts('c', list)).toEqual(['a', 'b'])
    expect(clearedParts('a', list)).toEqual([])
  })
})

describe('clearMoves', () => {
  const list = byId(
    s('old', { pid: 10, started_at: 1 }),
    s('new', { pid: 10, started_at: 2, parent_session: 'old', status: 'active' }),
  )

  it('moves a session or watched pane to the session the /clear started', () => {
    expect(clearMoves([tab('t1', 'old')], list)).toEqual([{ from: 'old', target: { kind: 'session', sessionId: 'new' } }])
    expect(clearMoves([tab('t1', 'old', 'observe')], list)).toEqual([{ from: 'old', target: { kind: 'observe', sessionId: 'new' } }])
  })

  it('leaves a shell, and a session another tab already shows', () => {
    expect(clearMoves([tab('t1', 'old', 'shell')], list)).toEqual([])
    expect(clearMoves([tab('t1', 'old'), tab('t2', 'new')], list)).toEqual([])
  })
})
