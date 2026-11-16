import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JNOW, jarvisFixture } from '@/lib/jarvis.fixture'

const h = vi.hoisted(() => ({
  reads: 0,
  queue: [] as [string, string][],
  spawns: [] as unknown[],
  approvals: [] as [string, boolean][],
  signals: [] as [string, string][],
  said: [] as unknown[],
  answers: [] as [string, unknown][],
  answerStatus: 0,
  sayStatus: 0,
  perm: {} as Record<string, unknown>,
  permAnswers: [] as [string, string, string][],
  handled: [] as unknown[],
  thread: [] as unknown[],
  continued: [] as [string, string][],
  saved: [] as unknown[],
  dict: null as null | { onText: (t: string) => void; onEnd: (e?: string) => void; stopped: number },
}))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api,
    jarvis: async () => { h.reads++; return jarvisFixture() },
    queueSend: async (id: string, text: string) => { h.queue.push([id, text]); return { sent: false, queued: true } },
    spawn: async (req: unknown) => { h.spawns.push(req); return { session_id: 'new1' } },
    approve: async (id: string, ok: boolean) => { h.approvals.push([id, ok]) },
    signal: async (id: string, action: string) => { h.signals.push([id, action]) },
    permission: async (id: string) => ({ permission: h.perm[id] ?? null }),
    answerPermission: async (id: string, pid: string, choice: string) => { h.permAnswers.push([id, pid, choice]) },
    jarvisAnswer: async (id: string, a: unknown) => {
      if (h.answerStatus) throw new actual.ApiError(h.answerStatus, `${h.answerStatus}`)
      h.answers.push([id, a]); return { ok: true }
    },
    jarvisSay: async (req: { text: string; project?: string; via?: string }) => {
      if (h.sayStatus) throw new actual.ApiError(h.sayStatus, `${h.sayStatus}`)
      h.said.push(req)
      return {
        message: { id: 100 + h.said.length, at: JNOW, role: 'user', text: req.text, project: req.project, via: req.via },
        replies: [{ id: 200 + h.said.length, at: JNOW, role: 'jarvis', text: `Gave it to the agent in ${req.project}.`, project: req.project, session_id: 'a2' }],
        actions: [{ kind: 'sent', session_id: 'a2', project: req.project }],
      }
    },
    jarvisThread: async () => ({ messages: h.thread }),
    jarvisHandled: async () => ({ items: h.handled }),
    continueOn: async (id: string, target: string) => { h.continued.push([id, target]); return { session_id: 'back1', cwd: '/w', continued_from: id, target, from: 'codex', how: 'resume', same_conversation: true, stopped_original: true } },
    saveSettings: async (s: unknown) => { h.saved.push(s); return s },
    subscriptions: async () => ({ agents: [
      { agent: 'claude', label: 'Claude Code', installed: true, subscriptions: [
        { id: 'default', agent: 'claude', label: 'Personal', default: true, dir: '~/.claude', signed_in: true, login_command: '', windows: [], sessions_7d: 0, cost_7d_usd: 0, running: 0 },
        { id: 'work', agent: 'claude', label: 'Work', default: false, dir: '~/.claude-work', signed_in: false, login_command: '', windows: [], sessions_7d: 0, cost_7d_usd: 0, running: 0 },
      ] },
      { agent: 'codex', label: 'Codex', installed: true, subscriptions: [
        { id: 'default', agent: 'codex', label: 'Codex', default: true, dir: '~/.codex', signed_in: true, login_command: '', windows: [], sessions_7d: 0, cost_7d_usd: 0, running: 0 },
      ] },
    ], licensed: true, free_per_agent: 1 }),
    agentCatalog: async () => ({ agents: [] }),
    settings: async () => ({}),
    status: async () => ({ claude_available: true }),
  } }
})
vi.mock('@/lib/live', async (orig) => {
  const actual = await orig<typeof import('@/lib/live')>()
  return { ...actual, useLiveConn: () => 'open' }
})
vi.mock('@/lib/speech', async (orig) => {
  const actual = await orig<typeof import('@/lib/speech')>()
  return { ...actual, speechSupport: () => 'ok',
    startDictation: ({ onText, onEnd }: { onText: (t: string) => void; onEnd: (e?: string) => void }) => {
      const d = { onText, onEnd, stopped: 0 }
      h.dict = d
      return { stop: () => { d.stopped++ } }
    } }
})
vi.mock('@/lib/projects', async (orig) => {
  const actual = await orig<typeof import('@/lib/projects')>()
  return { ...actual, projectsApi: { ...actual.projectsApi, list: async () => [{ id: 'p3', name: 'notes', root: '/w/notes', kind: 'folder' }] } }
})

