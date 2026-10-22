import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Event, SessionSummary, SubagentsNow, Summary } from '@/lib/api'

const now = Date.now()
const iso = (agoMs: number) => new Date(now - agoMs).toISOString()
const events: Event[] = [
  { id: 1, ts: iso(60_000), session_id: 's1', source: 'transcript', kind: 'turn.assistant', payload: {}, cost_usd: 0.04 },
  { id: 2, ts: iso(59_000), session_id: 's1', source: 'hook', kind: 'tool.pre', tool: 'Bash', payload: { tool_use_id: 'a', tool_input: { command: 'go test ./internal/...' } } },
  { id: 3, ts: iso(21_000), session_id: 's1', source: 'hook', kind: 'tool.post', tool: 'Bash', payload: { tool_use_id: 'a' } },
  { id: 4, ts: iso(20_000), session_id: 's1', source: 'transcript', kind: 'turn.assistant', payload: {}, cost_usd: 0.07 },
  { id: 5, ts: iso(4_000), session_id: 's1', source: 'hook', kind: 'tool.pre', tool: 'Edit', payload: { tool_use_id: 'b', tool_input: { file_path: '/w/internal/session.go' } } },
]

const h = vi.hoisted(() => ({
  subagents: { working: [], finished: 0 } as SubagentsNow,
  permission: null as unknown,
  mainAsked: [] as string[][],
  summaries: {} as Record<string, Summary>,
  summaryAsked: [] as string[],
  overlap: { window_minutes: 30, sessions: {} } as unknown,
  events: undefined as Event[] | undefined,
}))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      subagents: async () => h.subagents,
      todos: async () => ({ items: [], updated_at: 0 }),
      recentMainEvents: async (_id: string, kinds: string[]) => { h.mainAsked.push(kinds); return h.events ?? events },
      permission: async () => ({ permission: h.permission }),
      sessionCalls: async () => [],
      overlap: async () => h.overlap,
      summary: async (range: string) => {
        h.summaryAsked.push(range)
        const s = h.summaries[range]
        if (!s) throw new Error('no summary')
        return s
      },
      diff: async () => ({ root: '/w', branch: 'main', stat: '', files: [{ path: 'internal/session.go', status: 'modified', additions: 12, deletions: 3 }] }),
    },
  }
})

vi.mock('@/lib/live', async (orig) => {
  const actual = await orig<typeof import('@/lib/live')>()
  return { ...actual, useLive: () => ({ ...actual.useLive(), conn: 'open' }), useLiveConn: () => 'open' }
})

import { Inspector } from './Inspector'
import { resetSpendPrefsForTest } from '@/lib/spendview'
import { LOOKS_KEY, getLooks, resetLooksForTest, setLook } from '@/lib/cockpitlooks'
import { ORDER_KEY, resetOrderForTest } from '@/lib/cockpitorder'
import { getSubagentFields, resetSubagentFieldsForTest, setSubagentFields } from '@/lib/subagentview'

beforeEach(() => {
  // The clock stands at `now` in every test. The fixtures are stamped when
  // this file loads and the cockpit reads Date.now() as it draws, so a busy
  // runner that reached the subagent tests ten seconds in read "10m 10s"
  // where "10m 0Xs" was asked. Only Date is faked; timers stay real.
  vi.useFakeTimers({ toFake: ['Date'], now })
  localStorage.clear()
  resetSpendPrefsForTest()
  resetSubagentFieldsForTest()
  resetLooksForTest()
  resetOrderForTest()
  h.events = undefined
  h.summaries = {}
  h.summaryAsked = []
})

afterEach(() => { vi.useRealTimers() })

/** Switch the spend details, open on the chart by default, to Numbers. */
function showNumbers() {
  const region = screen.getByRole('region', { name: 'Spend' })
  fireEvent.click(within(region).getByRole('button', { name: 'Numbers' }))
}

/** What the newest call cost, as the first figure's menu offers it. */
function lastCallOffered(): HTMLElement {
  const region = screen.getByRole('region', { name: 'Spend' })
  fireEvent.click(within(region).getAllByRole('button', { name: /Choose what this figure shows/ })[0]!)
  return within(region).getByRole('menuitemradio', { name: /Last call/ })
}

function agent(p: Partial<SessionSummary> = {}): SessionSummary {
  return {
    session_id: 's1', cwd: '/w', project: 'w', model: 'claude-opus-5-5', model_display: 'Opus 5.5', started_at: 0, last_event_at: now, status: 'active',
    transcript_path: '', has_hooks: true, has_transcript: true, git_branch: 'feat/x', version: '', owned: true, agent: 'claude', title: 'Fix the login bug',
    stats: { session_id: 's1', turns: 12, tool_calls: 40, files_touched: 3, tokens_in: 100, tokens_out: 9_000, cache_read: 900_000, cache_write: 50_000, cost_usd: 1.84 },
    activity: { phrase: 'editing session.go', tool: 'Edit', at: iso(4_000), health: 'working' },
    savings: { billed_with: 0, billed_without: 0, saved: 0, hit_rate: 0.95, cut_pct: 0 },
    context: { tokens: 124_000, window: 200_000, pct: 62, next_call_usd: 0.031 },
    ...p,
  } as SessionSummary
}

const summary = { rate_limits: { five_hour: { used_percentage: 41, resets_at: Math.round((now + 3_600_000) / 1000) } } } as unknown as Summary

function show(s: SessionSummary, sum: Summary | undefined = summary) {
  return render(<Inspector session={s} sessionId={s.session_id} hasPermission={false} onClose={() => {}} onDetach={() => {}} summary={sum} />)
}

