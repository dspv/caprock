import { describe, expect, it } from 'vitest'
import type { SessionSummary } from './api'
import { renameOf, tabLabels } from './tablabels'
import { renamable } from './sessionNames'
import { leaves, parseWorkspace, workspaceReducer, type Tab } from './tabs'

const pane = (id: string, kind: 'session' | 'shell' | 'file', sessionId: string, path?: string) =>
  ({ type: 'pane' as const, id, target: { kind, sessionId, path } })
const tab = (id: string, projectId: string, root: Tab['root'], title = ''): Tab => ({ id, projectId, root, focusedPaneId: (root as { id: string }).id, title })
const sess = (p: Partial<SessionSummary>) => ({ status: 'active', activity: { phrase: '', at: '', health: 'working' }, ...p }) as SessionSummary

describe('tab labels, shared by the strip and the sidebar', () => {
  it('numbers shells per project in strip order, names agents and files, and marks a branch that is not the project’s own', () => {
    const tabs = [
      tab('a', 'p1', pane('1', 'session', 'agent'), 'stored title'),
      tab('b', 'p1', pane('2', 'shell', 'sh1')),
      tab('c', 'p2', pane('3', 'shell', 'sh2')),
      tab('d', 'p1', pane('4', 'shell', 'sh3')),
      tab('e', 'p1', pane('5', 'file', 'file:p1::src/app.ts', 'src/app.ts')),
      tab('f', 'p1', { type: 'split', id: 's', direction: 'row', sizes: [0.5, 0.5], children: [pane('6', 'session', 'other'), pane('7', 'shell', 'sh4')] }),
    ]
    const sessions = new Map([
      ['agent', sess({ session_id: 'agent', title: 'Fix the login', git_branch: 'feat/login' })],
      ['sh1', sess({ session_id: 'sh1', kind: 'shell', git_branch: 'main' })],
    ])
    const l = tabLabels(tabs, sessions, new Set(), (p) => (p === 'p1' ? 'main' : undefined))
    expect(l.get('a')).toMatchObject({ title: 'Fix the login', branch: 'feat/login', isShell: false })
    expect(l.get('b')).toMatchObject({ title: 'Shell 1', isShell: true })
    expect(l.get('b')!.branch).toBeUndefined()
    expect(l.get('c')!.title).toBe('Shell 1')
    expect(l.get('d')!.title).toBe('Shell 2')
    expect(l.get('e')).toMatchObject({ title: 'app.ts', file: 'src/app.ts' })
    // A split is named after its agent, with the panes beside it counted.
    expect(l.get('f')!.title).toBe('session +1')
  })

  // Owner, 2026-11-20 (translated): "since when can't I rename an open
  // session, neither in the top tabs nor on the left?" — he had typed
  // `claude --resume <id>` into the shell a dead session's tab became.
  describe('a shell tab', () => {
    const shellTab = (name?: string) => tab('t', 'p1', { type: 'pane', id: '1', target: { kind: 'shell', sessionId: 'sh1', ...(name !== undefined ? { name } : {}) } })
    const shell = (p: Partial<SessionSummary> = {}) => sess({ session_id: 'sh1', kind: 'shell', ...p })
    const inner = (p: Partial<SessionSummary> = {}) => sess({ session_id: 'c1', title: 'Resume the import', git_branch: 'feat/import', owned: false, ...p })
    const label = (t: Tab, ...ss: SessionSummary[]) => tabLabels([t], new Map(ss.map((s) => [s.session_id, s])), new Set(), () => 'main').get('t')!

    it('with an agent session Caprock observes in front of its prompt: named after that session, renamed as it', () => {
      const l = label(shellTab(), shell({ program: 'claude', agent_session_id: 'c1' }), inner())
      expect(l).toMatchObject({ title: 'Resume the import', shellName: 'Shell 1', isShell: true, branch: 'feat/import' })
      expect(l.inside?.session_id).toBe('c1')
      expect(l.session?.session_id).toBe('sh1')
      expect(renameOf(l)).toEqual({ kind: 'session', id: 'c1', initial: 'Resume the import', current: '' })
      // A name the user gave the session wins, as on an agent's tab.
      expect(label(shellTab('Builds'), shell({ program: 'claude', agent_session_id: 'c1' }), inner({ name: 'Import' })).title).toBe('Import')
    })

    it('once the agent exits, or the session ended, or the list does not know it: Shell N again', () => {
      expect(label(shellTab(), shell(), inner()).title).toBe('Shell 1')
      expect(label(shellTab(), shell({ program: 'claude', agent_session_id: 'c1' }), inner({ status: 'ended' })).title).toBe('Shell 1 · claude')
      expect(label(shellTab(), shell({ program: 'claude', agent_session_id: 'gone' })).title).toBe('Shell 1 · claude')
      expect(label(shellTab(), shell({ program: 'claude', agent_session_id: 'c1' }), inner({ status: 'ended' })).inside).toBeUndefined()
    })

    it('renamed by the user: called that, its program after it; Rename names the tab, not a session', () => {
      const l = label(shellTab('Builds'), shell({ program: 'npm' }))
      expect(l).toMatchObject({ title: 'Builds · npm', shellName: 'Builds', shellTitle: 'Builds' })
      expect(renameOf(l)).toEqual({ kind: 'shell', id: 'sh1', initial: 'Builds', current: 'Builds' })
      expect(renameOf(label(shellTab(), shell()))).toEqual({ kind: 'shell', id: 'sh1', initial: 'Shell 1', current: '' })
    })

    it('a file, a page and an agent tab rename what they always did', () => {
      const files = tabLabels([tab('f', 'p1', pane('1', 'file', 'file:p1::a.ts', 'a.ts'))], new Map(), new Set(), () => undefined).get('f')
      expect(renameOf(files)).toBeUndefined()
      const agent = tabLabels([tab('a', 'p1', pane('1', 'session', 'c1'))], new Map([['c1', inner({ name: 'Mine' })]]), new Set(), () => undefined).get('a')
      expect(renameOf(agent)).toEqual({ kind: 'session', id: 'c1', initial: 'Mine', current: 'Mine' })
      expect(renameOf(undefined)).toBeUndefined()
    })
  })
})

