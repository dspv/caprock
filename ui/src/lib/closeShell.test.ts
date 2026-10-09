import { describe, expect, it } from 'vitest'
import type { SessionSummary } from './api'
import { closeQuestion, closeTitle, closeWord, liveShells, planClose } from './closeShell'
import type { PaneLeaf, Tab } from './tabs'

const pane = (id: string, kind: 'session' | 'shell' | 'file', sessionId: string): PaneLeaf => ({ type: 'pane', id, target: { kind, sessionId } })
const tab = (...panes: PaneLeaf[]): Tab => ({
  id: 't1', projectId: 'p', title: 'x', focusedPaneId: panes[0]!.id,
  root: panes.length === 1 ? panes[0]! : { type: 'split', id: 's', direction: 'row', children: panes, sizes: panes.map(() => 1 / panes.length) },
})
const none = new Map<string, SessionSummary>()

describe('closing a shell', () => {
  it('ends an idle shell with its tab, without asking', () => {
    const plan = planClose(tab(pane('a', 'shell', 'sh1')), undefined, none, liveShells([{ id: 'sh1' }]), 'Shell 1')
    expect(plan).toEqual({ stop: [{ sessionId: 'sh1', name: 'Shell 1', program: undefined }], busy: [] })
  })

  it('asks about a shell running a program, by its name and the program', () => {
    const plan = planClose(tab(pane('a', 'shell', 'sh1')), undefined, none, liveShells([{ id: 'sh1', program: 'claude' }]), 'Shell 1')
    expect(plan.stop).toEqual([])
    expect(closeQuestion(plan.busy)).toBe('Shell 1 is running claude. Close and stop it?')
  })

  it('never stops an agent: closing its tab plans nothing', () => {
    const plan = planClose(tab(pane('a', 'session', 'a1')), undefined, none, liveShells([{ id: 'a1', program: 'claude' }]))
    expect(plan).toEqual({ stop: [], busy: [] })
  })

  it('knows a shell that took over an agent tab from the session list', () => {
    const sessions = new Map([['sh9', { session_id: 'sh9', kind: 'shell' } as SessionSummary]])
    const plan = planClose(tab(pane('a', 'session', 'sh9')), undefined, sessions, liveShells([{ id: 'sh9' }]))
    expect(plan.stop.map((s) => s.sessionId)).toEqual(['sh9'])
  })

  it('leaves alone a shell the daemon no longer lists: it already ended, or Caprock did not start it', () => {
    const plan = planClose(tab(pane('a', 'shell', 'gone')), undefined, none, liveShells([]))
    expect(plan).toEqual({ stop: [], busy: [] })
  })

  it('closes one pane of a split: only that pane\'s shell, named generically beside an agent', () => {
    const t = tab(pane('a', 'session', 'a1'), pane('b', 'shell', 'sh1'), pane('c', 'shell', 'sh2'))
    const live = liveShells([{ id: 'sh1', program: 'npm' }, { id: 'sh2' }])
    const one = planClose(t, 'b', none, live, 'Shell 1')
    expect(one).toEqual({ stop: [], busy: [{ sessionId: 'sh1', name: 'The shell', program: 'npm' }] })
    const all = planClose(t, undefined, none, live)
    expect(all.stop.map((s) => s.sessionId)).toEqual(['sh2'])
    expect(all.busy.map((s) => s.sessionId)).toEqual(['sh1'])
  })

  it('asks about several busy shells at once', () => {
    expect(closeQuestion([{ sessionId: 'a', name: 'The shell', program: 'npm' }, { sessionId: 'b', name: 'The shell', program: 'vim' }]))
      .toBe('2 shells are running npm, vim. Close and stop them?')
  })

  it('says what the close button does', () => {
    expect(closeTitle(false, true)).toBe('Close shell (⌘W)')
    expect(closeTitle(false, false)).toBe('Close tab (⌘W) — the agent keeps running')
    expect(closeTitle(true, false)).toBe('Close tab (⌘W)')
    expect(closeWord(false, true)).toBe('Close shell')
    expect(closeWord(true, false)).toBe('Close tab')
  })
})
