import { describe, expect, it } from 'vitest'
import type { SessionSummary } from './api'
import { tabLabels } from './tablabels'
import type { Tab } from './tabs'

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
})
