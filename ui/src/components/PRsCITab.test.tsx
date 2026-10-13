import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/lib/api'

const now = Date.now()
const day = (i: number) => new Date(now - (13 - i) * 86_400_000).toISOString().slice(0, 10)

const h = vi.hoisted(() => ({ stats: undefined as unknown, prs: { connected: true, prs: [] as unknown[] } as unknown, ci: {} as Record<number, unknown>, asked: [] as string[], queued: [] as string[], logs: 0 }))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api,
    sessionCIStats: async () => { h.asked.push('stats'); return h.stats },
    sessionPRs: async () => { h.asked.push('prs'); return h.prs },
    sessionCI: async (_id: string, pr?: number) => { h.asked.push(`ci ${pr}`); return h.ci[pr ?? 0] ?? { connected: true } },
    actionsUsage: async () => { h.asked.push('usage'); throw new Error('no billing') },
    sessionCILog: async () => { h.logs++; return { job_id: 72, lines: ['--- FAIL: TestRestore (0.42s)', '##[error]Process completed with exit code 1.'], error_line: 1 } },
    queueSend: async (_id: string, text: string) => { h.queued.push(text); return { sent: true, queue: { session_id: 's1', messages: [], waiting: '' } } },
  } }
})

import { PRsCITab } from './PRsCITab'
import { forgetDeckAnswers } from '@/lib/deckCache'

const session = { session_id: 's1', cwd: '/w', repo_root: '/w', project: 'w', status: 'active', owned: true, agent: 'claude', git_branch: 'fix/x', started_at: 0, last_event_at: now } as unknown as SessionSummary

const job = (id: number, name: string, os: string, conclusion: string | undefined, status = 'completed', ms = 120_000) => ({
  id, run_id: 7, name, os, labels: [], status, conclusion, started_at: now - 6 * 60_000, completed_at: status === 'completed' ? now - 6 * 60_000 + ms : undefined,
  duration_ms: status === 'completed' ? ms : undefined, baseline: { median_ms: 100_000, runs: 5 },
  steps: [{ number: 1, name: 'go test', status: 'completed', conclusion: conclusion === 'failure' ? 'failure' : 'success', duration_ms: 9_000 }],
})

const live = { number: 21, url: 'https://github.com/a/b/pull/21', title: 'Fix the scrollback', state: 'open', draft: false, branch: 'fix/x', base: 'main', head_sha: 'h21', mergeable: true, mergeable_state: 'clean',
  review: '', reviews: [], additions: 181, deletions: 59, changed_files: 13, commits: 2, created_at: now - 14 * 60_000,
  checks: { state: 'fail', passed: 2, failed: 1, pending: 0, items: [{ name: 'go (ubuntu-latest)', state: 'pass' }, { name: 'go (macos-latest)', state: 'fail' }] } }

function connected() {
  h.stats = {
    connected: true, repo: 'a/b', fetched_at: now,
    prs: [{ number: 22, url: 'https://github.com/a/b/pull/22', title: 'Bump deps', state: 'open' }, { number: 21, url: live.url, title: live.title, state: 'open' }, { number: 20, url: 'https://github.com/a/b/pull/20', title: 'Release', state: 'merged', created_at: now - 3_600_000, merged_at: now - 3_000_000 }],
    stats: {
      days: Array.from({ length: 14 }, (_, i) => day(i)), merged: [5, 27, 13, 12, 22, 37, 22, 35, 32, 27, 28, 91, 30, 19], ttm_median_ms: 8 * 60_000, ttm_count: 300, prs_listed: 50,
      ci: { runs: 47, red: 3, reruns: 1, listed: 100, per_day: Array.from({ length: 14 }, () => ({ runs: 3, red: 0 })), workflows: [{ name: 'ci', runs: 40, red: 3, median_ms: 430_000, median_runs: 37, daily_median_ms: Array(14).fill(430_000) }] },
    },
  }
  h.prs = { connected: true, prs: [{ session_id: 's1', url: live.url, number: 21, title: live.title, last_at: now, live }] }
  h.ci[21] = { connected: true, pr: { number: 21, url: live.url, repo: 'a/b', head_sha: 'h21', live }, ci: { repo: 'a/b', head_sha: 'h21', state: 'fail', runner_ms: 360_000, by_os: [], at: now, runs: [{ id: 7, name: 'ci', status: 'completed', conclusion: 'failure', started_at: now - 6 * 60_000, updated_at: now, jobs: [
    job(71, 'go (ubuntu-latest)', 'linux', 'success', 'completed', 118_000), job(72, 'go (macos-latest)', 'macos', 'failure'), job(73, 'changes', 'linux', 'success', 'completed', 3_000), job(74, 'app (x)', '', 'skipped'),
  ] }] } }
}

afterEach(() => { h.stats = undefined; h.prs = { connected: true, prs: [] }; h.ci = {}; h.asked = []; h.queued = []; h.logs = 0; forgetDeckAnswers(); localStorage.clear() })

