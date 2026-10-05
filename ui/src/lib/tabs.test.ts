import { describe, expect, it } from 'vitest'
import {
  activeTab,
  EMPTY_WORKSPACE,
  findTabBySession,
  leaves,
  parseWorkspace,
  tabsOf,
  workspaceReducer,
  type Workspace,
  type WorkspaceAction,
} from './tabs'

const open = (sessionId: string, projectId = 'p1'): WorkspaceAction => ({ type: 'open', target: { kind: 'session', sessionId }, projectId, title: sessionId })
const run = (...actions: WorkspaceAction[]): Workspace => actions.reduce(workspaceReducer, EMPTY_WORKSPACE)

describe('workspace tabs', () => {
  it('opens a session once: a second open focuses the tab it already has', () => {
    const ws = run(open('a'), open('b'), open('a'))
    expect(ws.tabs).toHaveLength(2)
    expect(activeTab(ws) && leaves(activeTab(ws)!.root)[0]!.target.sessionId).toBe('a')
  })

  it('keeps tabs per project and switches project with the tab', () => {
    const ws = run(open('a', 'p1'), open('b', 'p2'))
    expect(ws.activeProject).toBe('p2')
    expect(tabsOf(ws, 'p1').map((t) => t.title)).toEqual(['a'])
    const back = workspaceReducer(ws, { type: 'activate', tabId: tabsOf(ws, 'p1')[0]!.id })
    expect(back.activeProject).toBe('p1')
  })

  it('closing the tab in front hands the front to its right neighbour, else its left', () => {
    let ws = run(open('a'), open('b'), open('c'))
    const [a, b] = tabsOf(ws, 'p1')
    ws = workspaceReducer(ws, { type: 'activate', tabId: b!.id })
    ws = workspaceReducer(ws, { type: 'close', tabId: b!.id })
    expect(activeTab(ws)!.title).toBe('c')
    ws = workspaceReducer(ws, { type: 'close', tabId: activeTab(ws)!.id })
    expect(activeTab(ws)!.id).toBe(a!.id)
    ws = workspaceReducer(ws, { type: 'close', tabId: a!.id })
    expect(activeTab(ws)).toBeUndefined()
  })

  it('⌘1–8 pick by position and ⌘9 is always the last tab', () => {
    let ws = run(open('a'), open('b'), open('c'))
    ws = workspaceReducer(ws, { type: 'activate-index', index: 0 })
    expect(activeTab(ws)!.title).toBe('a')
    ws = workspaceReducer(ws, { type: 'activate-index', index: 8 })
    expect(activeTab(ws)!.title).toBe('c')
    ws = workspaceReducer(ws, { type: 'activate-index', index: 5 })
    expect(activeTab(ws)!.title).toBe('c') // no 6th tab: nothing changes
  })

  it('cycles and wraps, and reorders within a project', () => {
    let ws = run(open('a'), open('b'), open('c'))
    ws = workspaceReducer(ws, { type: 'cycle', delta: 1 })
    expect(activeTab(ws)!.title).toBe('a')
    ws = workspaceReducer(ws, { type: 'cycle', delta: -1 })
    expect(activeTab(ws)!.title).toBe('c')
    ws = workspaceReducer(ws, { type: 'move', tabId: activeTab(ws)!.id, toIndex: 0 })
    expect(tabsOf(ws, 'p1').map((t) => t.title)).toEqual(['c', 'a', 'b'])
  })

  it('survives a round trip through storage, and drops what does not parse', () => {
    const ws = run(open('a'), open('b', 'p2'))
    expect(parseWorkspace(JSON.stringify(ws))).toEqual(ws)
    expect(parseWorkspace('{not json')).toEqual(EMPTY_WORKSPACE)
    expect(parseWorkspace(JSON.stringify({ version: 2, tabs: [] }))).toEqual(EMPTY_WORKSPACE)
    const broken = { ...ws, tabs: [...ws.tabs, { id: 'x', projectId: 'p1', root: { type: 'pane', id: 'q' }, focusedPaneId: 'q', title: '' }] }
    expect(parseWorkspace(JSON.stringify(broken)).tabs).toHaveLength(2)
  })

  it('holds a split tree, so split panes need no new storage', () => {
    const ws = run(open('a'))
    const tab = ws.tabs[0]!
    const split: Workspace = {
      ...ws,
      tabs: [{ ...tab, root: { type: 'split', id: 's', direction: 'row', sizes: [0.5, 0.5], children: [tab.root, { type: 'pane', id: 'p2', target: { kind: 'shell', sessionId: 'sh' } }] } }],
    }
    const back = parseWorkspace(JSON.stringify(split))
    expect(leaves(back.tabs[0]!.root).map((l) => l.target.sessionId)).toEqual(['a', 'sh'])
    expect(findTabBySession(back, 'sh')?.id).toBe(tab.id)
  })
})
