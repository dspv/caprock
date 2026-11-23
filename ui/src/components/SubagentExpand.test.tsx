import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Event, SessionSummary, Subagent, SubagentDetail, SubagentsNow } from '@/lib/api'
import type { Frame } from '@/lib/live'

// "Can we expand the subagents to look inside?" (owner, 2026-10-12,
// translated): each entry of Now's subagent tree opens in place (owner,
// 2026-11-23: the Subagents section merged into Now as one tree).

const now = Date.now()

const h = vi.hoisted(() => ({
  subagents: { working: [], finished: 0 } as SubagentsNow,
  details: {} as Record<string, SubagentDetail>,
  asked: [] as { agent: string; before?: number; limit?: number }[],
  recentAsked: [] as number[],
}))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      subagents: async (_id: string, recent = 0) => { h.recentAsked.push(recent); return h.subagents },
      subagent: async (_id: string, agent: string, opts: { before?: number; limit?: number } = {}) => {
        h.asked.push({ agent, ...opts })
        const d = h.details[agent]
        if (!d) throw new Error('404')
        if (opts.before) return { ...d, calls: [{ id: 1, tool: 'Glob', detail: '**/*.go', started_at: now - 590_000, ended_at: now - 589_000 }], earlier: 0 }
        return d
      },
      todos: async () => ({ items: [], updated_at: 0 }),
      recentMainEvents: async () => [],
      permission: async () => ({ permission: null }),
      sessionCalls: async () => [],
      diff: async () => ({ root: '/w', branch: 'main', stat: '', files: [] }),
    },
  }
})

vi.mock('@/lib/live', async (orig) => {
  const actual = await orig<typeof import('@/lib/live')>()
  return { ...actual, useLive: () => ({ ...actual.useLive(), conn: 'open' }), useLiveConn: () => 'open' }
})

import { Inspector } from './Inspector'
import { live } from '@/lib/live'
import { SUBAGENT_LOOK_KEY, resetSubagentLookForTest } from '@/lib/subagentfaces'

function emit(f: Frame) {
  const subs = (live as unknown as { frameSubs: Set<(f: Frame) => void> }).frameSubs
  act(() => { for (const fn of [...subs]) fn(f) })
}

const longPrompt = Array.from({ length: 12 }, (_, i) => `Step ${i + 1}: read the file and fix the clip.`).join('\n')

function working(id: string, extra: Partial<Subagent> = {}): Subagent {
  return { agent_id: id, agent_type: 'general-purpose', description: `Task ${id}`, tool_calls: 3, started_at: now - 160_000, last_at: now - 1_000, tool: 'Bash', detail: 'go test ./...', tool_at: now - 4_000, running: true, asking: false, ...extra }
}

function detail(id: string, p: Partial<SubagentDetail> = {}): SubagentDetail {
  return {
    agent_id: id, agent_type: 'general-purpose', description: `Task ${id}`, prompt: longPrompt, subagent_type: 'general-purpose', state: 'working', asking: false,
    started_at: now - 160_000, last_at: now - 1_000, earlier: 0,
    calls: [
      { id: 10, tool_use_id: 'u1', tool: 'Read', detail: 'Cockpit.tsx', started_at: now - 150_000, ended_at: now - 149_000 },
      { id: 11, tool_use_id: 'u2', tool: 'Bash', detail: 'go vet ./...', started_at: now - 120_000, ended_at: now - 110_000, error: true },
      { id: 12, tool_use_id: 'u3', tool: 'Bash', detail: 'go test ./...', started_at: now - 4_000 },
    ],
    stats: {
      tool_calls: 3, turns: 4, tokens: { in: 1_000, out: 2_000, cache_read: 400_000, cache_write: 10_000 }, duration_ms: 160_000,
      by_tool: [{ tool: 'Bash', calls: 2, cost_usd: 0.8 }, { tool: 'Read', calls: 1, cost_usd: 0.2 }, { tool: '', calls: 0, cost_usd: 0.05 }],
      model: 'claude-opus-5-5', model_display: 'Opus 5.5', cost_usd: 1.05,
    },
    ...p,
  }
}

