import { describe, expect, it } from 'vitest'
import {
  activeTab,
  EMPTY_WORKSPACE,
  findTabBySession,
  focusedLeaf,
  leaves,
  MAX_PANES,
  namingLeaf,
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

  it("closes every tab of one project, splits included, and leaves the others' alone", () => {
    let ws = run(open('a', 'p1'), open('b', 'p1'), open('c', 'p2'))
    ws = workspaceReducer(ws, { type: 'activate', tabId: tabsOf(ws, 'p1')[0]!.id })
    ws = workspaceReducer(ws, { type: 'split', target: { kind: 'shell', sessionId: 'sh' }, projectId: 'p1', title: 'shell', direction: 'row' })
    const after = workspaceReducer(ws, { type: 'close-project', projectId: 'p1' })
    expect(tabsOf(after, 'p1')).toEqual([])
    expect(after.activeByProject.p1).toBeUndefined()
    expect(tabsOf(after, 'p2').map((t) => t.title)).toEqual(['c'])
    expect(findTabBySession(after, 'sh')).toBeUndefined()
    // Nothing of the project open: the same workspace back, not a copy.
    expect(workspaceReducer(after, { type: 'close-project', projectId: 'p1' })).toBe(after)
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

describe('split panes', () => {
  const split = (sessionId: string, direction: 'row' | 'column' = 'row'): WorkspaceAction => ({ type: 'split', target: { kind: 'shell', sessionId }, direction, projectId: 'p1', title: sessionId })
  const ids = (ws: Workspace) => leaves(activeTab(ws)!.root).map((l) => l.target.sessionId)

  it('puts the new pane beside the focused one and focuses it', () => {
    const ws = run(open('a'), split('b'))
    expect(ws.tabs).toHaveLength(1)
    expect(ids(ws)).toEqual(['a', 'b'])
    expect(focusedLeaf(activeTab(ws)!).target.sessionId).toBe('b')
  })

  it('a same-direction split gains a sibling with equal shares; the other direction nests', () => {
    const row = run(open('a'), split('b'), split('c'))
    const root = activeTab(row)!.root
    expect(root.type === 'split' && root.children.length).toBe(3)
    expect(root.type === 'split' && root.sizes.map((v) => v.toFixed(3))).toEqual(['0.333', '0.333', '0.333'])
    const nested = run(open('a'), split('b'), split('c', 'column'))
    const r = activeTab(nested)!.root
    expect(r.type === 'split' && r.children[1]!.type).toBe('split')
    expect(ids(nested)).toEqual(['a', 'b', 'c'])
  })

  it('stops at MAX_PANES, and a session already open is shown where it is, not twice', () => {
    let ws = run(open('a'))
    for (let i = 1; i < MAX_PANES + 2; i++) ws = workspaceReducer(ws, split(`s${i}`))
    expect(ids(ws)).toHaveLength(MAX_PANES)
    const twice = run(open('a'), open('x'), split('a'))
    expect(leaves(activeTab(twice)!.root).map((l) => l.target.sessionId)).toEqual(['a'])
  })

  it('cycles the focus, and closing a pane collapses the split and focuses the neighbour', () => {
    let ws = run(open('a'), split('b'), split('c'))
    ws = workspaceReducer(ws, { type: 'cycle-pane', delta: 1 })
    expect(focusedLeaf(activeTab(ws)!).target.sessionId).toBe('a')
    const tab = activeTab(ws)!
    const a = leaves(tab.root)[0]!
    ws = workspaceReducer(ws, { type: 'close-pane', tabId: tab.id, paneId: a.id })
    expect(ids(ws)).toEqual(['b', 'c'])
    expect(focusedLeaf(activeTab(ws)!).target.sessionId).toBe('b')
    ws = workspaceReducer(ws, { type: 'drop-session', sessionId: 'c' })
    expect(activeTab(ws)!.root.type).toBe('pane')
    ws = workspaceReducer(ws, { type: 'drop-session', sessionId: 'b' })
    expect(ws.tabs).toHaveLength(0)
  })

  it('resizes only to sane shares', () => {
    const ws = run(open('a'), split('b'))
    const tab = activeTab(ws)!
    const id = tab.root.id
    const ok = workspaceReducer(ws, { type: 'resize', tabId: tab.id, splitId: id, sizes: [0.7, 0.3] })
    expect(activeTab(ok)!.root.type === 'split' && (activeTab(ok)!.root as { sizes: number[] }).sizes).toEqual([0.7, 0.3])
    expect(workspaceReducer(ws, { type: 'resize', tabId: tab.id, splitId: id, sizes: [0.95, 0.05] })).toBe(ws)
    expect(workspaceReducer(ws, { type: 'resize', tabId: tab.id, splitId: id, sizes: [1] })).toBe(ws)
  })

  // What a session's `/exit` leaves behind: the tab stays where it is, with a
  // shell in the dead agent's place, in the split position it held.
  it('replaces a dead session in place, keeping the tab and the split', () => {
    let ws = run(open('a'))
    ws = workspaceReducer(ws, { type: 'replace-session', sessionId: 'a', target: { kind: 'shell', sessionId: 'sh' }, title: 'shell' })
    expect(ids(ws)).toEqual(['sh'])
    expect(activeTab(ws)!.title).toBe('shell')
    expect(ws.tabs).toHaveLength(1)

    ws = run(open('a'), split('b'))
    const before = activeTab(ws)!.id
    ws = workspaceReducer(ws, { type: 'replace-session', sessionId: 'a', target: { kind: 'shell', sessionId: 'sh' }, title: 'shell' })
    expect(ids(ws)).toEqual(['sh', 'b'])
    expect(activeTab(ws)!.id).toBe(before)
  })

  it('a replace for a session nobody shows changes nothing', () => {
    const ws = run(open('a'))
    expect(workspaceReducer(ws, { type: 'replace-session', sessionId: 'gone', target: { kind: 'shell', sessionId: 'sh' }, title: 'shell' })).toBe(ws)
  })

  it('a split tab survives storage', () => {
    const ws = run(open('a'), split('b'))
    expect(parseWorkspace(JSON.stringify(ws))).toEqual(ws)
  })
})

describe('a tab\'s name', () => {
  it('comes from its agent, not from a shell split beside it', () => {
    const ws = run(open('agent'), { type: 'split', target: { kind: 'shell', sessionId: 'sh' }, direction: 'row', projectId: 'p1', title: 'sh' })
    const t = activeTab(ws)!
    expect(focusedLeaf(t).target.sessionId).toBe('sh')
    expect(namingLeaf(t).target.sessionId).toBe('agent')
  })
})

describe('file tabs', () => {
  const file = (path: string, worktree = ''): WorkspaceAction => ({
    type: 'open', target: { kind: 'file', sessionId: `file:p1:${worktree}:${path}`, path, worktree }, projectId: 'p1', title: path.split('/').pop()!,
  })

  it('opens a file once, named by the file', () => {
    const ws = run(file('docs/app.md'), open('a'), file('docs/app.md'))
    expect(ws.tabs).toHaveLength(2)
    const t = activeTab(ws)!
    expect(t.title).toBe('app.md')
    expect(focusedLeaf(t).target).toMatchObject({ kind: 'file', path: 'docs/app.md' })
  })

  it('never splits a file tab: a shell asked beside it gets a tab of its own', () => {
    const ws = run(file('README.md'), { type: 'split', target: { kind: 'shell', sessionId: 'sh' }, direction: 'row', projectId: 'p1', title: 'shell' })
    expect(ws.tabs).toHaveLength(2)
    expect(ws.tabs.every((t) => t.root.type === 'pane')).toBe(true)
  })

  it('is kept across a relaunch, and a file tab without a path is dropped', () => {
    const ws = run(file('README.md', 'feat'))
    expect(parseWorkspace(JSON.stringify(ws)).tabs[0]!.root).toMatchObject({ target: { kind: 'file', path: 'README.md', worktree: 'feat' } })
    const broken = JSON.parse(JSON.stringify(ws)) as Workspace
    delete (broken.tabs[0]!.root as { target: { path?: string } }).target.path
    expect(parseWorkspace(JSON.stringify(broken)).tabs).toHaveLength(0)
  })
})
