import { describe, expect, it } from 'vitest'
import type { SessionSummary } from './api'
import { AGENT_END_QUESTION, AGENT_SAVED_TOAST, CHAT_CLOSE_QUESTION, agentStillWorking, closeQuestion, closeTitle, closeWord, liveShells, planAgentClose, planChatClose, planClose, planProjectClose, projectCloseQuestion, shellNames } from './closeShell'
import type { PaneLeaf, Tab } from './tabs'

// These read the labels in their macOS spelling; lib/appkeys.test.ts covers
// Windows and Linux.
Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })

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
    expect(closeTitle(false, false, true)).toBe('Close tab (⌘W) — the chat ends')
    expect(closeTitle(false, false, false, true)).toBe('Close tab (⌘W) — keep the agent running or end it')
    expect(closeWord(false, true)).toBe('Close shell')
    expect(closeWord(true, false)).toBe('Close tab')
  })

  it('closing a project: idle shells end, busy ones are asked about in one question, gone ones are skipped', () => {
    const live = liveShells([{ id: 'sh1', program: 'claude' }, { id: 'sh2', program: 'npm' }, { id: 'sh3' }])
    const names = new Map([['sh1', 'Shell 1'], ['sh2', 'Shell 2']])
    const plan = planProjectClose(['sh1', 'sh2', 'sh3', 'gone', 'sh1'], live, names)
    expect(plan.stop).toEqual([{ sessionId: 'sh3', name: 'Shell', program: undefined }])
    expect(plan.busy.map((b) => b.sessionId)).toEqual(['sh1', 'sh2'])
    expect(projectCloseQuestion('alpha', plan.busy)).toBe('alpha: Shell 1 is running claude, Shell 2 is running npm. Stop them and close?')
    expect(projectCloseQuestion('alpha', plan.busy.slice(0, 1))).toBe('alpha: Shell 1 is running claude. Stop it and close?')
  })

  it('names a tabbed shell as its tab does', () => {
    const t1: Tab = { id: 't1', projectId: 'p', title: '', focusedPaneId: 'a', root: pane('a', 'shell', 'sh1') }
    const t2: Tab = { id: 't2', projectId: 'p', title: '', focusedPaneId: 'b', root: pane('b', 'session', 'a1') }
    const names = shellNames([t1, t2], new Map([['t1', { shellName: 'Shell 1' }], ['t2', {}]]))
    expect([...names]).toEqual([['sh1', 'Shell 1']])
  })
})

describe('closing a quick chat', () => {
  const s = (id: string, p: Partial<SessionSummary> = {}) => ({
    session_id: id, cwd: `/data/chats/2026-10-12-00515${id.slice(-1)}`, owned: true, status: 'active', activity: { phrase: '', at: '', health: 'idle' }, ...p,
  }) as SessionSummary
  const isChat = (x: SessionSummary) => x.cwd.includes('/chats/')

  it('ends an idle chat at once and asks about one still answering', () => {
    const sessions = new Map([['c1', s('c1')], ['c2', s('c2', { activity: { phrase: '', at: '', health: 'working' } })]])
    expect(planChatClose(tab(pane('a', 'session', 'c1')), undefined, sessions, isChat)).toEqual({ stop: ['c1'], busy: [] })
    expect(planChatClose(tab(pane('a', 'session', 'c2')), undefined, sessions, isChat)).toEqual({ stop: [], busy: ['c2'] })
    expect(CHAT_CLOSE_QUESTION).toBe('Stop the chat? It is still answering.')
  })

  it('never stops an agent that is not a quick chat, one Caprock did not start, or one that ended', () => {
    const sessions = new Map([
      ['a1', s('a1', { cwd: '/w/app' })],
      ['c3', s('c3', { owned: false })],
      ['c4', s('c4', { status: 'ended' })],
    ])
    for (const id of ['a1', 'c3', 'c4']) {
      expect(planChatClose(tab(pane('a', 'session', id)), undefined, sessions, isChat)).toEqual({ stop: [], busy: [] })
    }
  })

  it('ends a chat this window just started, before the list has it; leaves alone one it knows nothing of', () => {
    expect(planChatClose(tab(pane('a', 'session', 'new1')), undefined, none, isChat, (id) => id === 'new1')).toEqual({ stop: ['new1'], busy: [] })
    expect(planChatClose(tab(pane('a', 'session', 'x')), undefined, none, isChat, (id) => id === 'new1')).toEqual({ stop: [], busy: [] })
  })

  it('closes one pane of a split: only that pane\'s chat', () => {
    const sessions = new Map([['c1', s('c1')], ['a1', s('a1', { cwd: '/w/app' })]])
    const t = tab(pane('a', 'session', 'a1'), pane('b', 'session', 'c1'))
    expect(planChatClose(t, 'a', sessions, isChat)).toEqual({ stop: [], busy: [] })
    expect(planChatClose(t, 'b', sessions, isChat)).toEqual({ stop: ['c1'], busy: [] })
  })
})