function agent(p: Partial<SessionSummary> = {}): SessionSummary {
  return {
    session_id: 's1', cwd: '/w', project: 'w', model: 'claude-opus-5-5', model_display: 'Opus 5.5', started_at: now - 3_600_000, last_event_at: now, status: 'active',
    transcript_path: '', has_hooks: true, has_transcript: true, git_branch: 'main', version: '', owned: true, agent: 'claude', title: 'x',
    stats: { session_id: 's1', turns: 12, tool_calls: 40, files_touched: 3, tokens_in: 100, tokens_out: 9_000, cache_read: 900_000, cache_write: 50_000, cost_usd: 1.84 },
    activity: { phrase: 'waiting on background work · 2 agents', at: new Date(now - 1_000).toISOString(), health: 'working', background: 2 },
    live_subagents: 2,
    ...p,
  } as SessionSummary
}

function show(s = agent()) {
  return render(<Inspector session={s} sessionId="s1" hasPermission={false} onClose={() => {}} onDetach={() => {}} />)
}

afterEach(() => {
  h.subagents = { working: [], finished: 0 }
  h.details = {}
  h.asked = []
  h.recentAsked = []
})

function rowButton(section: HTMLElement, text: string) {
  return within(section).getAllByRole('button').find((b) => b.getAttribute('aria-expanded') !== null && b.textContent?.includes(text))!
}

/** The Now section, once its subagent tree is drawn. */
async function nowTree() {
  const section = await screen.findByRole('region', { name: 'Now' })
  await within(section).findByRole('list', { name: 'Subagents' })
  return section
}