describe('the agent cockpit', () => {
  it('reads the session’s cost, context, the call running now and the recent calls', async () => {
    setLook('context', 'full')
    setLook('limits', 'full')
    show(agent())
    expect(screen.getByRole('heading', { name: 'Agent' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Working')
    expect(screen.getByRole('button', { name: /^Cost \$1\.84\. Choose what this line shows/ })).toBeInTheDocument()
    expect(screen.getByRole('meter', { name: 'Context used' })).toHaveAttribute('aria-valuenow', '62')
    expect(screen.getByText(/re-reads it for/)).toHaveTextContent('$0.03')
    const timeline = screen.getByRole('region', { name: 'Recent tool calls' })
    await within(timeline).findByText('Edit')
    expect(within(timeline).getByText('go test ./internal/...')).toBeInTheDocument()
    expect(within(timeline).getByText('38s')).toBeInTheDocument()
    const nowCard = screen.getByRole('region', { name: 'Now' })
    expect(within(nowCard).getByText('Editing')).toBeInTheDocument()
    expect(within(nowCard).getByText('session.go')).toBeInTheDocument()
    showNumbers()
    expect(lastCallOffered()).toHaveTextContent('$0.07')
    expect(screen.getByRole('meter', { name: '5 hours window used' })).toHaveAttribute('aria-valuenow', '41')
    // One line: when it resets, and whether it lasts (owner, 2026-10-11).
    expect(document.querySelector('[data-window="5 hours"]')?.textContent).toMatch(/resets in/)
    expect(await screen.findByText('1 file')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  // "You moved the context window size too far down — it's needed info.
  // Make it compact or like now; plan and limits too" (owner, 2026-10-14,
  // translated).
  it('puts the context and the plan right under Now, above the spend, compact by default', () => {
    show(agent())
    const order = ['Now', 'Context', 'Plan limits', 'Spend', 'Recent tool calls'].map((name) => screen.getByRole('region', { name }))
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
    const ctx = screen.getByRole('region', { name: 'Context' })
    expect(ctx).toHaveAttribute('data-look', 'compact')
    expect(within(ctx).getByRole('meter', { name: 'Context used' })).toHaveAttribute('aria-valuenow', '62')
    expect(ctx).toHaveTextContent('62% · 124.0k / 200.0k')
    expect(ctx).not.toHaveTextContent('re-reads')
    const plan = screen.getByRole('region', { name: 'Plan limits' })
    expect(plan).toHaveAttribute('data-look', 'compact')
    expect(plan.querySelector('[data-window="5 hours"]')).toHaveTextContent(/^5h41%\d/)
    expect(plan).not.toHaveTextContent('resets in')
    expect(within(plan).queryByRole('meter')).toBeNull()
  })

  it('switches each section between compact and full on its label, and remembers it', () => {
    const { unmount } = show(agent())
    const ctx = () => screen.getByRole('region', { name: 'Context' })
    const plan = () => screen.getByRole('region', { name: 'Plan limits' })
    const ctxLabel = within(ctx()).getByRole('button', { name: 'Context' })
    expect(ctxLabel).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(ctxLabel)
    expect(ctx()).toHaveAttribute('data-look', 'full')
    expect(ctx()).toHaveTextContent('re-reads it for $0.03')
    expect(plan()).toHaveAttribute('data-look', 'compact')
    fireEvent.click(within(plan()).getByRole('button', { name: 'Plan' }))
    expect(plan()).toHaveAttribute('data-look', 'full')
    expect(within(plan()).getByRole('meter', { name: '5 hours window used' })).toHaveAttribute('aria-valuenow', '41')
    expect(plan().querySelector('[data-window="5 hours"]')?.textContent).toMatch(/resets in/)
    expect(JSON.parse(localStorage.getItem(LOOKS_KEY)!)).toMatchObject({ context: 'full', limits: 'full', subagents: 'full', tools: 'full' })
    // A fresh page reads the choice back.
    unmount()
    resetLooksForTest()
    show(agent())
    expect(ctx()).toHaveAttribute('data-look', 'full')
    fireEvent.click(within(ctx()).getByRole('button', { name: 'Context' }))
    expect(ctx()).toHaveAttribute('data-look', 'compact')
    expect(plan()).toHaveAttribute('data-look', 'full')
  })

  it('falls back to compact when the stored looks are broken', () => {
    localStorage.setItem(LOOKS_KEY, '{not json')
    resetLooksForTest()
    expect(getLooks()).toEqual({ context: 'compact', limits: 'compact', subagents: 'full', tools: 'full', now: 'full', tasks: 'full', changes: 'full', ci: 'full', release: 'full', processes: 'full' })
    localStorage.setItem(LOOKS_KEY, JSON.stringify({ context: 'huge', limits: 'full', tools: 7 }))
    resetLooksForTest()
    expect(getLooks()).toMatchObject({ context: 'compact', limits: 'full', subagents: 'full', tools: 'full' })
    show(agent())
    expect(screen.getByRole('region', { name: 'Context' })).toHaveAttribute('data-look', 'compact')
    expect(screen.getByRole('region', { name: 'Plan limits' })).toHaveAttribute('data-look', 'full')
  })

  it('warns of a loop only when there is one', () => {
    show(agent({ loop: { kind: 'loop', session_id: 's1', tool: 'Bash', count: 7, window_min: 3, sample: 'npm test', first_ts: iso(90_000), last_ts: iso(5_000), ts: iso(5_000), tax_usd: 0.42 } }))
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('This session ran the same command 7 times in 2 minutes')
    expect(alert).toHaveTextContent('$0.42 re-reading context')
  })

  it('shows only what an agent reports: no context bar, no plan for OpenCode', () => {
    show(agent({ agent: 'opencode', context: undefined, context_note: 'no turn yet' }))
    expect(screen.queryByRole('meter', { name: 'Context used' })).toBeNull()
    expect(screen.getByText('no turn yet')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Plan limits' })).toBeNull()
  })

  // The owner's 36-hour session: subagents in parallel logged 635 tool calls
  // in an hour, so its newest 400 events held none of the parent's own, and
  // the panel said "No tool calls yet" over thousands of them.
  it('shows a busy parent’s own calls, fetched as the main thread’s', async () => {
    show(agent({ live_subagents: 2 }))
    const timeline = screen.getByRole('region', { name: 'Recent tool calls' })
    expect(await within(timeline).findByText('go test ./internal/...')).toBeInTheDocument()
    expect(h.mainAsked.at(-1)).toEqual(['tool.pre', 'tool.post', 'turn.assistant'])
    showNumbers()
    expect(lastCallOffered()).toHaveTextContent('$0.07')
  })

  it('lists the subagents at work: type, task, current call, calls made, and who waits on you', async () => {
    setSubagentFields({ calls: true, cost: true, model: true, time: true })
    h.subagents = {
      working: [
        { agent_id: 'a827d9', agent_type: 'general-purpose', description: 'Fix the cockpit', tool_calls: 42, started_at: now - 600_000, last_at: now - 1_000, tool: 'Bash', detail: 'go test ./...', tool_at: now - 12_000, running: true, asking: false },
        { agent_id: 'b11', agent_type: 'Explore', tool_calls: 7, started_at: now - 60_000, last_at: now - 2_000, tool: 'Edit', detail: 'session.go', tool_at: now - 5_000, running: false, asking: false },
        { agent_id: 'c22', agent_type: 'general-purpose', tool_calls: 1, started_at: now - 9_000, last_at: now - 3_000, tool: 'Bash', detail: 'rm -f out/*', tool_at: now - 4_000, running: true, asking: true },
      ],
      finished: 3,
    }
    try {
      show(agent({ live_subagents: 3 }))
      const section = await screen.findByRole('region', { name: 'Subagents' })
      expect(section).toHaveTextContent('Subagents · 3')
      expect(section).toHaveTextContent('3 finished')
      const rows = within(section).getAllByRole('listitem')
      // The type is a letter, its name on hover; the words are what it is doing.
      expect(within(rows[0]!).getByLabelText('general-purpose')).toHaveTextContent('G')
      expect(within(rows[1]!).getByLabelText('Explore')).toHaveTextContent('E')
      expect(rows[0]!.querySelector('[data-doing]')).toHaveTextContent('Fix the cockpit')
      // The figures are under the phrase, never beside it.
      const meta = rows[0]!.querySelector('[data-subagent-meta]')!
      expect(meta).toHaveTextContent('Bashgo test ./...')
      expect(meta).toHaveTextContent(/go test \.\/\.\.\.\d+s/)
      expect(meta.querySelector('[data-figures]')).toHaveTextContent(/^42 calls · 10m 0\ds$/)
      // No task and no daemon phrase: the call itself leads, once.
      expect(rows[1]!.querySelector('[data-doing]')).toHaveTextContent('Edit session.go')
      expect(rows[1]).toHaveTextContent('7 calls')
      expect(rows[1]).not.toHaveTextContent('waiting on you')
      expect(rows[2]).toHaveTextContent('waiting on you')
      expect(rows[2]).toHaveTextContent('1 call')
    } finally {
      h.subagents = { working: [], finished: 0 }
    }
  })

  // Claude Code's own list says "general-purpose  Rerunning AppShell and
  // DiffFiles tests"; the row leads with that kind of phrase, not the raw
  // command (owner, 2026-10-13, translated). "The text doesn't show enough"
  // (owner, 2026-10-14, translated): the whole row, two lines.
  it('leads a subagent row with what it is doing now, across the row, up to two lines', async () => {
    h.subagents = {
      working: [
        { agent_id: 'a1', agent_type: 'general-purpose', description: 'Fix the cockpit', tool_calls: 9, started_at: now - 60_000, last_at: now - 1_000, tool: 'Bash', detail: 'go -C /Users/x test ./...', tool_at: now - 2_000, running: true, asking: false, doing: 'Rerun the store tests', doing_from: 'call' },
        { agent_id: 'b2', agent_type: 'Plan', tool_calls: 0, started_at: now - 2_000, last_at: now - 1_000, running: false, asking: false },
      ],
      finished: 0,
    }
    try {
      show(agent({ live_subagents: 2 }))
      const section = await screen.findByRole('region', { name: 'Subagents' })
      const [a, b] = within(section).getAllByRole('listitem')
      const doing = a!.querySelector('[data-doing]')
      expect(doing).toHaveTextContent('Rerun the store tests')
      expect(doing).toHaveAttribute('data-doing', 'call')
      // Two lines, not one truncated; the whole phrase on hover.
      expect(doing).toHaveClass('line-clamp-2')
      expect(doing).not.toHaveClass('truncate')
      expect(a!.querySelector('button[aria-expanded]')).toHaveAttribute('title', expect.stringContaining('Rerun the store tests'))
      // The phrase is the command's own description: the raw command is not repeated.
      expect(a).not.toHaveTextContent('go -C')
      // Cost and time by default: no cost known yet, so the time alone.
      expect(a!.querySelector('[data-figures]')).toHaveTextContent(/^1m 0\ds$/)
      expect(a).not.toHaveTextContent('calls')
      expect(within(b!).getByLabelText('Plan')).toHaveTextContent('P')
      expect(b).toHaveTextContent('starting')
    } finally {
      h.subagents = { working: [], finished: 0 }
    }
  })

  // "In subagents I don't see which model is used and costs" (owner,
  // 2026-10-09, translated). A cost the daemon does not know is not drawn.
  it('shows each subagent’s model, time and cost, the finished ones dimmed in their place, and the total', async () => {
    setSubagentFields({ calls: true, cost: true, model: true, time: true })
    h.subagents = {
      working: [
        { agent_id: 'a1', agent_type: 'general-purpose', tool_calls: 4, started_at: now - 125_000, last_at: now - 1_000, tool: 'Bash', detail: 'go test ./...', tool_at: now - 3_000, running: true, asking: false, model: 'claude-haiku-4-5', model_display: 'Haiku 4.5', cost_usd: 0.42 },
        { agent_id: 'b2', agent_type: 'Explore', tool_calls: 1, started_at: now - 9_000, last_at: now - 2_000, tool: 'Read', detail: 'a.go', tool_at: now - 4_000, running: false, asking: false, model_display: 'Sonnet 4.5' },
      ],
      finished: 2,
      recent: [{ agent_id: 'c3', agent_type: 'Explore', description: 'Map the store', tool_calls: 6, started_at: now - 300_000, stopped_at: now - 180_000, model_display: 'Sonnet 4.5', cost_usd: 1.1 }],
      cost_usd: 1.52,
    }
    try {
      show(agent({ live_subagents: 2 }))
      const section = await screen.findByRole('region', { name: 'Subagents' })
      expect(section).toHaveTextContent('Subagents · 2')
      // Every subagent's cost over the session, not the finished ones' (owner,
      // 2026-10-22: "1 finished $2,549.54" read as one subagent's).
      expect(section.querySelector('[data-subagents-cost]')).toHaveTextContent('$1.52 total')
      expect(section).toHaveTextContent('+1 finished')
      // By start: the finished one started first, so it stands first.
      const [c, a, b] = within(section).getAllByRole('listitem')
      expect(c).toHaveAttribute('data-done', 'true')
      expect(c).toHaveTextContent('Map the store')
      expect(within(c!).getByLabelText('finished')).toHaveTextContent('✓')
      expect(c!.querySelector('[data-figures]')).toHaveTextContent('6 calls · $1.10 · Sonnet 4.5 · 2m 00s')
      expect(a!.querySelector('[data-figures]')).toHaveTextContent(/^4 calls · \$0\.42 · Haiku 4\.5 · 2m 0\ds$/)
      expect(b).toHaveTextContent('Sonnet 4.5')
      expect(b).not.toHaveTextContent('$')
    } finally {
      h.subagents = { working: [], finished: 0 }
    }
  })

  // "Maybe a switch for what to see?" (owner, 2026-10-14, translated).
  it('lets the viewer pick what each subagent row shows, and remembers it', async () => {
    h.subagents = {
      working: [{ agent_id: 'a1', agent_type: 'Explore', description: 'Map the store', tool_calls: 4, started_at: now - 125_000, last_at: now - 1_000, tool: 'Read', detail: 'a.go', tool_at: now - 3_000, running: true, asking: false, model_display: 'Haiku 4.5', cost_usd: 0.42 }],
      finished: 0,
    }
    try {
      show(agent({ live_subagents: 1 }))
      const section = await screen.findByRole('region', { name: 'Subagents' })
      const row = () => within(section).getAllByRole('listitem')[0]!
      expect(row().querySelector('[data-figures]')).toHaveTextContent(/^\$0\.42 · 2m 0\ds$/)
      const show_ = within(section).getByRole('button', { name: /^Show: Cost\./ })
      fireEvent.click(show_)
      fireEvent.click(screen.getByRole('menuitemradio', { name: 'Full' }))
      expect(row().querySelector('[data-figures]')).toHaveTextContent(/^4 calls · \$0\.42 · Haiku 4\.5 · 2m 0\ds$/)
      expect(JSON.parse(localStorage.getItem('caprock.app.subagent-fields')!)).toEqual({ calls: true, cost: true, model: true, time: true })
      // One figure off: a custom mix, the menu stays open.
      fireEvent.click(within(section).getByRole('button', { name: /^Show: Full\./ }))
      fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Model' }))
      expect(screen.getByRole('menuitemcheckbox', { name: 'Model' })).toHaveAttribute('aria-checked', 'false')
      expect(row().querySelector('[data-figures]')).toHaveTextContent(/^4 calls · \$0\.42 · 2m 0\ds$/)
      expect(within(section).getByRole('button', { name: /^Show: Custom\./ })).toBeInTheDocument()
      // Compact: the letter and the phrase alone.
      fireEvent.click(screen.getByRole('menuitemradio', { name: 'Compact' }))
      expect(row().querySelector('[data-subagent-meta]')).toBeNull()
      expect(row()).toHaveTextContent('Map the store')
      // A fresh read from storage keeps the choice.
      resetSubagentFieldsForTest()
      expect(getSubagentFields()).toEqual({ calls: false, cost: false, model: false, time: false })
    } finally {
      h.subagents = { working: [], finished: 0 }
    }
  })

  it('has no subagent section while none works', async () => {
    show(agent())
    await screen.findByRole('region', { name: 'Recent tool calls' })
    expect(screen.queryByRole('region', { name: 'Subagents' })).toBeNull()
  })

  // A subagent's dialog is drawn in the parent's terminal; the Now line says
  // whose it is and what the command does, not a cut-off `C=/pri…`.
  it('names a subagent that waits for approval', async () => {
    h.permission = { id: 'p1', tool: 'Bash', detail: 'C=/private/tmp/caps3; rm -f $C/*; ls $C', since: iso(2_000), agent_id: 'a827d9', agent_type: 'general-purpose' }
    try {
      show(agent())
      const nowCard = screen.getByRole('region', { name: 'Now' })
      expect(await within(nowCard).findByText('Subagent (general-purpose) wants to run Bash')).toBeInTheDocument()
      expect(within(nowCard).getByText('rm -f $C/*')).toHaveAttribute('title', 'C=/private/tmp/caps3; rm -f $C/*; ls $C')
      expect(screen.getByRole('status')).toHaveTextContent('Waiting on you')
    } finally {
      h.permission = null
    }
  })

  // The owner's session ended its turn with a background subagent still at
  // work, and the cockpit read "Waiting on you" beside "1 subagent working".
  // The daemon now narrates it as working with `background`; the cockpit says
  // so, and the Now card does not name the parent's last call as running.
  it('says background agents are working, not waiting on you, after the turn ended', async () => {
    show(agent({ live_subagents: 1, activity: { phrase: 'background agents working · 1', at: iso(1_000), health: 'working', background: 1 } }))
    await screen.findByRole('region', { name: 'Recent tool calls' })
    // The state line is one word on one line (owner, 2026-10-22: "Background /
    // agents" wrapped under the portrait); the full phrase is the tooltip and
    // the accessible name; the count sits under it.
    expect(screen.getByRole('status')).toHaveTextContent(/^Background$/)
    expect(screen.getByRole('status')).toHaveClass('whitespace-nowrap')
    expect(screen.getByRole('status')).toHaveAttribute('title', 'Background agents working · 1')
    expect(screen.getByRole('status')).toHaveAccessibleName('Background agents working · 1')
    expect(screen.getByRole('status')).not.toHaveTextContent('Waiting')
    expect(document.querySelector('[data-hero-count]')).toHaveTextContent('1 working')
    const nowCard = screen.getByRole('region', { name: 'Now' })
    expect(within(nowCard).getByText('Background agents working · 1')).toBeInTheDocument()
    expect(within(nowCard).queryByText(/Waiting|Thinking/)).toBeNull()
  })

  // "Move the status under the agent's portrait", and the mode with it
  // (owner, 2026-10-14, translated); the chips in fives, compact past two
  // full lines.
  it('puts the state under the portrait and draws many subagents compact, in fives', async () => {
    h.subagents = { working: Array.from({ length: 23 }, (_, i) => ({ agent_id: `a${i}`, agent_type: 'general-purpose', tool_calls: 1, started_at: i, last_at: i, running: true, asking: false })), finished: 0 } as SubagentsNow
    try {
      show(agent({ live_subagents: 23, started_at: now - 3_600_000 }))
      const lead = document.querySelector('[data-hero-lead]')!
      expect(within(lead as HTMLElement).getByRole('status')).toHaveTextContent('Working')
      expect(document.querySelector('[data-hero-started]')).toBeInTheDocument()
      const strip = await screen.findByRole('group', { name: 'Subagents' })
      expect(strip).toHaveAttribute('data-compact', 'true')
      expect(Array.from(strip.querySelectorAll('[data-chip-group]')).map((g) => g.querySelectorAll('button').length)).toEqual([5, 5, 5, 5, 3])
      expect(strip.querySelector('button')).toHaveTextContent('')
      expect(document.querySelector('[data-hero-count]')).toHaveTextContent('23 working')
    } finally {
      h.subagents = { working: [], finished: 0 }
    }
  })

  it('still waits on a permission prompt while background agents work', async () => {
    h.permission = { id: 'p1', tool: 'Bash', detail: 'rm -rf out', since: iso(2_000), agent_id: 'a1', agent_type: 'general-purpose' }
    try {
      show(agent({ live_subagents: 1, activity: { phrase: 'background agents working · 1', at: iso(1_000), health: 'working', background: 1 } }))
      const nowCard = screen.getByRole('region', { name: 'Now' })
      expect(await within(nowCard).findByText('Subagent (general-purpose) wants to run Bash')).toBeInTheDocument()
      expect(screen.getByRole('status')).toHaveTextContent('Waiting on you')
    } finally {
      h.permission = null
    }
  })

  // "feat/app-one-tab-strip …nt-a874ec5240fb37a9d" said neither which
  // project nor, cut from the left, which folder (owner, 2026-10-09).
  it('heads the panel with the project, a branch only off the default, the path on hover', () => {
    const { unmount } = render(<Inspector session={agent({ cwd: '/u/dev/caprock', repo_root: '/u/dev/caprock', project: 'caprock', git_branch: 'master' })} project={{ name: 'caprock', default_branch: 'master' }} sessionId="s1" hasPermission={false} onClose={() => {}} onDetach={() => {}} />)
    const place = screen.getByLabelText('Project caprock')
    expect(place).toHaveTextContent(/^caprock$/)
    expect(place).toHaveAttribute('title', '/u/dev/caprock')
    unmount()
    render(<Inspector session={agent({ cwd: '/u/dev/caprock/.claude/worktrees/agent-a1', repo_root: '/u/dev/caprock', project: 'caprock', git_branch: 'feat/x' })} project={{ name: 'caprock', default_branch: 'master' }} sessionId="s1" hasPermission={false} onClose={() => {}} onDetach={() => {}} />)
    const other = screen.getByLabelText('Project caprock, branch feat/x')
    expect(other).toHaveTextContent('caprock· feat/x')
    expect(other).not.toHaveTextContent('agent-a1')
    expect(other).toHaveAttribute('title', '/u/dev/caprock/.claude/worktrees/agent-a1')
  })

  it('leaves a shell tab the plain inspector', () => {
    show(agent({ kind: 'shell' }))
    expect(screen.getByRole('heading', { name: 'Inspector' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Spend' })).toBeNull()
  })
})

describe('the figures beside the agent', () => {
  const stored = () => JSON.parse(localStorage.getItem('caprock.app.cockpit.spend') ?? '{}')
  const lines = () => Array.from(document.querySelectorAll('[data-hero-line]')).map((d) => d.getAttribute('data-hero-line'))

  it('shows burn rate big, then tokens and cost as two short lines', () => {
    show(agent())
    expect(document.querySelector('[data-headline]')).toHaveAttribute('data-headline', 'burn')
    expect(lines()).toEqual(['tokens', 'cost'])
    const tok = screen.getByRole('button', { name: /^Tokens 950\.1k\. Choose what this line shows/ })
    expect(tok).toHaveTextContent('950.1k')
    expect(tok).toHaveTextContent('tok')
    // Short, on one line each: no wrapping inside a line.
    expect(tok.className).toMatch(/\bwhitespace-nowrap\b/)
    expect(tok.className).toMatch(/text-\[13px\]/)
  })

  it('lets each of the three pick its metric, swaps rather than repeats, and remembers them', () => {
    const { unmount } = show(agent({ started_at: now - 72 * 60_000, worked_at: now }))
    fireEvent.click(screen.getByRole('button', { name: /Headline: Burn rate/ }))
    const big = screen.getByRole('menu', { name: 'Headline figure' })
    // The same list for all three, with the ones another figure shows marked.
    expect(within(big).getAllByRole('menuitemradio')).toHaveLength(8)
    expect(within(big).getByRole('menuitemradio', { name: /Tokens/ })).toHaveTextContent('Tokens · shown')
    expect(within(big).getByRole('menuitemradio', { name: /Tokens/ })).toHaveAttribute('title', 'Shown as the line under it: picking it swaps the two')
    fireEvent.click(within(big).getByRole('menuitemradio', { name: /Tokens/ }))
    // Tokens was the first line: it and burn rate swap.
    expect(screen.getByLabelText('Tokens 950.1k')).toBeInTheDocument()
    expect(lines()).toEqual(['burn', 'cost'])
    fireEvent.click(screen.getByRole('button', { name: /^Burn rate .*Choose what this line shows/ }))
    const line = screen.getByRole('menu', { name: 'What line 1 shows' })
    expect(within(line).getByRole('menuitemradio', { name: /Burn rate/ })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(within(line).getByRole('menuitemradio', { name: /Time working/ }))
    expect(lines()).toEqual(['time', 'cost'])
    expect(screen.getByRole('button', { name: /^Time working 1h 12m\./ })).toBeInTheDocument()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(stored().hero).toEqual(['tokens', 'time', 'cost'])
    unmount()
    resetSpendPrefsForTest()
    show(agent())
    expect(screen.getByLabelText('Tokens 950.1k')).toBeInTheDocument()
    expect(lines()).toEqual(['time', 'cost'])
  })

  it('keeps an older stored headline as the big figure', () => {
    localStorage.setItem('caprock.app.cockpit.spend', JSON.stringify({ headline: 'turns' }))
    show(agent())
    expect(screen.getByLabelText('Turns 12')).toBeInTheDocument()
    expect(lines()).toEqual(['burn', 'tokens'])
  })

  // One grid in every state (owner, 2026-10-13): the two smaller figures
  // always stand under the big one, at any width, never on the chips' row.
  it('keeps the two lines under the big figure at any width', () => {
    for (const w of [291, 447]) {
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(w)
      const { unmount } = show(agent())
      const hero = document.querySelector('.cockpit-hero')!
      const sec = hero.querySelector('[data-hero-sec]')!
      expect(sec.className).toMatch(/\[grid-area:sec\]/)
      expect(within(sec as HTMLElement).getAllByRole('button', { name: /Choose what this line shows/ })).toHaveLength(2)
      expect(hero.querySelector('[data-hero-chips]')!.contains(sec)).toBe(false)
      unmount()
      vi.restoreAllMocks()
    }
  })
})

describe('the spend details', () => {
  const spend = () => screen.getByRole('region', { name: 'Spend' })
  const stored = () => JSON.parse(localStorage.getItem('caprock.app.cockpit.spend') ?? '{}')
  const slots = () => Array.from(spend().querySelectorAll('[data-slot]')).map((d) => d.getAttribute('data-slot'))

  it('opens on the session’s chart by default, folds to a strip of bars and figures, and remembers it', async () => {
    const { unmount } = await act(async () => show(agent({ started_at: now - 72 * 60_000, worked_at: now })))
    expect(spend()).toHaveAttribute('data-spend-view', 'chart')
    expect(within(spend()).getByRole('button', { name: 'Chart' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(spend()).getByRole('group', { name: /^Spend by .*, this session$/ })).toBeInTheDocument()
    expect(spend().querySelector('[data-spend-total]')).toHaveTextContent('$1.84')
    const toggle = within(spend()).getByRole('button', { name: /^Spend$/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(toggle)
    // The chart's metric first, then the next two the session carries.
    expect(within(spend()).getByRole('button', { name: 'Spend $1.84 · 950.1k tok · 12 turns' })).toHaveAttribute('aria-expanded', 'false')
    expect(within(spend()).queryByRole('group', { name: 'Spend view' })).toBeNull()
    expect(stored()).toMatchObject({ folded: true, v: 6 })
    unmount()
    resetSpendPrefsForTest()
    show(agent())
    const strip = spend().querySelector('[data-spend-folded]')
    expect(strip).toHaveTextContent(/\$1\.84/)
    expect([...strip!.querySelectorAll('[data-fold-fig]')].map((e) => e.getAttribute('data-fold-fig'))).toEqual(['cost', 'tokens', 'turns'])
  })

  it('switches what the bars measure from the ▾, and puts that figure first when folded', async () => {
    await act(async () => show(agent()))
    // Under Now and under the context and the plan.
    const after = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    expect(after(screen.getByRole('region', { name: 'Now' }), spend())).toBe(true)
    expect(after(screen.getByRole('region', { name: 'Context' }), spend())).toBe(true)
    fireEvent.click(within(spend()).getByRole('button', { name: /^The bars show cost/ }))
    const menu = within(spend()).getByRole('menu', { name: 'What the bars show' })
    expect(within(menu).getAllByRole('menuitemradio').map((b) => b.textContent?.split(/[$\d—]/)[0])).toEqual(['Cost', 'Burn rate', 'Tokens', 'Turns'])
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: /^Tokens/ }))
    expect(stored()).toMatchObject({ chartBy: 'tokens', v: 6 })
    expect(spend().querySelector('[data-spend-time]')).toHaveAttribute('data-metric', 'tokens')
    expect(spend().querySelector('[data-spend-total]')).toHaveTextContent('950.1k')
    fireEvent.click(within(spend()).getByRole('button', { name: /^Spend$/ }))
    expect(within(spend()).getByRole('button', { name: 'Spend 950.1k tok · $1.84 · 12 turns' })).toBeInTheDocument()
  })

  it('opens a choice stored before the chart was the default on the chart, once', async () => {
    localStorage.setItem('caprock.app.cockpit.spend', JSON.stringify({ folded: true, headline: 'cost', view: 'numbers', period: '7d' }))
    h.summaries = { '7d': { range: '7d', cost_usd: 84.5, tokens_in: 0, cache_read: 0, cache_write: 0, savings: { hit_rate: 0 }, projects: [] } as unknown as Summary }
    const { unmount } = await act(async () => show(agent()))
    expect(spend()).toHaveAttribute('data-spend-view', 'chart')
    // A stored period served every tab; each tab opens on its session now.
    expect(spend()).toHaveAttribute('data-spend-period', 'session')
    // A pick after that holds.
    showNumbers()
    expect(stored()).toMatchObject({ view: 'numbers', v: 6 })
    unmount()
    resetSpendPrefsForTest()
    await act(async () => { show(agent()) })
    expect(spend()).toHaveAttribute('data-spend-view', 'numbers')
  })

  it('remembers Numbers, and never repeats a figure beside the agent there', async () => {
    const { unmount } = await act(async () => show(agent()))
    showNumbers()
    expect(spend()).toHaveAttribute('data-spend-view', 'numbers')
    expect(within(spend()).getByRole('button', { name: 'Numbers' })).toHaveAttribute('aria-pressed', 'true')
    // Spent, burn rate and tokens are beside the agent already: the slots show the next ones.
    expect(slots()).toEqual(['last', 'time', 'cache'])
    expect(spend().querySelector('[data-spend-time]')).toBeNull()
    expect(stored().view).toBe('numbers')
    unmount()
    resetSpendPrefsForTest()
    show(agent())
    expect(spend()).toHaveAttribute('data-spend-view', 'numbers')
  })

  it('reads the figures and the chart from the session, then from each range’s summary', async () => {
    h.summaries = {
      '7d': { range: '7d', cost_usd: 84.5, tokens_in: 1_000, cache_read: 9_000, cache_write: 0, turns: 30, tool_calls: 90, savings: { hit_rate: 0.9 }, projects: [{ project: 'a', spark: { from_ms: 0, width_ms: 86_400_000, cost: [1, 0, 2], tokens: [] } }, { project: 'b', spark: { from_ms: 0, width_ms: 86_400_000, cost: [0, 3, 1], tokens: [] } }] } as unknown as Summary,
      '30d': { range: '30d', cost_usd: 310, tokens_in: 0, cache_read: 0, cache_write: 0, savings: { hit_rate: 0 }, projects: [] } as unknown as Summary,
    }
    const today = { ...summary, range: 'today', cost_usd: 12.25, tokens_in: 500, cache_read: 1_500, cache_write: 0, savings: { hit_rate: 0.75 }, projects: [] } as unknown as Summary
    await act(async () => { show(agent(), today) })
    showNumbers()
    const fig = (name: RegExp) => within(spend()).getByLabelText(name)
    expect(fig(/^Cache hit rate, this session/)).toHaveTextContent('95%')
    expect(within(spend()).getByRole('button', { name: 'session' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(within(spend()).getByRole('button', { name: 'today' }))
    // Today is the summary the window already holds: no extra request. A
    // Caprock-wide figure is not the ones beside the agent, so Spent is back.
    expect(slots()).toEqual(['cost', 'tokens', 'cache'])
    expect(fig(/^Spent, today · all sessions/)).toHaveTextContent('$12.25')
    expect(fig(/^Cache hit rate, today/)).toHaveTextContent('75%')
    expect(h.summaryAsked).toEqual([])
    await act(async () => { fireEvent.click(within(spend()).getByRole('button', { name: '7d' })) })
    expect(h.summaryAsked).toEqual(['7d'])
    expect(fig(/^Spent, 7 days/)).toHaveTextContent('$84.50')
    expect(fig(/^Tokens, 7 days/)).toHaveTextContent('10.0k')
    expect(fig(/^Cache hit rate, 7 days/)).toHaveTextContent('90%')
    // The chart: the projects' sparks summed bucket by bucket, [1, 3, 3].
    fireEvent.click(within(spend()).getByRole('button', { name: 'Chart' }))
    const chart = within(spend()).getByRole('group', { name: 'Spend by 1 day, 7 days · all sessions' })
    expect(chart.querySelectorAll('rect')).toHaveLength(3)
    expect(chart.querySelector('[data-spend-total]')).toHaveTextContent('$84.50')
    // At rest the total; a step reads the newest stretch with spend in its place.
    expect(chart.querySelector('[data-spend-readout]')).toBeNull()
    fireEvent.keyDown(chart, { code: 'ArrowRight', key: 'ArrowRight' })
    expect(chart.querySelector('[data-spend-readout]')).toHaveTextContent('$3.00')
    expect(chart.querySelector('[data-spend-total]')).toBeNull()
    await act(async () => { fireEvent.click(within(spend()).getByRole('button', { name: '30d' })) })
    // No spark in the range: it says so, never an empty line.
    expect(spend().querySelector('[data-spend-empty]')).toHaveTextContent('no spend by time to draw')
    expect(within(spend()).queryByRole('group', { name: /^Spend by/ })).toBeNull()
    showNumbers()
    expect(fig(/^Spent, 30 days/)).toHaveTextContent('$310.00')
    // No input in the range: no cache rate, a dash rather than a zero.
    expect(fig(/^Cache hit rate, 30 days/)).toHaveTextContent('—')
    expect(stored()).toMatchObject({ view: 'numbers' })
    expect(stored()).not.toHaveProperty('period')
  })

  it('lays the numbers out to shrink: min-w-0 down the chain, three equal columns', async () => {
    await act(async () => { show(agent()) })
    showNumbers()
    const block = spend().querySelector('[data-spend-numbers]')!
    expect(block.className).toMatch(/\bmin-w-0\b/)
    expect(block.className).toMatch(/grid-cols-\[minmax\(0,1fr\)\]/)
    const dl = block.querySelector('dl')!
    expect(dl.className).toMatch(/\bgrid-cols-3\b/)
    expect(dl.className).toMatch(/\bmin-w-0\b/)
    for (const d of Array.from(dl.children)) expect(d.className).toMatch(/\bmin-w-0\b/)
    for (const dd of Array.from(dl.querySelectorAll('dd'))) expect(dd.className).toMatch(/\btruncate\b/)
  })

  it('lets each figure pick what it shows, swaps rather than repeats, and remembers it', async () => {
    await act(async () => { show(agent({ started_at: now - 72 * 60_000, worked_at: now })) })
    showNumbers()
    const menuOf = (i: number) => fireEvent.click(within(spend()).getAllByRole('button', { name: /Choose what this figure shows/ })[i]!)
    menuOf(0)
    const menu = within(spend()).getByRole('menu', { name: 'What figure 1 shows' })
    // The figures beside the agent are not offered again for the session.
    for (const name of [/Spent/, /Burn rate/, /Tokens/]) expect(within(menu).getByRole('menuitemradio', { name })).toBeDisabled()
    expect(within(menu).getByRole('menuitemradio', { name: /Last call/ })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: /Turns/ }))
    expect(slots()).toEqual(['turns', 'time', 'cache'])
    expect(within(spend()).getByLabelText(/^Time working, this session/)).toHaveTextContent('1h 12m')
    // Picking what another figure shows swaps the two.
    menuOf(2)
    fireEvent.click(within(spend()).getByRole('menuitemradio', { name: /Time working/ }))
    expect(slots()).toEqual(['turns', 'cache', 'time'])
    expect(stored().slots).toEqual(['turns', 'cache', 'time'])
    expect(within(spend()).queryByRole('menu')).toBeNull()
  })

  it('opens each tab on its own session, keeps a period to its tab, and says whose figures a folded strip shows', async () => {
    h.summaries = { '7d': { range: '7d', cost_usd: 84.5, tokens_in: 0, cache_read: 0, cache_write: 0, savings: { hit_rate: 0 }, projects: [] } as unknown as Summary }
    const today = { ...summary, range: 'today', cost_usd: 12.25, tokens_in: 500, cache_read: 1_500, cache_write: 0, savings: { hit_rate: 0.75 }, projects: [] } as unknown as Summary
    const one = agent()
    const two = agent({ session_id: 's2', stats: { ...agent().stats!, session_id: 's2', cost_usd: 7.5 } })
    const view = (s: SessionSummary) => <Inspector session={s} sessionId={s.session_id} hasPermission={false} onClose={() => {}} onDetach={() => {}} summary={today} />
    const { rerender } = await act(async () => render(view(one)))
    expect(spend()).toHaveAttribute('data-spend-period', 'session')
    expect(spend().querySelector('[data-spend-total]')).toHaveTextContent('$1.84')
    fireEvent.click(within(spend()).getByRole('button', { name: 'today' }))
    expect(spend()).toHaveAttribute('data-spend-period', 'today')
    // Another tab opens on its own agent's spend, not the Caprock-wide today.
    await act(async () => { rerender(view(two)) })
    expect(spend()).toHaveAttribute('data-spend-period', 'session')
    expect(spend().querySelector('[data-spend-total]')).toHaveTextContent('$7.50')
    // Folded, the strip draws the session's own bars and says so.
    fireEvent.click(within(spend()).getByRole('button', { name: /^Spend$/ }))
    const strip = () => spend().querySelector('[data-spend-folded]')!
    expect(strip().querySelector('[data-fold-period]')).toHaveTextContent(/^session$/)
    expect(strip().querySelectorAll('rect').length).toBeGreaterThan(0)
    expect(strip()).toHaveTextContent('$7.50')
    // The first tab kept its pick; its strip says it is every session's.
    await act(async () => { rerender(view(one)) })
    expect(strip().querySelector('[data-fold-period]')).toHaveTextContent(/^today · all$/)
    expect(strip()).toHaveTextContent('$12.25')
    expect(stored()).not.toHaveProperty('period')
  })

  it('draws the chart in the flow of the block, never over it', async () => {
    await act(async () => { show(agent()) })
    expect(within(spend()).getByRole('button', { name: 'Chart' })).toHaveAttribute('aria-pressed', 'true')
    const chart = spend().querySelector('[data-spend-time]')!
    expect(chart).toBeTruthy()
    expect(chart.className).not.toMatch(/\b(absolute|fixed)\b/)
    expect(spend().querySelector('[role="dialog"]')).toBeNull()
  })
})

describe('the headline against your usual', () => {
  // The session's burn: $0.11 over the five-minute floor, $1.32/h.
  const SHAPE = [0.003, 0.03, 0.08, 0.22, 0.56, 1, 1.65, 2.6, 3.7, 6, 22.7]
  const dist = (median: number) => ({ n: 362, q: SHAPE.map((k) => k * median) })
  const withUsual = (u: Partial<NonNullable<Summary['usual']>> | undefined) =>
    ({ ...summary, usual: u ? { days: 30, ...u } : undefined }) as Summary
  const delta = () => document.querySelector('[data-hero-fig] [data-usual]')
  const pick = (m: string) => localStorage.setItem('caprock.app.cockpit.spend', JSON.stringify({ v: 3, hero: [m, 'burn', 'cost'] }))

  it('says above, with the full sentence on hover, toned only in the top fifth', async () => {
    await act(async () => { show(agent(), withUsual({ burn: dist(0.956) })) })
    expect(delta()).toHaveTextContent('▲ 38%')
    expect(delta()).toHaveAttribute('data-usual', 'above')
    expect(delta()).toHaveAttribute('title', '38% above your usual $0.96/h (the median active session-hour, 30 days) · higher than 56% of your session-hours')
    expect(delta()!.className).toMatch(/text-fg-muted/)
  })

  it('says a far-above figure as a multiple, in amber', async () => {
    await act(async () => { show(agent(), withUsual({ burn: dist(0.293) })) })
    expect(delta()).toHaveTextContent('▲ 4.5×')
    expect(delta()!.className).toMatch(/text-warn/)
  })

  it('says near as about usual, and below with a down arrow', async () => {
    let unmount = () => {}
    await act(async () => { unmount = show(agent(), withUsual({ burn: dist(1.27) })).unmount })
    expect(delta()).toHaveTextContent('≈ usual')
    expect(delta()).toHaveAttribute('data-usual', 'near')
    unmount()
    await act(async () => { show(agent(), withUsual({ burn: dist(2.93) })) })
    expect(delta()).toHaveTextContent('▼ 55%')
    expect(delta()).toHaveAttribute('data-usual', 'below')
  })

  it('shows nothing, and moves nothing, with no history yet', () => {
    show(agent(), withUsual(undefined))
    expect(delta()).toBeNull()
    expect(document.querySelector('[data-usual-on]')).toBeNull()
    expect(screen.getByRole('button', { name: /Headline: Burn rate/ })).toBeInTheDocument()
  })

  it('compares tokens with your median session', () => {
    pick('tokens')
    show(agent(), withUsual({ tokens: dist(688_478) }))
    expect(delta()).toHaveTextContent('▲ 38%')
    expect(delta()!.getAttribute('title')).toMatch(/^38% above your median session, 688\.5k tokens \(30 days\) · already more than 56% of your sessions$/)
  })

  it('compares the cache rate in points, and steps the long name down beside it', () => {
    pick('cache')
    show(agent(), withUsual({ cache: 97.4 }))
    expect(delta()).toHaveTextContent('▼ 2 pts')
    expect(delta()).toHaveAttribute('title', '2 pts below your 30-day hit rate of 97.4%')
    const row = document.querySelector('[data-usual-on]')!
    expect(row.querySelector('[data-label-long]')).toHaveTextContent('cache hit rate')
    expect(row.querySelector('[data-label-short]')).toHaveTextContent('cache')
  })
})

describe('a session sharing its checkout', () => {
  it('says so on one line, a warning when both edited the same file', async () => {
    h.overlap = { window_minutes: 30, sessions: { s1: { checkout: '/w', with: [{ session_id: 's2', name: 'Router', name_source: 'name', started_at: 5, files: ['/w/internal/session.go'] }] } } }
    show(agent())
    const chip = await screen.findByText('1 file touched by both')
    expect(chip.parentElement!.getAttribute('aria-label')).toMatch(/Router[\s\S]*internal\/session\.go/)
    fireEvent.focus(chip.parentElement!)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('internal/session.go')
    h.overlap = { window_minutes: 30, sessions: {} }
  })

  it('shows nothing for an ended session', async () => {
    h.overlap = { window_minutes: 30, sessions: { s1: { checkout: '/w', with: [{ session_id: 's2', name: 'Router', name_source: 'name', started_at: 5, files: [] }] } } }
    show(agent({ status: 'ended' }))
    await act(async () => {})
    expect(screen.queryByText(/shares checkout/)).not.toBeInTheDocument()
    h.overlap = { window_minutes: 30, sessions: {} }
  })
})

describe('the recent tool calls', () => {
  const pre = (id: number, agoMs: number, tool: string, input: unknown, use: string): Event =>
    ({ id, ts: iso(agoMs), session_id: 's1', source: 'hook', kind: 'tool.pre', tool, payload: { tool_use_id: use, tool_input: input } })
  const post = (id: number, agoMs: number, tool: string, use: string, extra: Record<string, unknown> = {}): Event =>
    ({ id, ts: iso(agoMs), session_id: 's1', source: extra.is_error ? 'transcript' : 'hook', kind: 'tool.post', tool, payload: { tool_use_id: use, ...extra } })

  // "Honestly gives little information — the indicators say nothing, the
  // time is clear, OK" (owner, 2026-10-14, translated).
  it('says how each call ended, what it acted on, and folds repeats', async () => {
    h.events = [
      pre(1, 600_000, 'Bash', { command: 'S=/tmp/claude-501/x/scratchpad python3 /tmp/claude-501/x/scratchpad/shots.py --out a' }, 'a'),
      post(2, 599_700, 'Bash', 'a'),
      pre(3, 300_000, 'Read', { file_path: '/w/ui/src/lib/cockpit.ts' }, 'b'),
      post(4, 299_900, 'Read', 'b'),
      pre(5, 290_000, 'Read', { file_path: '/w/ui/src/lib/cockpit.ts' }, 'c'),
      post(6, 289_900, 'Read', 'c'),
      pre(7, 280_000, 'Read', { file_path: '/w/ui/src/lib/cockpit.ts' }, 'd'),
      post(8, 279_900, 'Read', 'd'),
      pre(9, 120_000, 'Bash', { command: 'cd /w && go test ./internal/api', description: 'Run the API tests' }, 'e'),
      post(10, 80_000, 'Bash', 'e', { is_error: true, tool_response: 'Exit code 1\nFAIL github.com/x/internal/api' }),
      pre(11, 2_000, 'Edit', { file_path: '/w/internal/session.go' }, 'f'),
    ]
    show(agent())
    const list = screen.getByRole('region', { name: 'Recent tool calls' })
    await within(list).findByText('internal/session.go')
    const rows = within(list).getAllByRole('listitem')
    expect(rows).toHaveLength(4)
    const [edit, test, read, shot] = rows
    // Running now: green elapsed time.
    expect(edit).toHaveAttribute('data-tool-row', 'running')
    // A failure: its exit code, the program and what it ran, not the cd.
    expect(test).toHaveAttribute('data-tool-row', 'failed')
    expect(test!.querySelector('[data-tool-target]')).toHaveTextContent(/^go test \.\/internal\/api$/)
    expect(test!.querySelector('[data-tool-outcome]')).toHaveTextContent('exit 1')
    expect(test!.querySelector('[data-tool-age]')).toHaveTextContent('1m')
    expect(test).toHaveAttribute('title', expect.stringContaining('Run the API tests'))
    // Three reads of one file in a row: one row, ×3, relative to the folder, a quiet ✓.
    expect(read!.querySelector('[data-tool-target]')).toHaveTextContent(/^ui\/src\/lib\/cockpit\.ts$/)
    expect(read!.querySelector('[data-tool-repeat]')).toHaveTextContent('×3')
    expect(read!.querySelector('[data-tool-outcome]')).toHaveTextContent('✓')
    expect(read!.querySelector('[data-tool-outcome]')).toHaveAttribute('aria-label', 'succeeded in 0.1s')
    // The variable assignment ahead of the program is not the target.
    expect(shot!.querySelector('[data-tool-target]')).toHaveTextContent(/^python3 …\/scratchpad\/shots\.py$/)
    expect(shot).not.toHaveTextContent('S=/tmp')
    // No bar; the heading says what the total counts, and the failures.
    expect(list.querySelector('[role="meter"]')).toBeNull()
    expect(list.querySelector('[data-tools-total]')).toHaveTextContent('40 this session')
    expect(list.querySelector('[data-tools-failed]')).toHaveTextContent('1 failed')
  })

  it('shows a slow call’s duration and a quick one’s tick', async () => {
    show(agent())
    const list = screen.getByRole('region', { name: 'Recent tool calls' })
    await within(list).findByText('Edit')
    const bash = within(list).getAllByRole('listitem')[1]!
    expect(bash).toHaveAttribute('data-tool-row', 'slow')
    expect(bash.querySelector('[data-tool-outcome]')).toHaveTextContent('38s')
  })
})

// "Subagents and Recent tools should be collapsible like Context, Plan,
// Spend" (owner, 2026-10-14, translated).
describe('folding Subagents and Recent tools', () => {
  it('folds each on its label to one line, and remembers it', async () => {
    h.subagents = {
      working: [{ agent_id: 'a1', agent_type: 'Explore', description: 'Map the store', tool_calls: 4, started_at: now - 125_000, last_at: now - 1_000, tool: 'Read', detail: 'a.go', tool_at: now - 3_000, running: true, asking: false, cost_usd: 0.42 }],
      finished: 2,
      cost_usd: 0.42,
    }
    try {
      const { unmount } = show(agent({ live_subagents: 1 }))
      const subs = () => screen.getByRole('region', { name: 'Subagents' })
      const tools = () => screen.getByRole('region', { name: 'Recent tool calls' })
      await screen.findByRole('region', { name: 'Subagents' })
      expect(subs()).toHaveAttribute('data-look', 'full')
      expect(tools()).toHaveAttribute('data-look', 'full')
      const subLabel = within(subs()).getByRole('button', { name: 'Subagents · 1' })
      expect(subLabel).toHaveAttribute('aria-expanded', 'true')
      fireEvent.click(subLabel)
      expect(subs()).toHaveAttribute('data-look', 'compact')
      expect(within(subs()).queryByRole('listitem')).toBeNull()
      expect(subs().querySelector('[data-fold-summary]')).toHaveTextContent('2 finished$0.42')
      await within(tools()).findByText('Edit')
      fireEvent.click(within(tools()).getByRole('button', { name: 'Recent tools' }))
      expect(tools()).toHaveAttribute('data-look', 'compact')
      expect(within(tools()).queryByRole('listitem')).toBeNull()
      expect(tools().querySelector('[data-fold-summary]')).toHaveTextContent(/^Editinternal\/session\.go/)
      expect(JSON.parse(localStorage.getItem(LOOKS_KEY)!)).toMatchObject({ subagents: 'compact', tools: 'compact' })
      unmount()
      resetLooksForTest()
      show(agent({ live_subagents: 1 }))
      await screen.findByRole('region', { name: 'Subagents' })
      expect(subs()).toHaveAttribute('data-look', 'compact')
      expect(tools()).toHaveAttribute('data-look', 'compact')
      // A chip under the agent opens its row: the section unfolds for it.
      fireEvent.click(await screen.findByRole('button', { name: /Map the store.*Open/ }))
      expect(subs()).toHaveAttribute('data-look', 'full')
      fireEvent.click(within(tools()).getByRole('button', { name: 'Recent tools' }))
      expect(tools()).toHaveAttribute('data-look', 'full')
    } finally {
      h.subagents = { working: [], finished: 0 }
    }
  })
})

// "Every section — the CI and Processes too" (owner, 2026-10-14, translated).
describe('folding every other section', () => {
  it('folds Now and Changes on their label to the line the label carries, and remembers it', async () => {
    const { unmount } = show(agent())
    const changes = () => document.querySelector('[data-fold="changes"]')!
    await within(screen.getByRole('region', { name: 'Changes' })).findByText('1 file')
    const label = within(screen.getByRole('region', { name: 'Changes' })).getByRole('button', { name: 'Changes' })
    expect(label).toHaveAttribute('aria-expanded', 'true')
    expect(changes()).not.toHaveAttribute('data-folded')
    fireEvent.click(label)
    expect(changes()).toHaveAttribute('data-folded')
    expect(changes().querySelector('[data-fold-only]')).toHaveTextContent('1 file +12 −3')
    const nowLabel = within(screen.getByRole('region', { name: 'Now' })).getByRole('button', { name: 'Now' })
    fireEvent.click(nowLabel)
    expect(document.querySelector('[data-fold="now"]')).toHaveAttribute('data-folded')
    expect(document.querySelector('[data-fold="now"] [data-fold-only]')).toHaveTextContent('Editing')
    expect(JSON.parse(localStorage.getItem(LOOKS_KEY)!)).toMatchObject({ now: 'compact', changes: 'compact', ci: 'full', processes: 'full' })
    unmount()
    resetLooksForTest()
    show(agent())
    expect(changes()).toHaveAttribute('data-folded')
    fireEvent.click(within(screen.getByRole('region', { name: 'Changes' })).getByRole('button', { name: 'Changes' }))
    expect(changes()).not.toHaveAttribute('data-folded')
  })
})

// "I want to be able to reorder the sections, but so it doesn't trigger by
// accident — so everyone sets up what interests them" (owner, 2026-10-14,
// translated).
describe('arranging the cockpit', () => {
  const regions = () => ['Now', 'Context', 'Plan limits', 'Spend', 'Recent tool calls']
    .map((name) => screen.getByRole('region', { name }))
    .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
    .map((r) => r.getAttribute('aria-label'))

  it('moves a section only in Arrange mode, keeps the order, and resets it', () => {
    const { unmount } = show(agent())
    expect(regions()).toEqual(['Now', 'Context', 'Plan limits', 'Spend', 'Recent tool calls'])
    expect(screen.queryByRole('button', { name: /Move .* up/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Arrange sections' }))
    const arrange = screen.getByRole('region', { name: 'Arrange sections' })
    // The sections give way to the list while arranging.
    expect(screen.queryByRole('region', { name: 'Spend' })).toBeNull()
    expect(within(arrange).getByRole('button', { name: 'Move Now up' })).toBeDisabled()
    expect(within(arrange).getByRole('button', { name: 'Reset to default order' })).toBeDisabled()
    within(arrange).getByRole('button', { name: 'Move Recent tools up' }).focus()
    for (let i = 0; i < 5; i++) fireEvent.click(within(arrange).getByRole('button', { name: 'Move Recent tools up' }))
    // The focus stays on the button pressed, so it can be pressed again.
    expect(document.activeElement).toHaveAccessibleName('Move Recent tools up')
    fireEvent.click(within(arrange).getByRole('button', { name: 'Move Spend up' }))
    expect(within(arrange).getAllByRole('listitem').map((li) => li.textContent?.replace(/[↑↓\d]/g, ''))).toEqual(
      ['Now', 'Recent tools', 'Context', 'Spend', 'Plan limits', 'Subagents', 'Tasks', 'Changes', 'CI', 'Release', 'Processes'])
    expect(JSON.parse(localStorage.getItem(ORDER_KEY)!)).toEqual(['now', 'tools', 'context', 'spend', 'limits', 'subagents', 'tasks', 'changes', 'ci', 'release', 'processes'])
    fireEvent.click(within(arrange).getByRole('button', { name: 'Done' }))
    expect(regions()).toEqual(['Now', 'Recent tool calls', 'Context', 'Spend', 'Plan limits'])
    // A fresh page reads the order back.
    unmount()
    resetOrderForTest()
    show(agent())
    expect(regions()).toEqual(['Now', 'Recent tool calls', 'Context', 'Spend', 'Plan limits'])
    fireEvent.click(screen.getByRole('button', { name: 'Arrange sections' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reset to default order' }))
    expect(localStorage.getItem(ORDER_KEY)).toBeNull()
    // Esc leaves, as Done does.
    fireEvent.keyDown(screen.getByRole('region', { name: 'Arrange sections' }), { code: 'Escape' })
    expect(screen.queryByRole('region', { name: 'Arrange sections' })).toBeNull()
    expect(regions()).toEqual(['Now', 'Context', 'Plan limits', 'Spend', 'Recent tool calls'])
  })

  it('reads a broken stored order as the default', () => {
    localStorage.setItem(ORDER_KEY, '{nope')
    show(agent())
    expect(regions()).toEqual(['Now', 'Context', 'Plan limits', 'Spend', 'Recent tool calls'])
  })
})
