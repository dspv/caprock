/**
 * A session on another computer is a tab like one of this machine's (issue
 * #1085): keyed apart from local sessions, kept across a restart, named
 * from its computer's list and tagged with the computer.
 */
import { describe, expect, it } from 'vitest'
import type { SessionSummary } from './api'
import { tabLabels } from './tablabels'
import {
  EMPTY_WORKSPACE,
  findTabBySession,
  isRemoteTab,
  numberedTabs,
  ownTab,
  parseWorkspace,
  remoteKey,
  remoteTarget,
  workspaceReducer,
  type Workspace,
  type WorkspaceAction,
} from './tabs'

const PC = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const SID = '0b6c7e2a-1111-4222-8333-944445555666'
const run = (...actions: WorkspaceAction[]): Workspace => actions.reduce(workspaceReducer, EMPTY_WORKSPACE)
const openRemote = (sid = SID): WorkspaceAction => ({ type: 'open', target: remoteTarget(PC, sid, 'Win PC1'), projectId: 'p1', title: 'remote' })

describe('a session on another computer as a tab', () => {
  it('is keyed apart from this machine’s sessions, opens once, and takes a ⌘ digit', () => {
    // The same id here and there is two tabs: the remote one never stands for the local one.
    let ws = run({ type: 'open', target: { kind: 'session', sessionId: SID }, projectId: 'p1', title: 'here' }, openRemote())
    expect(ws.tabs).toHaveLength(2)
    expect(findTabBySession(ws, SID)!.title).toBe('here')
    expect(findTabBySession(ws, remoteKey(PC, SID))!.title).toBe('remote')
    ws = workspaceReducer(ws, openRemote())
    expect(ws.tabs).toHaveLength(2)
    const remote = ws.tabs[1]!
    expect(isRemoteTab(remote)).toBe(true)
    expect(numberedTabs(ws.tabs)).toHaveLength(2)
    // A whole tab: never split.
    expect(ownTab(remoteTarget(PC, SID))).toBe(true)
  })

  it('survives a restart, and a malformed one is dropped', () => {
    const ws = run(openRemote())
    expect(parseWorkspace(JSON.stringify(ws))).toEqual(ws)
    const bad = JSON.parse(JSON.stringify(ws)) as Workspace
    const target = (bad.tabs[0]!.root as { target: { machine: string } }).target
    target.machine = 'no'
    expect(parseWorkspace(JSON.stringify(bad)).tabs).toHaveLength(0)
    // The key must be the machine's and the session's: not any session id.
    const forged = JSON.parse(JSON.stringify(ws)) as Workspace
    ;(forged.tabs[0]!.root as { target: { sessionId: string } }).target.sessionId = SID
    expect(parseWorkspace(JSON.stringify(forged)).tabs).toHaveLength(0)
  })

  it('is named from its computer’s list, with its state, and tagged with the computer', () => {
    const ws = run(openRemote())
    const remote = { session_id: SID, title: 'Port the shim', status: 'active', activity: { phrase: '', at: '', health: 'waiting-on-you' } } as unknown as SessionSummary
    const named = tabLabels(ws.tabs, new Map(), new Set(), () => undefined, {
      names: new Map([[PC, 'Win PC1']]),
      sessions: new Map([[remoteKey(PC, SID), remote]]),
    }).get(ws.tabs[0]!.id)!
    expect(named).toMatchObject({ title: 'Port the shim', machine: 'Win PC1', dot: 'waiting', isShell: false })
    expect(named.session).toBeUndefined()
    // Before the list answers: the stored title and the name it opened with.
    const early = tabLabels(ws.tabs, new Map(), new Set(), () => undefined).get(ws.tabs[0]!.id)!
    expect(early).toMatchObject({ title: 'remote', machine: 'Win PC1', dot: 'idle' })
  })
})