describe('opening a subagent in Now’s tree', () => {
  it('opens an entry in place to its latest steps, newest last, and the whole detail behind "Task, result and numbers"', async () => {
    h.subagents = { working: [working('a1'), working('b2', { agent_type: 'Explore', description: 'Task b2' })], finished: 0 }
    h.details = { a1: detail('a1'), b2: detail('b2', { agent_type: 'Explore', state: 'finished', stopped_at: now - 2_000, result: 'Done: the clip is fixed.' }) }
    show()
    const section = await nowTree()
    const a = rowButton(section, 'Task a1')
    expect(a).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(a)
    expect(a).toHaveAttribute('aria-expanded', 'true')
    const steps = await within(section).findByRole('list', { name: 'Latest steps' })
    const panel = document.getElementById(a.getAttribute('aria-controls')!)!
    expect(panel).toContainElement(steps)
    // A few, read with a small limit; newest at the bottom.
    expect(h.asked.at(-1)).toEqual({ agent: 'a1', limit: 4 })
    const calls = within(steps).getAllByRole('listitem')
    expect(calls.map((c) => c.textContent)).toEqual([expect.stringContaining('ReadCockpit.tsx'), expect.stringContaining('go vet'), expect.stringContaining('go test')])
    expect(within(calls[1]!).getByLabelText('failed')).toBeInTheDocument()
    expect(calls[2]).toHaveAttribute('data-live', 'true')

    // The whole detail, one press further.
    fireEvent.click(within(panel).getByRole('button', { name: 'Task, result and numbers' }))
    const feed = await within(panel).findByRole('list', { name: 'Subagent activity' })
    expect(within(feed).getAllByRole('listitem')).toHaveLength(3)
    expect(panel).toHaveTextContent('Still working…')
    expect(panel).toHaveTextContent('Opus 5.5 · 2m 4')
    expect(panel).toHaveTextContent('3 calls · $1.05')
    expect(within(panel).getByRole('list', { name: 'Costliest tools' })).toHaveTextContent('Bash · 2 calls$0.80')

    // Another opens beside it; a second press folds it.
    const b = rowButton(section, 'Task b2')
    fireEvent.click(b)
    expect(a).toHaveAttribute('aria-expanded', 'true')
    expect(b).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(a)
    expect(a).toHaveAttribute('aria-expanded', 'false')
    expect(document.querySelector('[data-subagent-detail]')).toBeNull()
  })

  it('folds a long task to six lines with Show all, and pages earlier calls', async () => {
    h.subagents = { working: [working('a1')], finished: 0 }
    h.details = { a1: detail('a1', { earlier: 1, result: undefined }) }
    show()
    const section = await nowTree()
    fireEvent.click(rowButton(section, 'Task a1'))
    fireEvent.click(await within(section).findByRole('button', { name: 'Task, result and numbers' }))
    const task = await screen.findByText(/Step 1: read the file/)
    expect(task).toHaveAttribute('data-clamped', 'true')
    expect(task.className).toContain('line-clamp-6')
    fireEvent.click(screen.getByRole('button', { name: 'Show all of the task' }))
    expect(task).not.toHaveAttribute('data-clamped')

    fireEvent.click(screen.getByRole('button', { name: 'Show earlier · 1' }))
    const feed = screen.getByRole('list', { name: 'Subagent activity' })
    await waitFor(() => expect(within(feed).getAllByRole('listitem')).toHaveLength(4))
    expect(within(feed).getAllByRole('listitem')[0]).toHaveTextContent('Glob')
    expect(h.asked.at(-1)).toEqual({ agent: 'a1', before: 10, limit: 30 })
  })

  it('follows the live socket: a new step appends at the bottom and the oldest drops off, its result closes it', async () => {
    h.subagents = { working: [working('a1')], finished: 0 }
    h.details = { a1: detail('a1') }
    show()
    const section = await nowTree()
    fireEvent.click(rowButton(section, 'Task a1'))
    const steps = await within(section).findByRole('list', { name: 'Latest steps' })
    const ev = (p: Partial<Event> & { kind: string }): Event => ({ id: 99, ts: new Date().toISOString(), session_id: 's1', agent_id: 'a1', source: 'hook', payload: {}, ...p }) as Event
    emit({ type: 'event', data: ev({ id: 20, kind: 'tool.pre', tool: 'Edit', payload: { tool_use_id: 'u9', tool_input: { file_path: '/w/ui/Cockpit.tsx' } } }) })
    emit({ type: 'event', data: ev({ id: 21, kind: 'tool.pre', tool: 'Read', agent_id: 'other', payload: { tool_use_id: 'x' } }) })
    emit({ type: 'event', data: ev({ id: 22, kind: 'tool.pre', tool: 'Grep', payload: { tool_use_id: 'u10', tool_input: { pattern: 'clip' } } }) })
    const rows = within(steps).getAllByRole('listitem')
    expect(rows).toHaveLength(4)
    expect(rows[0]).toHaveTextContent('go vet')
    expect(rows[2]).toHaveTextContent('EditCockpit.tsx')
    expect(rows[3]).toHaveTextContent('Grep')
    expect(rows[3]).toHaveAttribute('data-live', 'true')
    emit({ type: 'event', data: ev({ id: 23, kind: 'tool.post', tool: 'Grep', payload: { tool_use_id: 'u10' } }) })
    expect(within(steps).getAllByRole('listitem')[3]).not.toHaveAttribute('data-live')
    // Read once; the socket did the rest.
    expect(h.asked.filter((x) => x.agent === 'a1')).toHaveLength(1)
  })

  it('folds the finished into one "N done" entry that opens to them, and Show all lists the rest', async () => {
    h.subagents = {
      working: [working('a1')], finished: 5,
      recent: [
        { agent_id: 'd1', agent_type: 'Explore', description: 'Done one', tool_calls: 4, started_at: now - 300_000, stopped_at: now - 200_000, cost_usd: 0.5 },
        { agent_id: 'd2', agent_type: 'Plan', description: 'Done two', tool_calls: 2, started_at: now - 300_000, stopped_at: now - 250_000, cost_usd: 0.25 },
      ],
    }
    h.details = { d1: detail('d1', { state: 'finished', stopped_at: now - 200_000, result: 'Found it in Cockpit.tsx.' }) }
    show()
    const section = await nowTree()
    const tree = within(section).getByRole('list', { name: 'Subagents' })
    expect(tree.querySelectorAll(':scope > [data-subagent]')).toHaveLength(1)
    const done = rowButton(section, '5 done')
    expect(done).toHaveAttribute('aria-expanded', 'false')
    // Three of the five are not listed: no sum that reads as all of theirs.
    expect(done).not.toHaveTextContent('$')
    expect(within(section).queryByRole('list', { name: 'Finished subagents' })).toBeNull()
    fireEvent.click(done)
    const finished = within(section).getByRole('list', { name: 'Finished subagents' })
    expect(finished.querySelectorAll('[data-done="true"]')).toHaveLength(2)
    fireEvent.click(rowButton(finished, 'Done one'))
    fireEvent.click(await within(finished).findByRole('button', { name: 'Task, result and numbers' }))
    expect(await screen.findByText('Found it in Cockpit.tsx.')).toBeInTheDocument()

    h.subagents = {
      ...h.subagents,
      recent: [...h.subagents.recent!, ...[3, 4, 5].map((i) => ({ agent_id: `d${i}`, agent_type: 'Explore', description: `Done ${i}`, tool_calls: 1, started_at: now - 400_000, stopped_at: now - 390_000 }))],
    }
    fireEvent.click(within(section).getByRole('button', { name: 'Show all' }))
    await waitFor(() => expect(finished.querySelectorAll('[data-done="true"]')).toHaveLength(5))
    expect(h.recentAsked.at(-1)).toBe(30)
    expect(within(section).getByRole('button', { name: 'Show fewer' })).toBeInTheDocument()
  })

  // "They jump — their order jumps too, bad, I want fixed positions" (owner,
  // 2026-10-14, translated).
  it('keeps every working entry in its place while states change, appends a new one, and folds a finished one into done', async () => {
    const at = (id: string, started: number, extra: Partial<Subagent> = {}) => working(id, { started_at: now - started, ...extra })
    // The daemon lists the newest activity first: the reverse of their starts.
    h.subagents = { working: [at('c', 10_000), at('b', 20_000), at('a', 30_000)], finished: 0 }
    show()
    const section = await nowTree()
    const tree = () => within(section).getByRole('list', { name: 'Subagents' })
    const order = () => [...tree().querySelectorAll(':scope > [data-subagent]')].map((li) => li.getAttribute('data-subagent'))
    expect(order()).toEqual(['a', 'b', 'c'])
    h.subagents = {
      working: [at('d', 5_000), at('a', 30_000, { tool_calls: 90, cost_usd: 4 }), at('c', 1_000, { asking: true })],
      finished: 1,
      recent: [{ agent_id: 'b', agent_type: 'Explore', description: 'Task b', tool_calls: 3, started_at: now - 20_000, stopped_at: now - 500 }],
    }
    emit({ type: 'event', data: { id: 50, ts: new Date().toISOString(), session_id: 's1', agent_id: 'a', source: 'hook', kind: 'tool.pre', tool: 'Read', payload: {} } as Event })
    await waitFor(() => expect(order()).toEqual(['a', 'c', 'd']), { timeout: 4_000 })
    expect(rowButton(section, '1 done')).toHaveTextContent('1 done · Task b')
  })
})