// Owner, 2026-10-14: closing an agent's tab may end it, when asked to — but
// only an agent Caprock started (rule 7).
describe('closing an agent Caprock started', () => {
  const s = (id: string, p: Partial<SessionSummary> = {}) => ({
    session_id: id, cwd: '/w/app', owned: true, status: 'active', activity: { phrase: '', at: '', health: 'idle' }, ...p,
  }) as SessionSummary
  const isChat = (x: SessionSummary) => x.cwd.includes('/chats/')

  it('offers an idle agent, and marks one still answering', () => {
    const sessions = new Map([['a1', s('a1')], ['a2', s('a2', { activity: { phrase: '', at: '', health: 'working' } })]])
    expect(planAgentClose(tab(pane('a', 'session', 'a1')), undefined, sessions, isChat)).toEqual({ all: ['a1'], busy: [], active: [] })
    expect(planAgentClose(tab(pane('a', 'session', 'a2')), undefined, sessions, isChat)).toEqual({ all: ['a2'], busy: ['a2'], active: ['a2'] })
    expect(AGENT_END_QUESTION).toBe('End the agent? It is still answering.')
  })

  // Owner, 2026-10-15: closing asks only about an agent working or waiting.
  it('counts one waiting on you, or at a permission prompt, as active: closing asks about it', () => {
    const sessions = new Map([['w1', s('w1', { activity: { phrase: '', at: '', health: 'waiting-on-you' } })], ['p1', s('p1')]])
    expect(planAgentClose(tab(pane('a', 'session', 'w1')), undefined, sessions, isChat)).toEqual({ all: ['w1'], busy: [], active: ['w1'] })
    expect(planAgentClose(tab(pane('a', 'session', 'p1')), undefined, sessions, isChat, (id) => id === 'p1')).toEqual({ all: ['p1'], busy: [], active: ['p1'] })
    expect(agentStillWorking('Fix it', false)).toBe('“Fix it” is still working.')
    expect(AGENT_SAVED_TOAST).toBe('Closed. The conversation is saved — reopen it from History or the sidebar.')
  })

  it('never offers one another terminal started, a shell, a quick chat, an ended one, or one not listed yet', () => {
    const sessions = new Map([
      ['o1', s('o1', { owned: false })],
      ['sh', s('sh', { kind: 'shell' } as Partial<SessionSummary>)],
      ['c1', s('c1', { cwd: '/data/chats/x' })],
      ['e1', s('e1', { status: 'ended' })],
    ])
    for (const id of ['o1', 'sh', 'c1', 'e1', 'unknown']) {
      expect(planAgentClose(tab(pane('a', 'session', id)), undefined, sessions, isChat)).toEqual({ all: [], busy: [], active: [] })
    }
  })

  it('closes one pane of a split: only that pane\'s agent', () => {
    const sessions = new Map([['a1', s('a1')], ['a2', s('a2')]])
    const t = tab(pane('a', 'session', 'a1'), pane('b', 'session', 'a2'))
    expect(planAgentClose(t, 'b', sessions, isChat)).toEqual({ all: ['a2'], busy: [], active: [] })
    expect(planAgentClose(t, undefined, sessions, isChat)).toEqual({ all: ['a1', 'a2'], busy: [], active: [] })
  })
})
