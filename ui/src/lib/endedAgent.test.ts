import { describe, expect, it } from 'vitest'
import { endCause, endedClock, endedText, endedUnexpectedly } from './endedAgent'
import { EMPTY_WORKSPACE, parseWorkspace, workspaceReducer } from './tabs'
import { tabLabels } from './tablabels'

const at = new Date(2026, 10, 20, 19, 58).getTime()
const now = new Date(2026, 10, 20, 21, 0).getTime()

describe('an agent that ended unexpectedly', () => {
  it('names the cause in words', () => {
    expect(endCause(-1)).toBe('killed by a signal')
    expect(endCause(1)).toBe('exited with code 1')
    expect(endCause(137)).toBe('exited with code 137')
  })

  it('says which session, when and why, in one line', () => {
    expect(endedText({ sessionId: 's', title: 'ops', code: -1, at }, now)).toBe('ops ended unexpectedly at 19:58 (killed by a signal)')
    expect(endedClock(at, new Date(2026, 10, 22, 9, 0).getTime())).toBe('20 Nov 19:58')
  })

  it('reads the daemon’s report: unexpected, never an exit at once', () => {
    const base = { session_id: 's', code: -1, ran_ms: 1, tail: '', at }
    expect(endedUnexpectedly({ ...base, early: false, unexpected: true })).toBe(true)
    expect(endedUnexpectedly({ ...base, early: true, unexpected: true })).toBe(false)
    expect(endedUnexpectedly({ ...base, code: 0, early: false })).toBe(false)
    expect(endedUnexpectedly(null)).toBe(false)
  })

  it('keeps the name on the shell’s tab, and the × only hides the line', () => {
    const ended = { sessionId: 'agent-1', title: 'ops', code: -1, at }
    let ws = workspaceReducer(EMPTY_WORKSPACE, { type: 'open', target: { kind: 'shell', sessionId: 'sh', ended }, projectId: 'p', title: 'ops' })
    const label = () => tabLabels(ws.tabs, new Map(), new Set(), () => undefined).get(ws.tabs[0]!.id)!
    expect(label().title).toBe('ops')
    expect(label().shellName).toBe('Shell 1')
    ws = workspaceReducer(ws, { type: 'dismiss-ended', sessionId: 'sh' })
    const t = ws.tabs[0]!.root
    expect(t.type === 'pane' && t.target.ended?.dismissed).toBe(true)
    expect(label().title).toBe('ops')
    // Stored and read back, as after a reload.
    expect(parseWorkspace(JSON.stringify(ws)).tabs[0]!.root).toEqual(t)
  })

  it('drops a malformed stored value, never the tab', () => {
    const ws = workspaceReducer(EMPTY_WORKSPACE, { type: 'open', target: { kind: 'shell', sessionId: 'sh' }, projectId: 'p', title: 'shell' })
    const raw = JSON.parse(JSON.stringify(ws))
    raw.tabs[0].root.target.ended = { sessionId: 'agent-1' }
    const back = parseWorkspace(JSON.stringify(raw))
    expect(back.tabs).toHaveLength(1)
    const root = back.tabs[0]!.root
    expect(root.type === 'pane' && root.target.ended).toBeUndefined()
  })
})
