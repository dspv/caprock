import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
}))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      subagents: async () => h.subagents,
      todos: async () => ({ items: [], updated_at: 0 }),
      recentMainEvents: async (_id: string, kinds: string[]) => { h.mainAsked.push(kinds); return events },
      permission: async () => ({ permission: h.permission }),
      sessionCalls: async () => [],
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

beforeEach(() => {
  localStorage.clear()
  resetSpendPrefsForTest()
  h.summaries = {}
  h.summaryAsked = []
})

/** Open the folded spend details, in the Full view unless told otherwise (Compact is the default). */
function unfoldSpend(view: 'compact' | 'full' = 'full') {
  const region = screen.getByRole('region', { name: 'Spend' })
  fireEvent.click(within(region).getByRole('button', { expanded: false }))
  if (view === 'full') fireEvent.click(within(region).getByRole('button', { name: 'Full' }))
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
    show(agent())
    expect(screen.getByRole('heading', { name: 'Agent' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Working')
    expect(screen.getByLabelText('Cost $1.84')).toBeInTheDocument()
    expect(screen.getByRole('meter', { name: 'Context used' })).toHaveAttribute('aria-valuenow', '62')
    expect(screen.getByText(/re-reads it for/)).toHaveTextContent('$0.03')
    const timeline = screen.getByRole('region', { name: 'Recent tool calls' })
    await within(timeline).findByText('Edit')
    expect(within(timeline).getByText('go test ./internal/...')).toBeInTheDocument()
    expect(within(timeline).getByText('38s')).toBeInTheDocument()
    const nowCard = screen.getByRole('region', { name: 'Now' })
    expect(within(nowCard).getByText('Editing')).toBeInTheDocument()
    expect(within(nowCard).getByText('session.go')).toBeInTheDocument()
    unfoldSpend()
    expect(screen.getByText(/last call/)).toHaveTextContent('$0.07')
    expect(screen.getByRole('meter', { name: '5 hours window used' })).toHaveAttribute('aria-valuenow', '41')
    // One line: when it resets, and whether it lasts (owner, 2026-10-11).
    expect(document.querySelector('[data-window="5 hours"]')?.textContent).toMatch(/resets in/)
    expect(await screen.findByText('1 file')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('warns of a loop only when there is one', () => {
    show(agent({ loop: { kind: 'loop', session_id: 's1', tool: 'Bash', count: 7, window_min: 3, sample: 'npm test', first_ts: iso(90_000), last_ts: iso(5_000), ts: iso(5_000), tax_usd: 0.42 } }))
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Same Bash call ×7')
    expect(alert).toHaveTextContent('$0.42')
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
    unfoldSpend()
    expect(screen.getByText(/last call/)).toHaveTextContent('$0.07')
  })

  it('lists the subagents at work: type, task, current call, calls made, and who waits on you', async () => {
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
      expect(rows[0]).toHaveTextContent('general-purpose· Fix the cockpit')
      expect(rows[0]).toHaveTextContent('Bashgo test ./...')
      expect(rows[0]).toHaveTextContent(/\d+s · 42 calls/)
      expect(rows[1]).toHaveTextContent('Editsession.go')
      expect(rows[1]).toHaveTextContent('7 calls')
      expect(rows[1]).not.toHaveTextContent('waiting on you')
      expect(rows[2]).toHaveTextContent('waiting on you')
      expect(rows[2]).toHaveTextContent('1 call')
    } finally {
      h.subagents = { working: [], finished: 0 }
    }
  })

  // "In subagents I don't see which model is used and costs" (owner,
  // 2026-10-09, translated). A cost the daemon does not know is not drawn.
  it('shows each subagent’s model, time and cost, the finished ones muted, and the total', async () => {
    h.subagents = {
      working: [
        { agent_id: 'a1', agent_type: 'general-purpose', tool_calls: 4, started_at: now - 125_000, last_at: now - 1_000, tool: 'Bash', detail: 'go test ./...', tool_at: now - 3_000, running: true, asking: false, model: 'claude-haiku-4-5', model_display: 'Haiku 4.5', cost_usd: 0.42 },
        { agent_id: 'b2', agent_type: 'Explore', tool_calls: 1, started_at: now - 9_000, last_at: now - 2_000, tool: 'Read', detail: 'a.go', tool_at: now - 4_000, running: false, asking: false, model_display: 'Sonnet 4.5' },
      ],
      finished: 2,
      recent: [{ agent_id: 'c3', agent_type: 'Explore', tool_calls: 6, started_at: now - 300_000, stopped_at: now - 180_000, model_display: 'Sonnet 4.5', cost_usd: 1.1 }],
      cost_usd: 1.52,
    }
    try {
      show(agent({ live_subagents: 2 }))
      const section = await screen.findByRole('region', { name: 'Subagents' })
      expect(section).toHaveTextContent('Subagents · 2')
      expect(section).toHaveTextContent('$1.52')
      expect(section).toHaveTextContent('+1 finished')
      const [a, b] = within(section).getAllByRole('listitem')
      expect(a).toHaveTextContent(/Haiku 4\.5 · 2m 0\ds/)
      expect(a).toHaveTextContent('4 calls · $0.42')
      expect(b).toHaveTextContent('Sonnet 4.5')
      expect(b).not.toHaveTextContent('$')
      const done = within(section).getByRole('list', { name: 'Finished subagents' })
      expect(done).toHaveTextContent('Sonnet 4.5 · 2m 00s · $1.10')
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
    expect(screen.getByRole('status')).toHaveTextContent('Background agents working · 1')
    expect(screen.getByRole('status')).not.toHaveTextContent('Waiting')
    const nowCard = screen.getByRole('region', { name: 'Now' })
    expect(within(nowCard).getByText('Background agents working · 1')).toBeInTheDocument()
    expect(within(nowCard).queryByText(/Waiting|Thinking/)).toBeNull()
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

describe('the spend details', () => {
  const spend = () => screen.getByRole('region', { name: 'Spend' })
  const stored = () => JSON.parse(localStorage.getItem('caprock.app.cockpit.spend') ?? '{}')

  it('folds to one line by default, and remembers when it is opened', () => {
    const { unmount } = show(agent({ started_at: now - 72 * 60_000, worked_at: now }))
    const toggle = within(spend()).getByRole('button', { name: /Spent \$1\.84 · 12 turns · 1h 12m/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(within(spend()).queryByText('Turns')).toBeNull()
    fireEvent.click(toggle)
    expect(within(spend()).getByRole('button', { name: /^Spend$/ })).toHaveAttribute('aria-expanded', 'true')
    expect(stored().folded).toBe(false)
    unmount()
    resetSpendPrefsForTest()
    show(agent())
    expect(within(spend()).getByText('Tokens')).toBeInTheDocument()
  })

  it('opens Compact by default and remembers Full, and the fold works in both', () => {
    const { unmount } = show(agent())
    unfoldSpend('compact')
    expect(spend()).toHaveAttribute('data-spend-view', 'compact')
    expect(within(spend()).getByRole('button', { name: 'Compact' })).toHaveAttribute('aria-pressed', 'true')
    expect(Array.from(spend().querySelectorAll('dt')).map((d) => d.textContent)).toEqual(['Spent', 'Tokens', 'Cache'])
    expect(within(spend()).queryByRole('button', { name: /Spend over time/ })).toBeNull()
    fireEvent.click(within(spend()).getByRole('button', { name: 'Full' }))
    expect(stored().view).toBe('full')
    expect(within(spend()).getByRole('button', { name: /Spent this session/ })).toBeInTheDocument()
    expect(within(spend()).getByRole('button', { name: /Spend over time/ })).toBeInTheDocument()
    unmount()
    resetSpendPrefsForTest()
    show(agent())
    expect(spend()).toHaveAttribute('data-spend-view', 'full')
    // Folded, both views read the same one line.
    fireEvent.click(within(spend()).getByRole('button', { expanded: true }))
    expect(spend().querySelector('[data-spend-folded]')).toHaveTextContent('Spent $1.84')
    expect(within(spend()).queryByRole('group', { name: 'Spend view' })).toBeNull()
  })

  it('reads the compact figures from the session, then from each range’s summary', async () => {
    h.summaries = {
      '7d': { range: '7d', cost_usd: 84.5, tokens_in: 1_000, cache_read: 9_000, cache_write: 0, savings: { hit_rate: 0.9 }, projects: [{ project: 'a', spark: { from_ms: 0, width_ms: 1, cost: [1, 0, 2], tokens: [] } }, { project: 'b', spark: { from_ms: 0, width_ms: 1, cost: [0, 3, 1], tokens: [] } }] } as unknown as Summary,
      '30d': { range: '30d', cost_usd: 310, tokens_in: 0, cache_read: 0, cache_write: 0, savings: { hit_rate: 0 }, projects: [] } as unknown as Summary,
    }
    const today = { ...summary, range: 'today', cost_usd: 12.25, tokens_in: 500, cache_read: 1_500, cache_write: 0, savings: { hit_rate: 0.75 }, projects: [] } as unknown as Summary
    show(agent(), today)
    unfoldSpend('compact')
    const fig = (name: RegExp) => within(spend()).getByLabelText(name)
    expect(fig(/^Spent, this session/)).toHaveTextContent('$1.84')
    expect(within(spend()).getByRole('button', { name: 'session' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(within(spend()).getByRole('button', { name: 'today' }))
    // Today is the summary the window already holds: no extra request.
    expect(fig(/^Spent, today · all sessions/)).toHaveTextContent('$12.25')
    expect(fig(/^Cache hit rate, today/)).toHaveTextContent('75%')
    expect(h.summaryAsked).toEqual([])
    expect(spend().querySelector('[data-spend-scope]')).toHaveTextContent('Today · all sessions')
    await act(async () => { fireEvent.click(within(spend()).getByRole('button', { name: '7d' })) })
    expect(h.summaryAsked).toEqual(['7d'])
    expect(fig(/^Spent, 7 days/)).toHaveTextContent('$84.50')
    expect(fig(/^Tokens, 7 days/)).toHaveTextContent('10.0k')
    expect(fig(/^Cache hit rate, 7 days/)).toHaveTextContent('90%')
    // The projects' sparks summed bucket by bucket: [1, 3, 3].
    expect(spend().querySelectorAll('[data-period-spark] rect')).toHaveLength(3)
    await act(async () => { fireEvent.click(within(spend()).getByRole('button', { name: '30d' })) })
    expect(fig(/^Spent, 30 days/)).toHaveTextContent('$310.00')
    // No input in the range: no cache rate, a dash rather than a zero.
    expect(fig(/^Cache hit rate, 30 days/)).toHaveTextContent('—')
    expect(stored().period).toBe('30d')
  })

  it('lays the compact block out to shrink: min-w-0 down the chain, three equal columns', () => {
    show(agent())
    unfoldSpend('compact')
    const block = spend().querySelector('[data-spend-compact]')!
    expect(block.className).toMatch(/\bmin-w-0\b/)
    expect(block.className).toMatch(/grid-cols-\[minmax\(0,1fr\)\]/)
    const dl = block.querySelector('dl')!
    expect(dl.className).toMatch(/\bgrid-cols-3\b/)
    expect(dl.className).toMatch(/\bmin-w-0\b/)
    for (const d of Array.from(dl.children)) expect(d.className).toMatch(/\bmin-w-0\b/)
    for (const dd of Array.from(dl.querySelectorAll('dd'))) expect(dd.className).toMatch(/\btruncate\b/)
    expect(spend().querySelector('[data-spend-scope]')!.className).toMatch(/\bmin-w-0\b.*\btruncate\b|\btruncate\b.*\bmin-w-0\b/)
    const spark = block.querySelector('[data-period-spark]')!
    expect(Number(spark.getAttribute('height') ?? (spark as HTMLElement).style.height.replace('px', ''))).toBeLessThanOrEqual(24)
  })

  it('takes the headline the viewer picks, remembers it, and the cells never repeat it', () => {
    show(agent())
    unfoldSpend()
    const labels = () => Array.from(spend().querySelectorAll('dt')).map((d) => d.textContent)
    expect(labels()).toEqual(['Turns', 'Tools', 'Tokens', 'Cache'])
    fireEvent.click(screen.getByRole('button', { name: /Headline: Cost/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Turns/ }))
    expect(screen.getByLabelText('Turns 12')).toBeInTheDocument()
    expect(labels()).toEqual(['Cost', 'Tools', 'Tokens', 'Cache'])
    expect(stored().headline).toBe('turns')
    resetSpendPrefsForTest()
    expect(screen.queryByRole('menu', { name: 'Headline figure' })).toBeNull()
  })

  it('opens spend over time in the flow of the block, never over it', async () => {
    show(agent())
    unfoldSpend()
    const row = within(spend()).getByRole('button', { name: /Spend over time/ })
    expect(row).toHaveAttribute('aria-expanded', 'false')
    await act(async () => { fireEvent.click(row) })
    expect(row).toHaveAttribute('aria-expanded', 'true')
    const chart = spend().querySelector('[data-spend-time]')!
    expect(chart).toBeTruthy()
    expect(chart.className).not.toMatch(/\b(absolute|fixed)\b/)
    expect(spend().querySelector('[role="dialog"]')).toBeNull()
    expect(stored().chart).toBe(true)
  })
})
