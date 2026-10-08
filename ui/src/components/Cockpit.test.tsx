import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
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
}))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      subagents: async () => h.subagents,
      recentMainEvents: async (_id: string, kinds: string[]) => { h.mainAsked.push(kinds); return events },
      permission: async () => ({ permission: h.permission }),
      diff: async () => ({ root: '/w', branch: 'main', stat: '', files: [{ path: 'internal/session.go', status: 'modified', additions: 12, deletions: 3 }] }),
    },
  }
})

vi.mock('@/lib/live', async (orig) => {
  const actual = await orig<typeof import('@/lib/live')>()
  return { ...actual, useLive: () => ({ ...actual.useLive(), conn: 'open' }) }
})

import { Inspector } from './Inspector'

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
    expect(screen.getByText(/last call/)).toHaveTextContent('$0.07')
    expect(screen.getByRole('meter', { name: '5-hour window used' })).toHaveAttribute('aria-valuenow', '41')
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

  it('leaves a shell tab the plain inspector', () => {
    show(agent({ kind: 'shell' }))
    expect(screen.getByRole('heading', { name: 'Inspector' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Spend' })).toBeNull()
  })
})
