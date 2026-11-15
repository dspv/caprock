import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JNOW, jarvisFixture } from '@/lib/jarvis.fixture'

const h = vi.hoisted(() => ({
  reads: 0,
  queue: [] as [string, string][],
  spawns: [] as unknown[],
  approvals: [] as [string, boolean][],
  signals: [] as [string, string][],
}))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api,
    jarvis: async () => { h.reads++; return jarvisFixture() },
    queueSend: async (id: string, text: string) => { h.queue.push([id, text]); return { sent: false, queued: true } },
    spawn: async (req: unknown) => { h.spawns.push(req); return { session_id: 'new1' } },
    approve: async (id: string, ok: boolean) => { h.approvals.push([id, ok]) },
    signal: async (id: string, action: string) => { h.signals.push([id, action]) },
    permission: async () => ({ permission: null }),
    agentCatalog: async () => ({ agents: [] }),
    settings: async () => ({}),
    status: async () => ({ claude_available: true }),
  } }
})
vi.mock('@/lib/projects', async (orig) => {
  const actual = await orig<typeof import('@/lib/projects')>()
  return { ...actual, projectsApi: { ...actual.projectsApi, list: async () => [{ id: 'p3', name: 'notes', root: '/w/notes', kind: 'folder' }] } }
})

import { JarvisScreen, JarvisView } from './Jarvis'
import { ScreenShown } from '@/lib/refresh'
import { JARVIS_MUTED_KEY } from '@/lib/jarvis'
import { JARVIS_POLL_MS } from '@/lib/useJarvis'

afterEach(() => {
  h.reads = 0; h.queue = []; h.spawns = []; h.approvals = []; h.signals = []
  localStorage.clear()
  vi.useRealTimers()
})

const view = (onOpenSession = vi.fn()) => render(<JarvisView digest={jarvisFixture()} now={JNOW} onOpenSession={onOpenSession} />)
const need = (kind: string, id: string) => document.querySelector(`[data-jarvis-need="${kind}"][data-session="${id}"]`) as HTMLElement
const agentRow = (id: string) => document.querySelector(`[data-jarvis-agent="${id}"]`) as HTMLElement
const command = () => screen.getByLabelText('Command: @project, then what to do') as HTMLInputElement