describe('renamable', () => {
  it('names a session row, never a bare shell’s or nothing', () => {
    expect(renamable(sess({ session_id: 'a' }))).toBe(true)
    expect(renamable(sess({ session_id: 'a' }), true)).toBe(false)
    expect(renamable(sess({ session_id: 'sh', kind: 'shell' }))).toBe(false)
    expect(renamable(undefined)).toBe(false)
  })
})

describe('naming a shell tab in the workspace', () => {
  const ws = (target: Tab['root']) => ({ version: 1 as const, tabs: [tab('t', 'p1', target)], activeByProject: {}, activeProject: 'p1' })
  const nameOf = (w: ReturnType<typeof workspaceReducer>) => (w.tabs[0]!.root.type === 'pane' ? w.tabs[0]!.root.target.name : 'split')

  it('keeps the name on the shell’s pane, tidied; empty takes it off; a stored one survives a reload', () => {
    const named = workspaceReducer(ws(pane('1', 'shell', 'sh1')), { type: 'name-shell', sessionId: 'sh1', name: '  Dev   server ' })
    expect(nameOf(named)).toBe('Dev server')
    expect(parseWorkspace(JSON.stringify(named)).tabs[0]!.root).toMatchObject({ target: { name: 'Dev server' } })
    const cleared = workspaceReducer(named, { type: 'name-shell', sessionId: 'sh1', name: ' ' })
    expect(nameOf(cleared)).toBeUndefined()
    expect('name' in (cleared.tabs[0]!.root as { target: object }).target).toBe(false)
  })

  it('names a shell inside a split, and nothing else', () => {
    const split: Tab['root'] = { type: 'split', id: 's', direction: 'row', sizes: [0.5, 0.5], children: [pane('1', 'session', 'a1'), pane('2', 'shell', 'sh1')] }
    const w = workspaceReducer(ws(split), { type: 'name-shell', sessionId: 'sh1', name: 'Logs' })
    expect(leaves(w.tabs[0]!.root).map((l) => l.target.name)).toEqual([undefined, 'Logs'])
    const same = workspaceReducer(ws(pane('1', 'file', 'f', 'a.ts')), { type: 'name-shell', sessionId: 'f', name: 'x' })
    expect(nameOf(same)).toBeUndefined()
  })
})
