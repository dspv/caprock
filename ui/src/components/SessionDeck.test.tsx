import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Event, SessionSummary, Summary } from '@/lib/api'
import { heldSessions } from '@/lib/sessionEvents'
import { DECK_STEP } from '@/lib/deck'

const now = Date.now()
const iso = (agoMs: number) => new Date(now - agoMs).toISOString()
const events: Event[] = [
  { id: 1, ts: iso(60_000), session_id: 's1', source: 'transcript', kind: 'turn.assistant', payload: {}, cost_usd: 0.04 },
  { id: 2, ts: iso(30_000), session_id: 's1', source: 'transcript', kind: 'turn.assistant', payload: {}, cost_usd: 0.07 },
  { id: 3, ts: iso(4_000), session_id: 's1', source: 'hook', kind: 'tool.pre', tool: 'Bash', payload: { tool_use_id: 'b', tool_input: { command: 'go test ./internal/...' } } },
]

const h = vi.hoisted(() => ({ asked: 0, prs: { connected: true, prs: [] as unknown[] }, ci: { connected: true } as unknown, logs: 0, queued: [] as string[], rel: { connected: false } as unknown, main: { connected: false } as unknown, logViews: [] as string[], ciPrs: [] as (number | undefined)[] }))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, recentMainEvents: async () => { h.asked++; return events }, sessionPRs: async () => h.prs, sessionCI: async (_id: string, pr?: number) => { h.ciPrs.push(pr); return h.ci }, sessionCIRelease: async () => h.rel, sessionCIMain: async () => h.main, queueSend: async (_id: string, text: string) => { h.queued.push(text); return { sent: false, queue: { session_id: 's1', messages: [], waiting: 'turn' } } },
    sessionCILog: async (_id: string, _job: number, view = 'pr') => { h.logs++; h.logViews.push(view); return { job_id: 71, lines: ['go test ./...', '--- FAIL: TestDeck (0.01s)', '##[error]Process completed with exit code 1.'], error_line: 2 } } } }
})

import { SessionDeck } from './SessionDeck'

function agent(p: Partial<SessionSummary> = {}): SessionSummary {
  return {
    session_id: 's1', cwd: '/w', project: 'w', model: 'claude-opus-5-5', model_display: 'Opus 5.5', started_at: 0, last_event_at: now, status: 'active',
    transcript_path: '', has_hooks: true, has_transcript: true, git_branch: 'main', version: '', owned: true, agent: 'claude',
    stats: { session_id: 's1', turns: 12, tool_calls: 40, files_touched: 3, tokens_in: 100, tokens_out: 9_000, cache_read: 900_000, cache_write: 50_000, cost_usd: 1.84 },
    activity: { phrase: 'running go test', tool: 'Bash', at: iso(4_000), health: 'working' },
    context: { tokens: 124_000, window: 200_000, pct: 62, next_call_usd: 0.031 },
    ...p,
  } as SessionSummary
}

const summary = { rate_limits: { five_hour: { used_percentage: 41, resets_at: Math.round((now + 3_600_000) / 1000) }, seven_day: { used_percentage: 12, resets_at: Math.round((now + 3 * 86_400_000) / 1000) } } } as unknown as Summary

function show(p: Partial<Parameters<typeof SessionDeck>[0]> = {}) {
  const onResize = vi.fn()
  const r = render(<SessionDeck s={agent()} sessionId="s1" hasPermission={false} summary={summary} height={120} onResize={onResize} onClose={() => {}} {...p} />)
  return { ...r, onResize }
}

afterEach(() => { vi.useRealTimers(); h.asked = 0; h.rel = { connected: false }; h.main = { connected: false }; localStorage.clear() })

