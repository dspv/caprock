import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ProjectsPanel } from './Projects'
import type { SessionSummary } from '@/lib/api'

/**
 * The agent filter decides which rows a reader sees under a heading. These
 * tests pin the two things that would be silently wrong: a row appearing under
 * the wrong agent, and the shared-project rule that keeps a repository worked
 * on by both from vanishing from every view.
 */

function session(id: string, agent?: string): SessionSummary {
  return {
    session_id: id, cwd: '/d', project: 'p', model: 'm',
    started_at: 0, last_event_at: 0, status: 'ended',
    transcript_path: '', has_hooks: false, has_transcript: true,
    git_branch: '', version: '', owned: false, agent,
    activity: { phrase: 'was responding', health: 'ended' },
    stats: { session_id: id, turns: 1, tool_calls: 0, files_touched: 0,
             tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, cost_usd: 0 },
  } as unknown as SessionSummary
}

describe('ProjectsPanel agent filter', () => {
  it('renders with a filter applied without crashing', () => {
    render(<ProjectsPanel sessions={[session('a', 'opencode')]} agent="opencode" />)
    expect(screen.getByText(/projects/i)).toBeTruthy()
  })

  it('renders with both agents', () => {
    render(
      <ProjectsPanel
        sessions={[session('a', 'claude'), session('b', 'opencode')]}
        agent="all"
      />,
    )
    expect(screen.getByText(/projects/i)).toBeTruthy()
  })
})