describe('Jarvis', () => {
  it('draws the headline, the chips, needs you most urgent first and one row per agent', () => {
    view()
    expect(document.querySelector('[data-jarvis-headline]')).toHaveTextContent('3 working · 2 waiting for you · 101 sessions today · $101')
    expect([...document.querySelectorAll('[data-jarvis-chip]')].map((c) => c.getAttribute('data-jarvis-chip'))).toEqual(['caprock', 'caprock-web', 'notes'])
    expect([...document.querySelectorAll('[data-jarvis-need]')].map((n) => n.getAttribute('data-jarvis-need'))).toEqual(['permission', 'question', 'approval', 'loop', 'question'])
    const a1 = agentRow('a1')
    expect(a1).toHaveAttribute('data-state', 'waiting')
    expect(a1).toHaveTextContent('Asking to run npm test')
    expect(a1.querySelector('[data-jarvis-plan]')).toHaveTextContent('3/8 · Write the tests')
    expect(a1.querySelectorAll('.jarvis-seg[data-filled]')).toHaveLength(3)
    expect(a1).toHaveTextContent('$4.20')
    expect(a1).toHaveTextContent('2m ago')
    // No plan, no bar.
    expect(agentRow('a2').querySelector('[data-jarvis-plan]')).toBeNull()
  })

  it('opens a session from its title', () => {
    const open = vi.fn()
    view(open)
    fireEvent.click(within(agentRow('a4')).getByRole('button', { name: /Fix CI/ }))
    expect(open).toHaveBeenCalledWith('a4')
  })

  it('mutes a project everywhere on the screen, keeps it muted on the next visit, and brings it back', async () => {
    const { unmount } = view()
    fireEvent.click(screen.getByRole('button', { name: 'Mute caprock-web' }))
    expect(agentRow('a4')).toBeNull()
    // It collapses away, then is gone.
    await waitFor(() => expect(need('loop', 'a4')).toBeNull())
    // A task runner's approval belongs to no project: muting one leaves it.
    expect(need('approval', '')).not.toBeNull()
    expect(document.querySelector('[data-jarvis-chip="caprock-web"]')).toHaveAttribute('data-muted')
    expect(localStorage.getItem(JARVIS_MUTED_KEY)).toBe('["caprock-web"]')
    unmount()
    view()
    expect(agentRow('a4')).toBeNull()
    fireEvent.click(document.querySelector('[data-jarvis-chip="caprock-web"]') as HTMLElement)
    expect(agentRow('a4')).not.toBeNull()
    expect(localStorage.getItem(JARVIS_MUTED_KEY)).toBeNull()
  })

  it('a session Caprock did not start offers Open only: no reply, no message, no stop', () => {
    view()
    const n = need('question', 'x1')
    expect(n).toHaveAttribute('data-controllable', 'false')
    expect(n.querySelector('[data-jarvis-reply]')).toBeNull()
    expect(within(n).getByRole('button', { name: 'Open terminal' })).toHaveAttribute('title', expect.stringContaining('did not start this session'))
    const r = agentRow('x1')
    expect(within(r).queryByRole('button', { name: 'Message' })).toBeNull()
    expect(r.querySelector('[data-jarvis-stop]')).toBeNull()
    expect(within(r).getByRole('button', { name: 'Open' })).toBeInTheDocument()
    // Caprock's own rows have all three.
    expect(within(agentRow('a2')).getByRole('button', { name: 'Message' })).toBeInTheDocument()
    expect(agentRow('a2').querySelector('[data-jarvis-stop]')).not.toBeNull()
  })

  it('answers a question through the queue, an approval through the task approvals, and stops on the second press', async () => {
    view()
    const q = need('question', 'a2')
    fireEvent.change(within(q).getByLabelText('Message'), { target: { value: 'v0.176.0' } })
    fireEvent.click(within(q).getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(h.queue).toEqual([['a2', 'v0.176.0']]))
    // It names no session: its title opens Tasks.
    expect(within(need('approval', '')).getByRole('link', { name: 'Task to approve: Pricing page' })).toHaveAttribute('href', '#/tasks')
    fireEvent.click(within(need('approval', '')).getByRole('button', { name: 'Deny' }))
    await waitFor(() => expect(h.approvals).toEqual([['t9', false]]))
    const stop = need('loop', 'a4').querySelector('[data-jarvis-stop]') as HTMLElement
    fireEvent.click(stop)
    expect(stop).toHaveTextContent('Stop?')
    expect(h.signals).toEqual([])
    fireEvent.click(stop)
    await waitFor(() => expect(h.signals).toEqual([['a4', 'kill']]))
  })

  it('sends @project text to the project’s most recently active agent, through the queue', async () => {
    view()
    fireEvent.change(command(), { target: { value: '@caprock run the tests' } })
    fireEvent.keyDown(command(), { key: 'Enter' })
    await waitFor(() => expect(h.queue).toEqual([['a2', 'run the tests']]))
    expect(h.spawns).toEqual([])
    expect(await screen.findByRole('status')).toHaveTextContent('the most recently active of 2: Release notes')
  })

  it('starts a new session in the folder when the project has no agent Caprock started', async () => {
    view()
    await act(async () => {})
    fireEvent.change(command(), { target: { value: '@notes tidy the inbox' } })
    fireEvent.keyDown(command(), { key: 'Enter' })
    await waitFor(() => expect(h.spawns).toHaveLength(1))
    expect(h.spawns[0]).toMatchObject({ cwd: '/w/notes', prompt: 'tidy the inbox' })
    expect(h.queue).toEqual([])
  })

  it('says to start with @project, and completes a project name after @', () => {
    view()
    fireEvent.change(command(), { target: { value: 'do something' } })
    fireEvent.keyDown(command(), { key: 'Enter' })
    expect(screen.getByRole('status')).toHaveTextContent('Start with @project')
    fireEvent.change(command(), { target: { value: '@caprock-w' } })
    expect(screen.getByRole('option', { name: '@caprock-web' })).toBeInTheDocument()
    fireEvent.keyDown(command(), { key: 'Tab' })
    expect(command().value).toBe('@caprock-web ')
  })

  it('offers Continue on a turn stopped on an error, and fades what has waited over 12 hours', async () => {
    const d = jarvisFixture()
    d.needs_you = [
      { kind: 'question', session_id: 'a2', project: 'caprock', title: 'Stopped: rate limit', since: JNOW - 60_000, controllable: true },
      { kind: 'permission', session_id: 'a1', project: 'caprock', title: 'Wants to run: npm test', since: JNOW - 13 * 3600_000, controllable: true },
    ]
    render(<JarvisView digest={d} now={JNOW} />)
    fireEvent.click(within(need('question', 'a2')).getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(h.queue).toEqual([['a2', 'continue']]))
    expect(need('permission', 'a1')).toHaveAttribute('data-old', 'true')
    expect(need('question', 'a2')).not.toHaveAttribute('data-old')
    expect(need('permission', 'a1')).toHaveTextContent('13h ago')
  })

  // On the owner's machine 13 of 16 live rows were agents done hours ago.
  it('folds agents idle for over 30 minutes into one line, and shows them on a click', () => {
    const d = jarvisFixture()
    const base = d.agents[0]!
    d.agents = [
      { ...base, session_id: 'w1', state: 'working', last_activity_at: JNOW - 60_000 },
      { ...base, session_id: 'i1', state: 'idle', now: 'Done', last_activity_at: JNOW - 5 * 60_000 },
      { ...base, session_id: 'i2', state: 'idle', now: 'Done', last_activity_at: JNOW - 3 * 3_600_000 },
      { ...base, session_id: 'i3', state: 'idle', now: 'Done', last_activity_at: JNOW - 26 * 3_600_000 },
    ]
    render(<JarvisView digest={d} now={JNOW} />)
    expect(agentRow('w1')).toBeTruthy()
    expect(agentRow('i1')).toBeTruthy()
    expect(agentRow('i2')).toBeNull()
    const toggle = document.querySelector('[data-jarvis-idle-toggle]') as HTMLElement
    expect(toggle.textContent).toBe('Show 2 finished over 30 minutes ago')
    fireEvent.click(toggle)
    expect(agentRow('i2')).toBeTruthy()
    expect(agentRow('i3')).toBeTruthy()
    expect(toggle.textContent).toBe('Hide 2 finished over 30 minutes ago')
  })

  it('leads with a plain summary, always shows Needs you, and groups working agents by project', () => {
    const d = jarvisFixture()
    const base = d.agents[0]!
    d.needs_you = []
    d.agents = [
      { ...base, session_id: 'w1', project: 'alpha', state: 'working', last_activity_at: JNOW - 60_000 },
      { ...base, session_id: 'w2', project: 'beta', state: 'working', last_activity_at: JNOW - 60_000 },
      { ...base, session_id: 'w3', project: 'alpha', state: 'working', last_activity_at: JNOW - 90_000 },
      { ...base, session_id: 'i1', project: 'beta', state: 'idle', now: 'Done', last_activity_at: JNOW - 5 * 60_000 },
    ]
    render(<JarvisView digest={d} now={JNOW} />)
    expect(document.querySelector('[data-jarvis-summary]')).toHaveTextContent('3 agents are working, in alpha, beta; nothing needs you. 1 finished and waits for a next task.')
    expect(document.querySelector('[data-jarvis-needs-none]')).toHaveTextContent('Nothing needs you right now.')
    const groups = [...document.querySelectorAll('[data-jarvis-project]')].map((g) => [g.getAttribute('data-jarvis-project'), g.querySelectorAll('[data-jarvis-agent]').length])
    expect(groups).toEqual([['alpha', 2], ['beta', 1]])
    expect(document.querySelector('[data-jarvis-done] [data-jarvis-agent="i1"]')).toBeTruthy()
  })

  it('says one calm line when nothing runs', () => {
    render(<JarvisView digest={{ ...jarvisFixture(), agents: [], needs_you: [] }} now={JNOW} />)
    expect(document.querySelector('[data-jarvis-empty]')).toHaveTextContent('Nothing running. Start something: @project what to do')
    expect(command()).toBeInTheDocument()
  })

  it('reads every few seconds while shown, and nothing while hidden', async () => {
    vi.useFakeTimers()
    const { rerender } = render(<ScreenShown.Provider value={true}><JarvisScreen /></ScreenShown.Provider>)
    await act(async () => {})
    expect(h.reads).toBe(1)
    await act(async () => { vi.advanceTimersByTime(JARVIS_POLL_MS) })
    expect(h.reads).toBe(2)
    rerender(<ScreenShown.Provider value={false}><JarvisScreen /></ScreenShown.Provider>)
    await act(async () => { vi.advanceTimersByTime(JARVIS_POLL_MS * 3) })
    expect(h.reads).toBe(2)
  })
})