describe('the session deck', () => {
  it('asks nothing of the session’s events, and leaves the context to the status bar', async () => {
    show()
    expect(screen.queryByRole('meter', { name: 'Context used' })).toBeNull()
    expect(screen.queryByText(/next call/)).toBeNull()
    // What it is doing and what it cost are the sidebar's and the inspector's.
    expect(screen.queryByText('Spent')).toBeNull()
    expect(screen.queryByText('Now')).toBeNull()
    await new Promise((r) => setTimeout(r, 20))
    expect(h.asked).toBe(0)
    expect(heldSessions()).toBe(0)
  })

  it('leaves out what the agent does not report rather than drawing a zero', () => {
    show({ s: agent({ context: undefined, stats: undefined, agent: 'opencode' }) })
    expect(screen.queryByText('Spent')).toBeNull()
    expect(screen.queryByText('$0.00')).toBeNull()
  })

  it('shows the PR’s CI: jobs, steps, times, the runner total, and a failed step’s error', async () => {
    const t0 = now - 5 * 60_000
    const st = (number: number, name: string, status: string, conclusion: string | undefined, from: number, to?: number) =>
      ({ number, name, status, conclusion, started_at: from, completed_at: to, duration_ms: to ? to - from : undefined })
    h.ci = { connected: true, pr: { number: 9, url: 'https://github.com/a/b/pull/9', repo: 'a/b', head_sha: 's' }, ci: {
      repo: 'a/b', head_sha: 's', state: 'running', runner_ms: 90_000, by_os: [{ os: 'linux', ms: 90_000 }], at: now, runs: [{ id: 7, name: 'CI', status: 'in_progress', jobs: [
        { id: 70, run_id: 7, name: 'lint', status: 'completed', conclusion: 'success', started_at: t0, completed_at: t0 + 90_000, duration_ms: 90_000, labels: ['ubuntu-latest'], os: 'linux',
          steps: [st(1, 'golangci-lint', 'completed', 'success', t0, t0 + 90_000)] },
        { id: 71, run_id: 7, name: 'test (macos)', status: 'completed', conclusion: 'failure', started_at: t0, completed_at: t0 + 60_000, duration_ms: 60_000, labels: ['macos-14'], os: 'macos', html_url: 'https://github.com/a/b/actions/runs/7/job/71',
          steps: [st(1, 'Set up job', 'completed', 'success', t0, t0 + 2_000), st(2, 'go test', 'completed', 'failure', t0 + 2_000, t0 + 60_000)] },
        { id: 72, run_id: 7, name: 'test (windows)', status: 'in_progress', started_at: now - 125_000, labels: ['windows-latest'], os: 'windows',
          steps: [st(1, 'go test', 'in_progress', undefined, now - 120_000)] },
      ] }] } }
    show()
    const lint = await screen.findByText('lint')
    expect(lint.closest('[data-deck-ci-job]')).toHaveAttribute('data-tone', 'pass')
    expect(lint.closest('button')).toHaveTextContent('1m 30s')
    // A running job ticks, and says which step it is on.
    const win = screen.getByText('test (windows)').closest('button')!
    expect(win).toHaveTextContent(/2m 0[5-9]s/)
    expect(win).toHaveTextContent('go test')
    // The runner time is the finished jobs plus the running one on the clock.
    expect(document.querySelector('[data-deck-ci-runner]')!.textContent).toMatch(/runner 3m 3[5-9]s/)
    // The failed job is open; its failed step opens the error.
    const failed = await waitFor(() => {
      const b = document.querySelector('[data-deck-ci-job="71"] [data-deck-ci-step="2"] button')
      if (!b) throw new Error('the failed job did not open')
      return b
    })
    expect(failed).toHaveTextContent('58s')
    fireEvent.click(failed)
    expect(await screen.findByText('##[error]Process completed with exit code 1.')).toHaveClass('ci-error-line')
    expect(h.logs).toBe(1)
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    fireEvent.click(screen.getByRole('button', { name: /Open on GitHub/ }))
    expect(String(open.mock.calls.at(-1)?.[0] ?? '')).toBe('https://github.com/a/b/actions/runs/7/job/71')
    open.mockRestore()
    h.ci = { connected: true }
  })

  it('queues a failed job into the agent with Investigate, and only into one Caprock started', async () => {
    const t0 = now - 5 * 60_000
    h.ci = { connected: true, pr: { number: 428, title: 'Add CI', url: 'https://github.com/a/b/pull/428', repo: 'a/b', head_sha: 's' }, ci: {
      repo: 'a/b', head_sha: 's', state: 'fail', runner_ms: 60_000, by_os: [], at: now, runs: [{ id: 7, name: 'CI', status: 'completed', conclusion: 'failure', jobs: [
        { id: 71, run_id: 7, name: 'test (macos)', status: 'completed', conclusion: 'failure', started_at: t0, completed_at: t0 + 60_000, duration_ms: 60_000, labels: [], html_url: 'https://github.com/a/b/actions/runs/7/job/71',
          steps: [{ number: 1, name: 'go test', status: 'completed', conclusion: 'failure', started_at: t0, completed_at: t0 + 60_000, duration_ms: 60_000 }] },
      ] }] } }
    h.queued = []
    const onToast = vi.fn()
    const first = show({ onToast })
    const b = await screen.findByRole('button', { name: 'Investigate' })
    fireEvent.click(b)
    await waitFor(() => expect(onToast).toHaveBeenCalled())
    expect(h.queued).toHaveLength(1)
    expect(h.queued[0]).toContain('CI failed on PR #428 "Add CI"')
    expect(h.queued[0]).toContain('Workflow: CI · job: test (macos) · step: go test')
    expect(h.queued[0]).toContain('##[error]Process completed with exit code 1.')
    expect(onToast.mock.calls[0]![0]).toMatch(/^Queued for /)
    first.unmount()
    // A session in another terminal: never typed into, and the button says why.
    show({ s: agent({ owned: false }) })
    const off = await screen.findByRole('button', { name: 'Investigate' })
    expect(off).toBeDisabled()
    expect(off.getAttribute('title')).toMatch(/did not start this session/)
    h.ci = { connected: true }
  })

  it('says plainly when there is no CI to show', async () => {
    h.ci = { connected: true }
    const { unmount } = show()
    expect(await screen.findAllByText('No PR from this session yet.')).not.toHaveLength(0)
    unmount()
    h.ci = { connected: false, pr: { number: 4, url: 'https://github.com/a/b/pull/4', repo: 'a/b' } }
    const second = show()
    expect(await screen.findByText('Connect GitHub to see #4’s CI')).toBeInTheDocument()
    second.unmount()
    h.ci = { connected: true, pr: { number: 4, url: 'https://github.com/a/b/pull/4', repo: 'a/b', head_sha: 's' }, ci: { repo: 'a/b', head_sha: 's', state: 'none', runs: [], runner_ms: 0, by_os: [], at: now } }
    show()
    expect(await screen.findByText('No GitHub Actions runs on #4’s head commit.')).toBeInTheDocument()
    h.ci = { connected: true }
  })

  it('shows the branch with what is not committed and not pushed', async () => {
    show({ branch: 'feat/deck', changed: 3, ahead: 2, onReviewChanges: () => {} })
    expect(screen.getByText('feat/deck')).toBeInTheDocument()
    expect(screen.getByText('3 not committed · 2 not pushed')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Review changes' })).toBeInTheDocument()
  })

  it('lists the session’s PRs with their CI', async () => {
    const pr = (n: number, checks: object, state = 'open') => ({ number: n, url: `https://github.com/a/b/pull/${n}`, title: `PR ${n}`, state, draft: false, review: '', reviews: [], checks })
    h.prs = { connected: true, prs: [
      { session_id: 's1', number: 9, url: 'https://github.com/a/b/pull/9', title: 'PR 9', last_at: now, live: pr(9, { state: 'pending', passed: 2, failed: 0, pending: 3, items: [{}, {}, {}, {}, {}] }) },
      { session_id: 's1', number: 8, url: 'https://github.com/a/b/pull/8', title: 'PR 8', last_at: now, live: pr(8, { state: 'fail', passed: 1, failed: 1, pending: 0, items: [{ name: 'windows', state: 'fail' }, { name: 'lint', state: 'pass' }] }) },
      { session_id: 's1', number: 7, url: 'https://github.com/a/b/pull/7', title: 'PR 7', last_at: now, live: pr(7, { state: 'pass', passed: 1, failed: 0, pending: 0, items: [{}] }, 'merged') },
    ] }
    show()
    expect(await screen.findByText('CI 2/5 running')).toBeInTheDocument()
    expect(screen.getByText('CI ✗ windows')).toBeInTheDocument()
    expect(screen.getByText('CI ✓ 1 passed')).toBeInTheDocument()
    expect(screen.getByText('merged')).toBeInTheDocument()
    // The CI opens the failing job when GitHub gave its link, else the PR's checks.
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    fireEvent.click(screen.getByText('CI 2/5 running'))
    expect(String(open.mock.calls.at(-1)?.[0] ?? '')).toBe('https://github.com/a/b/pull/9/checks')
    open.mockRestore()
    h.prs = { connected: true, prs: [] }
  })

  it('says CI has not started on a fresh PR, and "no checks" on an old one — never "CI no CI"', async () => {
    const live = (n: number) => ({ number: n, url: `https://github.com/a/b/pull/${n}`, title: `PR ${n}`, state: 'open', draft: false, review: '', reviews: [],
      checks: { state: 'none', passed: 0, failed: 0, pending: 0, items: [] } })
    h.prs = { connected: true, prs: [
      { session_id: 's1', number: 431, url: 'https://github.com/a/b/pull/431', title: 'PR 431', opened_at: now - 30_000, last_at: now - 30_000, live: live(431) },
      { session_id: 's1', number: 300, url: 'https://github.com/a/b/pull/300', title: 'PR 300', opened_at: now - 3_600_000, last_at: now - 3_600_000, live: live(300) },
    ] }
    show()
    const fresh = await screen.findByText('CI not started')
    expect(fresh).toHaveAttribute('title', expect.stringMatching(/not reported any checks for this PR yet/))
    expect(screen.getByText('no checks')).toHaveAttribute('title', 'No CI workflow ran on this PR')
    expect(screen.queryByText(/CI no CI/)).toBeNull()
    h.prs = { connected: true, prs: [] }
  })

  it('says how to get CI while GitHub is not connected', async () => {
    h.prs = { connected: false, prs: [{ session_id: 's1', number: 4, url: 'https://github.com/a/b/pull/4', title: 'PR 4', last_at: now, merged_at: now }] }
    show()
    expect(await screen.findByText('connect GitHub for CI')).toBeInTheDocument()
    expect(screen.getByText('merged')).toBeInTheDocument()
    h.prs = { connected: true, prs: [] }
  })

  it('resizes the terminal once, on release, however far the divider is dragged', () => {
    const { onResize } = show()
    const divider = screen.getByRole('separator', { name: 'Resize the session deck' })
    fireEvent.pointerDown(divider, { button: 0, clientY: 500 })
    for (const y of [490, 470, 440, 400]) fireEvent.pointerMove(window, { clientY: y })
    // Drawn at the new height over the terminal meanwhile, the terminal untouched.
    expect(onResize).not.toHaveBeenCalled()
    expect(divider).toHaveAttribute('aria-valuenow', '220')
    fireEvent.pointerUp(window, { clientY: 400 })
    expect(onResize).toHaveBeenCalledTimes(1)
  })

  it('settles the arrow keys into one resize', () => {
    vi.useFakeTimers()
    const { onResize } = show()
    const divider = screen.getByRole('separator', { name: 'Resize the session deck' })
    for (let i = 0; i < 5; i++) fireEvent.keyDown(divider, { key: 'ArrowUp' })
    expect(onResize).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(300) })
    expect(onResize).toHaveBeenCalledTimes(1)
    expect(onResize.mock.calls[0]![0]).toBeGreaterThanOrEqual(5 * DECK_STEP)
  })

  it('hides with a labelled button that names its key', () => {
    const onClose = vi.fn()
    show({ onClose })
    const b = screen.getByRole('button', { name: /Close the session deck/ })
    expect(b).toHaveTextContent('Hide')
    fireEvent.click(b)
    expect(onClose).toHaveBeenCalled()
  })

  it('switches the CI cell to the release build, with an estimate, and remembers the choice', async () => {
    const started = now - 4 * 60_000
    h.rel = { connected: true, repo: 'a/b', release: { repo: 'a/b', tag: 'v0.109.1', state: 'running', at: now, estimate: { median_ms: 16 * 60_000, runs: 5 },
      run: { id: 30, name: 'Release', status: 'in_progress', started_at: started, created_at: started, head_branch: 'v0.109.1', html_url: 'https://github.com/a/b/actions/runs/30', jobs: [
        { id: 301, run_id: 30, name: 'goreleaser', status: 'in_progress', started_at: started, labels: ['ubuntu-latest'], os: 'linux',
          steps: [{ number: 1, name: 'Build', status: 'in_progress', started_at: started }] },
      ] } } }
    const first = show()
    // From the PR view, a running release shows as a chip.
    const chip = await waitFor(() => {
      const c = document.querySelector('[data-deck-release-chip]')
      if (!c) throw new Error('no chip')
      return c
    })
    expect(chip.textContent).toBe('Release v0.109.1 · ~12 min')
    fireEvent.click(screen.getByRole('tab', { name: 'Release' }))
    expect(screen.getByRole('tab', { name: 'Release' })).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByText('about 12 min left (estimate from the last 5 runs)')).toBeInTheDocument()
    expect(document.querySelector('[data-deck-ci-release]')).toHaveTextContent('v0.109.1')
    expect(screen.getByText('goreleaser').closest('button')).toHaveTextContent('Build')
    // The chip is the PR view's; the Release view says it in full.
    expect(document.querySelector('[data-deck-release-chip]')).toBeNull()
    first.unmount()
    show()
    expect(screen.getByRole('tab', { name: 'Release' })).toHaveAttribute('aria-selected', 'true')
  })

  it('says a finished release build was published, and links the release', async () => {
    h.rel = { connected: true, repo: 'a/b', release: { repo: 'a/b', tag: 'v0.109.1', state: 'pass', at: now,
      release: { url: 'https://github.com/a/b/releases/tag/v0.109.1', published_at: now - 3 * 60_000 },
      run: { id: 30, name: 'Release', status: 'completed', conclusion: 'success', updated_at: now - 3 * 60_000, head_branch: 'v0.109.1', jobs: [] } } }
    localStorage.setItem('caprock.deck.ciView', 'release')
    show()
    const done = await screen.findByText('v0.109.1 · published 3 min ago ✓')
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    fireEvent.click(done)
    expect(String(open.mock.calls.at(-1)?.[0] ?? '')).toBe('https://github.com/a/b/releases/tag/v0.109.1')
    open.mockRestore()
  })

  it('shows the default branch, a row per workflow, and reads a failed job’s log in that view', async () => {
    const t0 = now - 10 * 60_000
    h.main = { connected: true, repo: 'a/b', branch: 'master', ci: { repo: 'a/b', head_sha: 'm', branch: 'master', state: 'fail', runner_ms: 60_000, by_os: [], at: now, runs: [
      { id: 50, name: 'CI', status: 'completed', conclusion: 'failure', jobs: [
        { id: 501, run_id: 50, name: 'test (windows)', status: 'completed', conclusion: 'failure', started_at: t0, completed_at: t0 + 60_000, duration_ms: 60_000, labels: [], os: 'windows',
          steps: [{ number: 1, name: 'go test', status: 'completed', conclusion: 'failure', started_at: t0, completed_at: t0 + 60_000, duration_ms: 60_000 }] }] },
      { id: 48, name: 'Docs', status: 'completed', conclusion: 'success', jobs: [] },
    ] } }
    h.logViews = []
    localStorage.setItem('caprock.deck.ciView', 'main')
    show()
    expect(await screen.findByText('Docs')).toBeInTheDocument()
    expect(screen.getByText('master')).toBeInTheDocument()
    const failed = await waitFor(() => {
      const b = document.querySelector('[data-deck-ci-job="501"] [data-deck-ci-step="1"] button')
      if (!b) throw new Error('the failed job did not open')
      return b
    })
    fireEvent.click(failed)
    await screen.findByText('##[error]Process completed with exit code 1.')
    expect(h.logViews).toContain('main')
  })

  it('says how to connect GitHub for the release build, and when the folder has no repository', async () => {
    h.rel = { connected: false, repo: 'a/b' }
    localStorage.setItem('caprock.deck.ciView', 'release')
    const first = show()
    expect(await screen.findByRole('button', { name: 'Connect GitHub to see a/b’s release build' })).toBeInTheDocument()
    first.unmount()
    h.rel = { connected: true, reason: 'no_repo' }
    show()
    expect(await screen.findByText('This session’s folder has no GitHub repository.')).toBeInTheDocument()
  })

  it('draws each PR’s pipeline, and a click on a job opens it in the CI cell for that PR', async () => {
    const t0 = now - 5 * 60_000
    const live = { number: 8, url: 'https://github.com/a/b/pull/8', title: 'PR 8', state: 'open', draft: false, review: '', reviews: [],
      checks: { state: 'fail', passed: 1, failed: 1, pending: 1, items: [
        { name: 'lint', state: 'pass', status: 'completed', started_at: t0, completed_at: t0 + 30_000, job_id: 80, url: 'https://github.com/a/b/actions/runs/8/job/80' },
        { name: 'test (windows)', state: 'fail', status: 'completed', started_at: t0 + 1_000, completed_at: t0 + 61_000, job_id: 81, url: 'https://github.com/a/b/actions/runs/8/job/81' },
        { name: 'smoke', state: 'pending', status: 'in_progress', started_at: t0 + 2_000, job_id: 82 },
      ] } }
    h.prs = { connected: true, prs: [
      { session_id: 's1', number: 9, url: 'https://github.com/a/b/pull/9', title: 'PR 9', last_at: now },
      { session_id: 's1', number: 8, url: 'https://github.com/a/b/pull/8', title: 'PR 8', last_at: now, live },
    ] }
    h.ci = { connected: true, pr: { number: 9, url: 'https://github.com/a/b/pull/9', repo: 'a/b', head_sha: 's9' }, ci: { repo: 'a/b', head_sha: 's9', state: 'none', runs: [], runner_ms: 0, by_os: [], at: now } }
    h.ciPrs = []
    show()
    const row = await waitFor(() => {
      const r = document.querySelector('[data-deck-pr="8"]')
      if (!r?.querySelector('[data-pipeline]')) throw new Error('no pipeline')
      return r
    })
    const tones = [...row.querySelectorAll('[data-pipe-node]')].map((b) => b.getAttribute('data-tone'))
    expect(tones).toEqual(['pass', 'fail', 'running'])
    // The CI cell turns to #8 and opens its failed job.
    h.ci = { connected: true, pr: { number: 8, url: 'https://github.com/a/b/pull/8', repo: 'a/b', head_sha: 's8' }, ci: {
      repo: 'a/b', head_sha: 's8', state: 'fail', runner_ms: 60_000, by_os: [], at: now, runs: [{ id: 8, name: 'CI', status: 'completed', conclusion: 'failure', jobs: [
        { id: 80, run_id: 8, name: 'lint', status: 'completed', conclusion: 'success', started_at: t0, completed_at: t0 + 30_000, duration_ms: 30_000, labels: [], steps: [] },
        { id: 81, run_id: 8, name: 'test (windows)', status: 'completed', conclusion: 'failure', started_at: t0, completed_at: t0 + 60_000, duration_ms: 60_000, labels: [],
          steps: [{ number: 1, name: 'go test', status: 'completed', conclusion: 'failure', started_at: t0, completed_at: t0 + 60_000, duration_ms: 60_000 }] },
      ] }] } }
    fireEvent.click(row.querySelector('[data-pipe-node="81"]')!)
    await waitFor(() => expect(h.ciPrs).toContain(8))
    await waitFor(() => expect(document.querySelector('[data-deck-ci-job="81"] [data-deck-ci-step="1"]')).not.toBeNull())
    expect(screen.getByRole('tab', { name: 'PR' })).toHaveAttribute('aria-selected', 'true')
    h.prs = { connected: true, prs: [] }
    h.ci = { connected: true }
  })

  it('draws the release build’s jobs as a pipeline beside its tag', async () => {
    const started = now - 60_000
    h.rel = { connected: true, repo: 'a/b', release: { repo: 'a/b', tag: 'v2.0.0', state: 'running', at: now,
      run: { id: 30, name: 'Release', status: 'in_progress', started_at: started, jobs: [
        { id: 301, run_id: 30, name: 'build', status: 'completed', conclusion: 'success', started_at: started, completed_at: started + 20_000, duration_ms: 20_000, labels: [], steps: [] },
        { id: 302, run_id: 30, name: 'publish', status: 'in_progress', started_at: started + 20_000, labels: [], steps: [] },
      ] } } }
    localStorage.setItem('caprock.deck.ciView', 'release')
    show()
    const line = await waitFor(() => {
      const l = document.querySelector('[data-deck-ci-release] [data-pipeline]')
      if (!l) throw new Error('no pipeline')
      return l
    })
    expect([...line.querySelectorAll('[data-pipe-node]')].map((b) => b.getAttribute('data-tone'))).toEqual(['pass', 'running'])
  })
})