describe('the PRs & CI tab', () => {
  it('shows the figures, the repository’s pull requests and the session’s open one in detail', async () => {
    connected()
    render(<PRsCITab sessionId="s1" session={session} visible onBack={() => {}} />)
    const merged = await screen.findByText('400')
    expect(merged.closest('[data-prs-stat]')).toHaveTextContent('19 today')
    expect(document.querySelector('[data-prs-stat="Time to merge"]')).toHaveTextContent('8m')
    expect(document.querySelector('[data-prs-stat="CI time · ci"]')).toHaveTextContent('7m 10s')
    expect(document.querySelector('[data-prs-stat="Red runs"]')).toHaveTextContent('6.4%')
    // The repository's list by default; the session's own one is chosen.
    expect([...document.querySelectorAll('[data-prs-row]')].map((e) => e.getAttribute('data-prs-row'))).toEqual(['22', '21', '20'])
    const detail = await waitFor(() => {
      const d = document.querySelector('[data-prs-pr="21"]')
      if (!d) throw new Error('no detail')
      return d
    })
    expect(detail.querySelector('[data-prs-diff]')).toHaveTextContent('+181 −59 · 13 files · 2 commits')
    expect(detail.querySelector('[data-prs-pill="merge"]')).toHaveTextContent('mergeable')
    // The jobs by runner OS, against their median; the skipped one is left out.
    const grid = await waitFor(() => {
      const g = detail.querySelector('[data-prs-grid]')
      if (!g) throw new Error('no grid')
      return g
    })
    expect(grid).toHaveTextContent('Linux')
    expect(grid).toHaveTextContent('macOS')
    expect(grid).not.toHaveTextContent('app')
    expect(grid.querySelector('[data-prs-cell="71"]')).toHaveTextContent('1m 58s+18%')
    expect(grid.querySelector('[data-prs-cell="72"]')).toHaveAttribute('data-tone', 'fail')
    expect(grid.querySelector('[data-prs-cell="72"]')).toHaveTextContent('failed at go test')
    // The failed job's log is read once, and Investigate queues it into the agent.
    expect(await screen.findByText('##[error]Process completed with exit code 1.')).toHaveClass('ci-error-line')
    expect(h.logs).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: 'Investigate' }))
    await waitFor(() => expect(h.queued).toHaveLength(1))
    expect(h.queued[0]).toContain('go (macos-latest)')
    // The deck's actions, asked first in a line.
    fireEvent.click(document.querySelector('[data-prs-action="rerun"]')!)
    expect(document.querySelector('[data-prs-confirm]')).toHaveTextContent('Re-run #21’s failed jobs on GitHub?')
  })

  it('switches between this session’s, the repository’s and the open pull requests, remembering the choice', async () => {
    connected()
    render(<PRsCITab sessionId="s1" session={session} visible onBack={() => {}} />)
    await screen.findByText('400')
    fireEvent.click(document.querySelector('[data-prs-scope="session"]')!)
    expect([...document.querySelectorAll('[data-prs-row]')].map((e) => e.getAttribute('data-prs-row'))).toEqual(['21'])
    fireEvent.click(document.querySelector('[data-prs-scope="open"]')!)
    expect([...document.querySelectorAll('[data-prs-row]')].map((e) => e.getAttribute('data-prs-row'))).toEqual(['22', '21'])
    expect(localStorage.getItem('caprock.prsTab.scope')).toBe('open')
    // A pull request that is not the session's is read when picked.
    fireEvent.click(screen.getByText('Bump deps'))
    await waitFor(() => expect(h.asked).toContain('ci 22'))
  })

  it('asks GitHub for nothing while GitHub is not connected, and says how to connect', async () => {
    h.stats = { connected: false, repo: 'a/b', prs: [] }
    h.prs = { connected: false, prs: [{ session_id: 's1', url: live.url, number: 21, title: live.title, last_at: now }] }
    render(<PRsCITab sessionId="s1" session={session} visible onBack={() => {}} />)
    expect(await screen.findByRole('button', { name: 'Connect GitHub' })).toBeInTheDocument()
    expect(document.querySelector('[data-prs-stats]')).toBeNull()
    expect(h.asked).not.toContain('usage')
  })

  it('asks nothing while it is not the tab in front, and goes back to the deck', async () => {
    connected()
    const back = vi.fn()
    render(<PRsCITab sessionId="s1" session={session} visible={false} onBack={back} />)
    await new Promise((r) => setTimeout(r, 20))
    expect(h.asked).toEqual([])
    // The deck's Expand, turned: Collapse, outlined, with the same key.
    const collapse = screen.getByRole('button', { name: /^Collapse: back/ })
    expect(collapse).toHaveAttribute('data-prs-back')
    expect(collapse).toHaveClass('border-accent/60')
    expect(collapse).toHaveTextContent(/^Collapse (⇧⌘B|Ctrl\+Alt\+Shift\+B)$/)
    fireEvent.click(collapse)
    expect(back).toHaveBeenCalledTimes(1)
  })
})