import { JarvisScreen, JarvisView } from './Jarvis'
import { ScreenShown } from '@/lib/refresh'
import { JARVIS_BRAIN_LATER_KEY, JARVIS_LATER_KEY, JARVIS_MUTED_KEY, LATER_MS } from '@/lib/jarvis'
import { live, type Frame } from '@/lib/live'
import type { HandledItem, JarvisDigest, JarvisNeed } from '@/lib/api'
import { JARVIS_POLL_MS } from '@/lib/useJarvis'

afterEach(() => {
  h.reads = 0; h.queue = []; h.spawns = []; h.approvals = []; h.signals = []
  h.said = []; h.answers = []; h.answerStatus = 0; h.sayStatus = 0; h.perm = {}; h.permAnswers = []
  h.handled = []; h.thread = []; h.continued = []; h.saved = []; h.dict = null
  localStorage.clear()
  vi.useRealTimers()
})

const view = (onOpenSession = vi.fn()) => render(<JarvisView digest={jarvisFixture()} now={JNOW} onOpenSession={onOpenSession} />)
const need = (kind: string, id: string) => document.querySelector(`[data-jarvis-need="${kind}"][data-session="${id}"]`) as HTMLElement
const agentRow = (id: string) => document.querySelector(`[data-jarvis-agent="${id}"]`) as HTMLElement
const command = () => screen.getByLabelText('Message to Jarvis') as HTMLInputElement
/** A frame as the live socket hands it to every subscriber. */
const emit = (f: Frame) => act(() => { for (const fn of (live as unknown as { frameSubs: Set<(f: Frame) => void> }).frameSubs) fn(f) })
const withNeeds = (needs: JarvisNeed[], extra: Partial<JarvisDigest> = {}): JarvisDigest => ({ ...jarvisFixture(), needs_you: needs, ...extra })
const question = (extra: Partial<JarvisNeed> = {}): JarvisNeed => ({
  kind: 'question', session_id: 'a2', project: 'caprock', title: 'Where should the share card images be stored?', detail: 'Where should the share card images be stored?\nLocal disk · R2 bucket (Recommended)',
  since: JNOW - 240_000, controllable: true, answerable: true,
  options: [
    { label: 'Local disk', description: 'Nothing leaves the Mac', recommended: false },
    { label: 'R2 bucket (Recommended)', description: 'Same bucket as the backups', recommended: true },
  ],
  ...extra,
})

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

  it('on a daemon without the chat (404), sends @project text to the project’s most recently active agent, through the queue', async () => {
    h.sayStatus = 404
    view()
    fireEvent.change(command(), { target: { value: '@caprock run the tests' } })
    fireEvent.keyDown(command(), { key: 'Enter' })
    await waitFor(() => expect(h.queue).toEqual([['a2', 'run the tests']]))
    expect(h.spawns).toEqual([])
    expect(await screen.findByText(/the most recently active of 2: Release notes/)).toBeInTheDocument()
  })

  it('on a daemon without the chat (404), starts a new session in the folder when the project has no agent Caprock started', async () => {
    h.sayStatus = 404
    view()
    await act(async () => {})
    fireEvent.change(command(), { target: { value: '@notes tidy the inbox' } })
    fireEvent.keyDown(command(), { key: 'Enter' })
    await waitFor(() => expect(h.spawns).toHaveLength(1))
    expect(h.spawns[0]).toMatchObject({ cwd: '/w/notes', prompt: 'tidy the inbox' })
    expect(h.queue).toEqual([])
  })

  it('says when an @project is unknown, and completes a project name after @', () => {
    view()
    fireEvent.change(command(), { target: { value: '@nowhere do something' } })
    expect(document.querySelector('[data-jarvis-to]')).toHaveTextContent('No project nowhere')
    fireEvent.keyDown(command(), { key: 'Enter' })
    expect(screen.getByRole('status')).toHaveTextContent('No project named nowhere')
    expect(h.said).toEqual([])
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
    expect(document.querySelector('[data-jarvis-empty]')).toHaveTextContent('Nothing running. Say what to start below, or @project what to do.')
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

describe('Jarvis V2: decision cards', () => {
  it('draws a question’s options, the recommended one first with a star and without “(Recommended)”, and one tap answers it', async () => {
    render(<JarvisView digest={withNeeds([question()])} now={JNOW} />)
    const card = need('question', 'a2')
    expect(card).toHaveAttribute('data-answerable', 'true')
    expect(card.querySelector('[data-jarvis-question]')).toHaveTextContent('Where should the share card images be stored?')
    const opts = [...card.querySelectorAll('[data-jarvis-option]')]
    expect(opts.map((o) => o.getAttribute('data-jarvis-option'))).toEqual(['1', '0'])
    expect(opts[0]).toHaveAttribute('data-recommended', 'true')
    expect(opts[0]).toHaveTextContent('★R2 bucketSame bucket as the backups')
    expect(card).not.toHaveTextContent('(Recommended)')
    // No reply box on a card a tap answers.
    expect(card.querySelector('[data-jarvis-reply]')).toBeNull()
    fireEvent.click(opts[0] as HTMLElement)
    await waitFor(() => expect(h.answers).toEqual([['a2', { option: 1 }]]))
    expect(await within(card).findByText('✓ Answered “R2 bucket”. Sent to the agent; it carries on.')).toBeInTheDocument()
    expect(card.querySelector('[data-jarvis-option]')).toBeNull()
  })

  it('types a free answer through Something else…, and says so when the dialog is gone (409)', async () => {
    render(<JarvisView digest={withNeeds([question()])} now={JNOW} />)
    const card = need('question', 'a2')
    fireEvent.click(within(card).getByRole('button', { name: /Something else/ }))
    fireEvent.change(within(card).getByLabelText('Your answer'), { target: { value: 'Both' } })
    fireEvent.click(within(card).getByRole('button', { name: 'Answer' }))
    await waitFor(() => expect(h.answers).toEqual([['a2', { text: 'Both' }]]))
    cleanup()
    h.answerStatus = 409
    render(<JarvisView digest={withNeeds([question()])} now={JNOW} />)
    fireEvent.click(need('question', 'a2').querySelector('[data-jarvis-option="0"]') as HTMLElement)
    expect(await screen.findByRole('alert')).toHaveTextContent('no longer on the agent’s screen')
  })

  it('keeps the reply box for a question a tap cannot answer: several questions, several answers, not ours', () => {
    render(<JarvisView digest={withNeeds([
      question({ more_questions: 2 }),
      question({ session_id: 'a1', answerable: false }),
      question({ session_id: 'x1', project: 'caprock-web', controllable: false, answerable: false }),
    ])} now={JNOW} />)
    const several = need('question', 'a2')
    expect(several).not.toHaveAttribute('data-answerable')
    expect(several).toHaveTextContent('This dialog asks 2 more questions')
    expect(several.querySelector('[data-jarvis-reply]')).not.toBeNull()
    expect(need('question', 'a1')).toHaveTextContent('several answers can be picked')
    const theirs = need('question', 'x1')
    expect(theirs.querySelector('[data-jarvis-option]')).toBeNull()
    expect(theirs.querySelector('[data-jarvis-reply]')).toBeNull()
    expect(within(theirs).getByRole('button', { name: 'Open terminal' })).toHaveAttribute('title', expect.stringContaining('did not start'))
  })

  it('answers a permission with one tap, and a plan (ExitPlanMode) with Approve and start', async () => {
    h.perm = {
      a1: { id: 'p1', tool: 'Bash', detail: 'git push origin main', always: 'Yes, and don’t ask again for git push', since: '' },
      a4: { id: 'p4', tool: 'ExitPlanMode', detail: '1. Explain the price\n2. Add a test', since: '' },
    }
    render(<JarvisView digest={withNeeds([
      { kind: 'permission', session_id: 'a1', project: 'caprock', title: 'Jarvis screen', detail: 'git push origin main', since: JNOW - 60_000, controllable: true },
      { kind: 'question', session_id: 'a4', project: 'caprock-web', title: 'Plan to approve', since: JNOW - 60_000, controllable: true },
    ])} now={JNOW} />)
    const perm = need('permission', 'a1')
    expect(await within(perm).findByText('git push origin main', { selector: 'code' })).toBeInTheDocument()
    expect(within(perm).getByRole('button', { name: 'Yes, and don’t ask again for git push' })).toBeInTheDocument()
    // A permission is never dismissed: only Later.
    expect(within(perm).queryByRole('button', { name: 'Dismiss' })).toBeNull()
    fireEvent.click(within(perm).getByRole('button', { name: 'Allow' }))
    await waitFor(() => expect(h.permAnswers).toEqual([['a1', 'p1', 'allow']]))
    expect(await within(perm).findByText('✓ Allowed. Sent to the agent; it carries on.')).toBeInTheDocument()
    const plan = need('question', 'a4')
    await waitFor(() => expect(plan.querySelector('span.text-warn')).toHaveTextContent('Plan to approve'))
    fireEvent.click(await within(plan).findByRole('button', { name: /Approve and start/ }))
    await waitFor(() => expect(h.permAnswers).toContainEqual(['a4', 'p4', 'allow']))
    expect(plan.querySelector('[data-jarvis-reply]')).toBeNull()
  })

  it('Later hides a card for an hour, per browser, with Undo; Dismiss until it changes; the hidden ones are a click away', async () => {
    const d = withNeeds([question(), question({ session_id: 'a1', title: 'Other agent' })])
    const { unmount } = render(<JarvisView digest={d} now={JNOW} />)
    fireEvent.click(within(need('question', 'a2')).getByRole('button', { name: 'Later' }))
    expect(screen.getByRole('status')).toHaveTextContent('Hidden for an hour')
    await waitFor(() => expect(need('question', 'a2')).toBeNull())
    const stored = JSON.parse(localStorage.getItem(JARVIS_LATER_KEY) ?? '{}') as Record<string, number>
    expect(Object.keys(stored)).toEqual(['question:a2:'])
    expect(stored['question:a2:']).toBeGreaterThanOrEqual(JNOW + LATER_MS)
    expect(document.querySelector('[data-jarvis-needs] h2')).toHaveTextContent('Needs you · 1')
    // Undo brings it straight back.
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(need('question', 'a2')).not.toBeNull()
    fireEvent.click(within(need('question', 'a1')).getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(need('question', 'a1')).toBeNull())
    unmount()
    // Still dismissed on the next visit; a changed question comes back.
    render(<JarvisView digest={d} now={JNOW} />)
    expect(need('question', 'a1')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show 1 hidden' }))
    expect(need('question', 'a1')).toHaveAttribute('data-hidden', 'true')
    fireEvent.click(within(need('question', 'a1')).getByRole('button', { name: 'Show again' }))
    expect(need('question', 'a1')).not.toHaveAttribute('data-hidden')
    cleanup()
    fireEvent.click(document.body)
    render(<JarvisView digest={withNeeds([question({ session_id: 'a1', detail: 'A new question' })])} now={JNOW} />)
    expect(need('question', 'a1')).not.toBeNull()
  })

  it('survives storage that throws', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    try {
      render(<JarvisView digest={withNeeds([question()])} now={JNOW} />)
      fireEvent.click(within(need('question', 'a2')).getByRole('button', { name: 'Later' }))
      expect(screen.getByRole('status')).toHaveTextContent('Hidden for an hour')
    } finally { get.mockRestore(); set.mockRestore() }
  })
})

const handled = (n: number): HandledItem[] => Array.from({ length: n }, (_, i) => ({
  id: i + 1, at: JNOW - (i + 1) * 60_000, kind: 'end_done', session_id: `s${i}`, project: 'caprock', text: `caprock · agent ${i + 1} finished — ended it to free memory`,
}))

describe('Jarvis V2: Handled for you', () => {
  it('lists what Caprock did today, open while short, with Undo for a limit move and the count in the summary', async () => {
    h.handled = [
      { id: 9, at: JNOW - 30_000, kind: 'limit_switch', session_id: 'c1', project: 'caprock-ops', text: 'caprock-ops hit the Claude limit — continued on Codex with the same conversation', undo: { kind: 'continue_on', session_id: 'c2' } },
      { id: 8, at: JNOW - 90_000, kind: 'auto_answer', session_id: 'a2', project: 'caprock', text: 'Answered “Run the tests first?” with “Yes”', reason: 'Routine: the agent recommended it and nothing leaves the machine' },
    ]
    render(<JarvisView digest={{ ...jarvisFixture(), handled_today: 2 }} now={JNOW} />)
    expect(document.querySelector('[data-jarvis-summary]')).toHaveTextContent('I handled 2 things myself today.')
    const box = await waitFor(() => { const b = document.querySelector('[data-jarvis-handled]'); expect(b).not.toBeNull(); return b as HTMLElement })
    expect(within(box).getByRole('button', { name: /Handled for you today/ })).toHaveAttribute('aria-expanded', 'true')
    expect(box).toHaveTextContent('Routine: the agent recommended it')
    fireEvent.click(within(box).getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(h.continued).toEqual([['c2', 'default']]))
    expect(await within(box).findByText('Undone: continued back.')).toBeInTheDocument()
    fireEvent.click(within(box).getByRole('button', { name: 'Open' }))
  })

  it('folds a long list to one line with the count, takes live items, and draws nothing when empty', async () => {
    h.handled = handled(7)
    const { unmount } = render(<JarvisView digest={{ ...jarvisFixture(), handled_today: 7 }} now={JNOW} />)
    const toggle = await screen.findByRole('button', { name: /Handled for you today/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveTextContent('7')
    emit({ type: 'jarvis', data: { op: 'handled', item: { id: 50, at: JNOW, kind: 'morning', text: 'Sent the morning summary to Telegram' } } })
    expect(toggle).toHaveTextContent('8')
    fireEvent.click(toggle)
    expect(screen.getByText('Sent the morning summary to Telegram')).toBeInTheDocument()
    unmount()
    h.handled = []
    render(<JarvisView digest={jarvisFixture()} now={JNOW} />)
    await act(async () => {})
    expect(document.querySelector('[data-jarvis-handled]')).toBeNull()
    expect(document.querySelector('[data-jarvis-summary]')).not.toHaveTextContent('handled')
  })
})

describe('Jarvis V2: the chat', () => {
  it('says where a message goes before it is sent: @project, else the chip picked, else the project worked in last', async () => {
    view()
    const to = () => document.querySelector('[data-jarvis-to]')
    // a2 in caprock has the newest activity.
    expect(to()).toHaveTextContent('→ caprock')
    fireEvent.change(command(), { target: { value: '@caprock-web write a page' } })
    expect(to()).toHaveTextContent('→ caprock-web')
    fireEvent.change(command(), { target: { value: 'write a page' } })
    fireEvent.click(within(document.querySelector('[data-jarvis-chip="notes"]') as HTMLElement).getByRole('button', { name: 'notes' }))
    expect(to()).toHaveTextContent('→ notes')
    fireEvent.keyDown(command(), { key: 'Enter' })
    await waitFor(() => expect(h.said).toEqual([{ text: 'write a page', project: 'notes', via: 'text' }]))
    // The thread: what was said, where, and Jarvis's reply with Open.
    const mine = await waitFor(() => { const m = document.querySelector('[data-jarvis-msg="user"]'); expect(m).not.toBeNull(); return m as HTMLElement })
    expect(mine).toHaveTextContent('write a page')
    expect(mine).toHaveTextContent('to notes')
    expect(document.querySelector('[data-jarvis-msg="jarvis"]')).toHaveTextContent('Gave it to the agent in notes.')
    expect(command().value).toBe('')
  })

  it('sends an @mention without the mention, and shows pending and Done replies from the thread and the live socket', async () => {
    h.thread = [
      { id: 1, at: JNOW - 60_000, role: 'user', text: '@caprock-web write a page comparing Cursor and Claude Code', project: 'caprock-web' },
      { id: 2, at: JNOW - 50_000, role: 'jarvis', text: '', pending: true },
    ]
    view()
    expect(await screen.findByText('Thinking…')).toBeInTheDocument()
    emit({ type: 'jarvis', data: { op: 'thread', message: { id: 2, at: JNOW - 50_000, role: 'jarvis', text: 'Started a new one in caprock-web.' } } })
    expect(screen.queryByText('Thinking…')).toBeNull()
    emit({ type: 'jarvis', data: { op: 'thread', message: { id: 3, at: JNOW, role: 'jarvis', text: 'Done: "SEO page" in caprock-web finished. Last words: "Draft written."', session_id: 'a4' } } })
    const done = document.querySelector('[data-jarvis-msg="jarvis"][data-done="true"]') as HTMLElement
    expect(done).toHaveTextContent('Done: "SEO page" in caprock-web finished.')
    fireEvent.change(command(), { target: { value: '@caprock-web ship it' } })
    fireEvent.keyDown(command(), { key: 'Enter' })
    await waitFor(() => expect(h.said).toEqual([{ text: 'ship it', project: 'caprock-web', via: 'text' }]))
  })

  it('a send that fails keeps the message, marked Not sent', async () => {
    h.sayStatus = 500
    view()
    fireEvent.change(command(), { target: { value: 'run the tests' } })
    fireEvent.keyDown(command(), { key: 'Enter' })
    expect(await screen.findByText(/^Not sent:/)).toBeInTheDocument()
  })
})

describe('Jarvis V2: hold to talk', () => {
  // jsdom is no Mac: the key is spelled as Windows and Linux spell it, Ctrl+Shift+Space.
  it('listens while the key is held, shows the words, and sends them on release as voice', async () => {
    view()
    fireEvent.keyDown(document, { code: 'Space', key: ' ', ctrlKey: true, shiftKey: true })
    expect(h.dict).not.toBeNull()
    expect(screen.getByText(/Listening… release to send · Esc cancels/)).toBeInTheDocument()
    act(() => h.dict!.onText('run the tests in caprock'))
    expect(command().value).toBe('run the tests in caprock')
    fireEvent.keyUp(document, { code: 'Space', key: ' ' })
    expect(h.dict!.stopped).toBe(1)
    act(() => h.dict!.onEnd())
    await waitFor(() => expect(h.said).toEqual([{ text: 'run the tests in caprock', project: 'caprock', via: 'voice' }]))
  })

  it('Esc cancels: nothing is sent and the field is put back', async () => {
    view()
    fireEvent.change(command(), { target: { value: 'draft' } })
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Hold to talk' }))
    act(() => h.dict!.onText('never mind'))
    expect(command().value).toBe('draft never mind')
    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' })
    // Letting go of the mic right after Esc must not turn the cancel into a send.
    fireEvent.pointerUp(screen.getByRole('button', { name: 'Hold to talk' }))
    act(() => h.dict!.onEnd())
    await act(async () => {})
    expect(command().value).toBe('draft')
    expect(h.said).toEqual([])
  })

  it('the mic button is press-and-hold; Alt+Space alone does nothing off macOS', async () => {
    view()
    fireEvent.keyDown(document, { code: 'Space', key: ' ', altKey: true })
    expect(h.dict).toBeNull()
    const mic = screen.getByRole('button', { name: 'Hold to talk' })
    fireEvent.pointerDown(mic)
    act(() => h.dict!.onText('status please'))
    fireEvent.pointerUp(mic)
    act(() => h.dict!.onEnd())
    await waitFor(() => expect(h.said).toEqual([{ text: 'status please', project: 'caprock', via: 'voice' }]))
  })
})

describe('Jarvis V2: the brain', () => {
  const unchosen = { state: 'unchosen' as const, auto_answer: 'routine' as const }

  it('asks once, saying what is sent where, and one click uses the Claude subscription', async () => {
    render(<JarvisView digest={{ ...jarvisFixture(), brain: unchosen }} now={JNOW} />)
    const card = document.querySelector('[data-jarvis-brain-card]') as HTMLElement
    expect(card).toHaveTextContent('What is sent where: Your message, the Needs you list and your agents’ titles go to the subscription you pick')
    expect(card).toHaveTextContent('Nothing goes to Caprock.')
    fireEvent.click(within(card).getByRole('button', { name: 'Use my Claude subscription' }))
    await waitFor(() => expect(h.saved).toEqual([{ jarvis_brain: { agent: 'claude', auto_answer: 'routine' } }]))
  })

  it('Not now hides the card for a week, per browser', () => {
    const { unmount } = render(<JarvisView digest={{ ...jarvisFixture(), brain: unchosen }} now={JNOW} />)
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(document.querySelector('[data-jarvis-brain-card]')).toBeNull()
    expect(Number(localStorage.getItem(JARVIS_BRAIN_LATER_KEY))).toBeGreaterThan(Date.now() + 6 * 24 * 3600_000)
    unmount()
    render(<JarvisView digest={{ ...jarvisFixture(), brain: unchosen }} now={JNOW} />)
    expect(document.querySelector('[data-jarvis-brain-card]')).toBeNull()
    // Its state stays in the top line.
    expect(document.querySelector('[data-jarvis-brain]')).toHaveTextContent('Brain: not set up')
  })

  it('Choose… picks Codex and turns auto-answer off; the top line shows the state and a signed-out one links to its fix', async () => {
    const { unmount } = render(<JarvisView digest={{ ...jarvisFixture(), brain: unchosen }} now={JNOW} />)
    fireEvent.click(screen.getByRole('button', { name: 'Choose…' }))
    const chooser = document.querySelector('[data-jarvis-brain-chooser]') as HTMLElement
    fireEvent.click(within(chooser).getByRole('radio', { name: 'Codex' }))
    fireEvent.click(within(chooser).getByRole('checkbox', { name: /Answer routine agent questions for me/ }))
    fireEvent.click(within(chooser).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(h.saved).toEqual([{ jarvis_brain: { agent: 'codex', auto_answer: 'off' } }]))
    unmount()
    const r = render(<JarvisView digest={{ ...jarvisFixture(), brain: { state: 'ready', agent: 'claude', auto_answer: 'routine' } }} now={JNOW} />)
    expect(document.querySelector('[data-jarvis-brain]')).toHaveTextContent('Claude · ready')
    expect(document.querySelector('[data-jarvis-brain-card]')).toBeNull()
    r.unmount()
    render(<JarvisView digest={{ ...jarvisFixture(), brain: { state: 'signed-out', agent: 'claude', sub: 'work', auto_answer: 'routine' } }} now={JNOW} />)
    expect(document.querySelector('[data-jarvis-brain]')).toHaveTextContent('Claude · signed out')
    expect(within(document.querySelector('[data-jarvis-brain]') as HTMLElement).getByRole('button', { name: 'fix' })).toBeInTheDocument()
    // The chooser opens on the sign-in in use, and says it is signed out.
    fireEvent.click(screen.getByRole('button', { name: 'Claude · signed out' }))
    expect(await screen.findByText(/Work is not signed in/)).toBeInTheDocument()
  })

  it('draws no brain line for a daemon before Jarvis V2', () => {
    view()
    expect(document.querySelector('[data-jarvis-brain]')).toBeNull()
    expect(document.querySelector('[data-jarvis-brain-card]')).toBeNull()
  })
})

describe('Jarvis V2: an answer stays visible', () => {
  it('keeps “✓ Answered …” in place for a few seconds after the digest drops the question', async () => {
    const { rerender } = render(<JarvisView digest={withNeeds([question()])} now={JNOW} />)
    fireEvent.click(need('question', 'a2').querySelector('[data-jarvis-option="1"]') as HTMLElement)
    await screen.findByText(/Answered “R2 bucket”/)
    rerender(<JarvisView digest={withNeeds([])} now={JNOW} />)
    await act(async () => { await new Promise((r) => setTimeout(r, 400)) })
    expect(screen.getByText(/Answered “R2 bucket”/)).toBeInTheDocument()
  })
})
