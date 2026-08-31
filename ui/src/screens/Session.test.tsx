import { describe as d, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, SessionScreen } from './Session'
import { SessionCard } from './Now'
import type { DiffResult, Event, SessionDetail, SessionSummary } from '@/lib/api'

const detail = vi.hoisted(() => ({ value: {} as SessionDetail }))
const diffResult = vi.hoisted(() => ({ value: {} as DiffResult }))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      session: async () => detail.value,
      diff: async () => diffResult.value,
      notes: async () => [],
    },
  }
})

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


/**
 * "Live diff" and "Files" were two tabs answering one question between them —
 * what did this session change — so a reader had to visit both and hold the
 * two lists in their head. They are one tab now, and it behaves the way a diff
 * is expected to: every file expands independently, so two changes can be
 * compared side by side.
 */
d('Changes tab', () => {
  const file = (path: string, over: Partial<DiffResult['files'][number]> = {}) => ({
    path, status: 'modified', additions: 2, deletions: 1, patch: `@@ -1 +1 @@\n+in ${path}`, ...over,
  })

  const setup = (files: string[] = ['a.ts', 'b.ts']) => {
    diffResult.value = { root: '/r', branch: 'feature', base: 'since master', stat: '', files: files.map((f) => file(f)) } as DiffResult
    detail.value = {
      session_id: 's', cwd: '/r', project: 'p', model: 'claude-opus-5', status: 'active',
      started_at: 0, last_event_at: Date.now(), git_branch: 'feature',
      has_hooks: true, has_transcript: true, owned: false,
      files: [], events: [],
      stats: {
        session_id: 's', turns: 1, tool_calls: 0, files_touched: 0, cost_usd: 0,
        tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0,
      },
      savings: { hit_rate: 0 },
      activity: { health: 'working', phrase: 'working', at: Date.now() },
    } as unknown as SessionDetail
  }

  it('opens each file independently, so two diffs can be read at once', async () => {
    setup()
    render(<SessionScreen id="s" tab="changes" />)
    const first = await screen.findByText('a.ts')
    const second = await screen.findByText('b.ts')

    first.click()
    await waitFor(() => expect(screen.getByText(/in a\.ts/)).toBeInTheDocument())
    second.click()
    await waitFor(() => expect(screen.getByText(/in b\.ts/)).toBeInTheDocument())
    // The first must still be open: an accordion that closes one to open the
    // other is exactly what makes comparing two changes impossible.
    expect(screen.getByText(/in a\.ts/)).toBeInTheDocument()
  })

  it('expands and collapses everything at once', async () => {
    setup()
    render(<SessionScreen id="s" tab="changes" />)
    const expand = await screen.findByText('expand all')
    expand.click()
    await waitFor(() => expect(screen.getByText(/in a\.ts/)).toBeInTheDocument())
    expect(screen.getByText(/in b\.ts/)).toBeInTheDocument()
    screen.getByText('collapse all').click()
    await waitFor(() => expect(screen.queryByText(/in a\.ts/)).not.toBeInTheDocument())
  })

  // Links to the old tabs are in people's history and in this repo's own docs.
  it('keeps old ?tab=diff and ?tab=files links working', async () => {
    setup(['a.ts'])
    const { unmount } = render(<SessionScreen id="s" tab="diff" />)
    expect(await screen.findByText('a.ts')).toBeInTheDocument()
    unmount()
    render(<SessionScreen id="s" tab="files" />)
    expect(await screen.findByText('a.ts')).toBeInTheDocument()
  })
})
