import { describe as d, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { describe } from './Session'
import { SessionCard } from './Now'
import type { Event, SessionSummary } from '@/lib/api'

const base: Event = { id: 1, ts: '2026-08-18T12:00:00Z', session_id: 's', source: 'hook', kind: 'tool.pre', payload: {} }

d('event describe', () => {
  it('renders each kind as one readable line', () => {
    expect(describe({ ...base, tool: 'Bash', payload: { tool_input: { command: 'go test ./...\nsecond' } } }, { tool_input: { command: 'go test ./...\nsecond' } })).toBe('Bash  go test ./...')
    expect(describe({ ...base, kind: 'tool.post', tool: 'Bash' }, { is_error: true, tool_response: 'boom' })).toBe('Bash failed  boom')
    expect(describe({ ...base, kind: 'turn.user' }, { prompt: 'add healthz' })).toBe('you: add healthz')
    expect(describe({ ...base, kind: 'turn.assistant', model: 'claude-opus-5' }, { text: '', tools: ['Edit', 'Bash'] })).toBe('→ Edit, Bash')
    expect(describe({ ...base, kind: 'agent.stop' }, { stop_reason: 'end_turn' })).toBe('turn ended (end_turn)')
    expect(describe({ ...base, kind: 'agent.stop', agent_id: 'a1' }, {})).toBe('subagent a1 stopped')
    expect(describe({ ...base, kind: 'context.compact' }, { trigger: 'auto' })).toBe('context compaction (auto)')
    expect(describe({ ...base, kind: 'weird.new' }, {})).toBe('weird.new')
  })
})

d('SessionCard', () => {
  it('shows narration, badge, plan and numbers', () => {
    const s: SessionSummary = {
      session_id: 'abcdef12-3456', cwd: '/x/proj', project: 'proj', model: 'claude-opus-5', started_at: 0, last_event_at: Date.now(), status: 'active',
      transcript_path: '', has_hooks: true, has_transcript: true, git_branch: 'main', version: '2.1', owned: false,
      stats: { session_id: 'abcdef12-3456', turns: 3, tool_calls: 7, files_touched: 2, tokens_in: 100, tokens_out: 50, cache_read: 1000, cache_write: 200, cost_usd: 0.1234 },
      activity: { phrase: 'editing main.go — 2nd attempt', tool: 'Edit', at: new Date().toISOString(), health: 'working', plan: { done: 1, total: 4, next: 'Run tests' }, repeats: 2 },
      savings: { billed_with: 0, billed_without: 0, saved: 0, hit_rate: 0.77, cut_pct: 60 },
      context: { tokens: 1300, window: 1_000_000, pct: 0.13 },
    }
    render(<SessionCard s={s} now={Date.now()} />)
    expect(screen.getByText('editing main.go — 2nd attempt')).toBeInTheDocument()
    expect(screen.getByText('working')).toBeInTheDocument()
    expect(screen.getByText('1/4')).toBeInTheDocument()
    expect(screen.getByText('$0.12')).toBeInTheDocument()
    expect(screen.getByText('77% cache hit')).toBeInTheDocument()
    expect(screen.getByText('proj')).toBeInTheDocument()
  })
})
