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
    showNumbers()
    expect(lastCallOffered()).toHaveTextContent('$0.07')
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
      // The type is a letter, its name on hover; the words are what it is doing.
      expect(within(rows[0]!).getByLabelText('general-purpose')).toHaveTextContent('G')
      expect(within(rows[1]!).getByLabelText('Explore')).toHaveTextContent('E')
      expect(rows[0]).toHaveTextContent('Fix the cockpit')
      expect(rows[0]).toHaveTextContent('Bashgo test ./...')
      expect(rows[0]).toHaveTextContent('Fix the cockpit42 calls')
      expect(rows[0]).toHaveTextContent(/go test \.\/\.\.\.\d+s/)
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
  // command (owner, 2026-10-13, translated).
  it('leads a subagent row with what it is doing now', async () => {
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
      // The phrase is the command's own description: the raw command is not repeated.
      expect(a).not.toHaveTextContent('go -C')
      expect(a).toHaveTextContent('9 calls')
      expect(within(b!).getByLabelText('Plan')).toHaveTextContent('P')
      expect(b).toHaveTextContent('starting')
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
    // The state line is short so it never wraps; the count sits under it.
    expect(screen.getByRole('status')).toHaveTextContent('Background agents')
    expect(screen.getByRole('status')).toHaveAttribute('title', 'Background agents working · 1')
    expect(screen.getByRole('status')).not.toHaveTextContent('Waiting')
    expect(document.querySelector('[data-hero-count]')).toHaveTextContent('1 working')
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
    expect(stored()).toMatchObject({ folded: true, v: 4 })
    unmount()
    resetSpendPrefsForTest()
    show(agent())
    const strip = spend().querySelector('[data-spend-folded]')
    expect(strip).toHaveTextContent(/\$1\.84/)
    expect([...strip!.querySelectorAll('[data-fold-fig]')].map((e) => e.getAttribute('data-fold-fig'))).toEqual(['cost', 'tokens', 'turns'])
  })

  it('switches what the bars measure from the ▾, and puts that figure first when folded', async () => {
    await act(async () => show(agent()))
    // Under Now, above the context and the plan.
    const after = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    expect(after(screen.getByRole('region', { name: 'Now' }), spend())).toBe(true)
    expect(after(spend(), screen.getByRole('region', { name: 'Context' }))).toBe(true)
    fireEvent.click(within(spend()).getByRole('button', { name: /^The bars show cost/ }))
    const menu = within(spend()).getByRole('menu', { name: 'What the bars show' })
    expect(within(menu).getAllByRole('menuitemradio').map((b) => b.textContent?.split(/[$\d]/)[0])).toEqual(['Cost', 'Tokens', 'Turns'])
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: /^Tokens/ }))
    expect(stored()).toMatchObject({ chartBy: 'tokens', v: 4 })
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
    expect(spend()).toHaveAttribute('data-spend-period', '7d')
    // A pick after that holds.
    showNumbers()
    expect(stored()).toMatchObject({ view: 'numbers', v: 4 })
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
    expect(stored()).toMatchObject({ period: '30d', view: 'numbers' })
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