// "Why doesn't it show more agents? Show agent chips in groups of four, up to
// 12 in one row, then a second row; move the text with how many subagents
// are running higher" (owner, 2026-10-12, translated).
describe('the hero’s subagent chips', () => {
  // The chips are the *Faces as chips* look; the matrix, the default, draws its own grid.
  beforeEach(() => { localStorage.setItem(SUBAGENT_LOOK_KEY, 'chips'); resetSubagentLookForTest() })
  afterEach(() => { localStorage.removeItem(SUBAGENT_LOOK_KEY); resetSubagentLookForTest() })

  it('puts the count above the chips, groups them by five, and a chip opens its row', async () => {
    h.subagents = { working: Array.from({ length: 14 }, (_, i) => working(`w${i}`, { agent_type: i % 2 ? 'Explore' : 'general-purpose' })), finished: 0 }
    h.details = { w9: detail('w9') }
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600)
    show(agent({ live_subagents: 14, activity: { phrase: 'waiting on background work · 14 agents', at: new Date().toISOString(), health: 'working', background: 14 } }))
    const chips = await screen.findByRole('group', { name: 'Subagents' })
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent(/^Background$/)
    expect(status).toHaveAttribute('title', 'Waiting on background work · 14 agents')
    expect(status).toHaveAccessibleName('Waiting on background work · 14 agents')
    // The state line comes before the chips in reading order.
    expect(status.compareDocumentPosition(chips) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(chips).getAllByRole('button')).toHaveLength(14)
    expect([...chips.children].map((g) => g.children.length)).toEqual([5, 5, 4])
    expect(chips).not.toHaveAttribute('data-compact')

    const section = screen.getByRole('region', { name: 'Now' })
    // w9 is past the first five entries; its chip shows every one and opens it.
    expect(rowButton(section, 'Task w9')).toBeUndefined()
    fireEvent.click(within(chips).getAllByRole('button')[9]!)
    const row = rowButton(section, 'Task w9')
    expect(row).toHaveAttribute('aria-expanded', 'true')
    expect(await within(section).findByRole('list', { name: 'Latest steps' })).toBeInTheDocument()
    vi.restoreAllMocks()
  })

  // A 324px inspector's chip row: two groups of five a line, two lines.
  it('wraps a second line of full chips, then shrinks them past two lines', async () => {
    h.subagents = { working: Array.from({ length: 20 }, (_, i) => working(`w${i}`)), finished: 0 }
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(230)
    const { unmount } = show(agent({ live_subagents: 20, activity: { phrase: 'editing', at: new Date().toISOString(), health: 'working' } }))
    let chips = await screen.findByRole('group', { name: 'Subagents' })
    expect(within(chips).getAllByRole('button')).toHaveLength(20)
    expect(chips).not.toHaveAttribute('data-compact')
    // The default look: a full-size chip is its subagent's face, not a letter.
    expect(within(chips).getAllByRole('button')[0]!.querySelector('svg[data-face]')).toBeInTheDocument()
    unmount()
    h.subagents = { working: Array.from({ length: 21 }, (_, i) => working(`w${i}`)), finished: 0 }
    show(agent({ live_subagents: 21, activity: { phrase: 'editing', at: new Date().toISOString(), health: 'working' } }))
    chips = await screen.findByRole('group', { name: 'Subagents' })
    expect(chips).toHaveAttribute('data-compact', 'true')
    expect(within(chips).getAllByRole('button')).toHaveLength(21)
    expect(within(chips).getAllByRole('button')[0]).toHaveTextContent('')
    vi.restoreAllMocks()
  })

  it('caps two compact lines with "+N"', async () => {
    h.subagents = { working: Array.from({ length: 45 }, (_, i) => working(`w${i}`)), finished: 0 }
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(291)
    show(agent({ live_subagents: 45, activity: { phrase: 'editing', at: new Date().toISOString(), health: 'working' } }))
    const chips = await screen.findByRole('group', { name: 'Subagents, and 5 more working' })
    expect(within(chips).getAllByRole('button')).toHaveLength(40)
    expect(chips).toHaveTextContent('+5')
    expect(document.querySelector('[data-hero-count]')).toHaveTextContent(/^45 working/)
    vi.restoreAllMocks()
  })
})
