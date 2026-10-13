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

const h = vi.hoisted(() => ({ asked: 0, prs: { connected: true, prs: [] as unknown[] }, ci: { connected: true } as unknown, logs: 0, queued: [] as string[], rel: { connected: false } as unknown, main: { connected: false } as unknown, logViews: [] as string[], ciPrs: [] as (number | undefined)[], branches: { connected: true, branches: [] } as unknown, usage: undefined as unknown, usageAsked: 0, queuedTo: [] as string[], forced: [] as string[], rerunFail: undefined as unknown, queues: {} as Record<string, { text: string }[]>, prsGate: undefined as Promise<void> | undefined, prsFail: undefined as unknown, prsAsked: 0, branchesGate: undefined as Promise<void> | undefined }))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, recentMainEvents: async () => { h.asked++; return events }, sessionPRs: async () => { h.prsAsked++; if (h.prsGate) await h.prsGate; if (h.prsFail) throw h.prsFail; return h.prs }, sessionCI: async (_id: string, pr?: number) => { h.ciPrs.push(pr); return h.ci }, sessionCIRelease: async () => h.rel, sessionCIMain: async () => h.main, sessionBranches: async () => { if (h.branchesGate) await h.branchesGate; return h.branches }, actionsUsage: async () => { h.usageAsked++; if (!h.usage) throw new Error('not connected'); return h.usage }, queueSend: async (id: string, text: string) => { h.queued.push(text); h.queuedTo.push(id); return { sent: false, queue: { session_id: 's1', messages: [], waiting: 'turn' } } },
    sessionPRRerun: async (_id: string, n: number) => { h.forced.push(`rerun ${n}`); if (h.rerunFail) throw h.rerunFail; return { ok: true, mode: 'failed', runs: 1, jobs: 2 } },
    sessionPRUpdateBranch: async (_id: string, n: number) => { h.forced.push(`update ${n}`); return { ok: true } },
    queue: async (id: string) => ({ session_id: id, waiting: '', messages: h.queues[id] ?? [] }),
    sessionCILog: async (_id: string, _job: number, view = 'pr') => { h.logs++; h.logViews.push(view); return { job_id: 71, lines: ['go test ./...', '--- FAIL: TestDeck (0.01s)', '##[error]Process completed with exit code 1.'], error_line: 2 } } } }
})

import { SessionDeck, forgetFoldedPRs, forgetPRProgress } from './SessionDeck'
import { ApiError } from '@/lib/api'
import { forgetDeckAnswers, readDeck, writeDeck } from '@/lib/deckCache'

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

/** What GitHub says of PR n now. */
const livePR = (n: number, checks: object, p: object = {}) => ({ number: n, url: `https://github.com/a/b/pull/${n}`, title: `PR ${n}`, state: 'open', draft: false,
  review: '', reviews: [], branch: `feat/${n}`, base: 'main', mergeable: null, checks, ...p })
/** One of the session's PRs, as GET /v1/sessions/{id}/prs lists it. */
const prRow = (n: number, live?: object, p: object = {}) => ({ session_id: 's1', number: n, url: `https://github.com/a/b/pull/${n}`, title: `PR ${n}`, last_at: now, ...(live ? { live } : {}), ...p })
const RUNNING = { state: 'pending', passed: 1, failed: 0, pending: 1, items: [{ name: 'lint', state: 'pass' }, { name: 'test', state: 'pending', status: 'in_progress', started_at: now - 60_000 }] }
const FAILED = { state: 'fail', passed: 0, failed: 1, pending: 0, items: [{ name: 'test (macos)', state: 'fail' }] }
const PASSED = { state: 'pass', passed: 1, failed: 0, pending: 0, items: [{ name: 'lint', state: 'pass' }] }

/** A PR row's own button: it opens the row in place. */
const rowButton = (n: number) => {
  const b = document.querySelector(`[data-deck-pr="${n}"] button[aria-expanded]`)
  if (!b) throw new Error(`no row #${n}`)
  return b
}

function show(p: Partial<Parameters<typeof SessionDeck>[0]> = {}) {
  const onResize = vi.fn()
  const r = render(<SessionDeck s={agent()} sessionId="s1" hasPermission={false} summary={summary} height={120} onResize={onResize} onClose={() => {}} {...p} />)
  return { ...r, onResize }
}

afterEach(() => { vi.useRealTimers(); forgetFoldedPRs(); forgetPRProgress(); forgetDeckAnswers();h.queued = []; h.queuedTo = []; h.forced = []; h.rerunFail = undefined; h.asked = 0; h.prs = { connected: true, prs: [] }; h.ci = { connected: true }; h.rel = { connected: false }; h.main = { connected: false }; h.branches = { connected: true, branches: [] }; h.usage = undefined; h.usageAsked = 0; h.prsGate = undefined; h.prsFail = undefined; h.prsAsked = 0; h.branchesGate = undefined; localStorage.clear() })

describe('the session deck', () => {
  it('expands into the PRs & CI tab with one control beside Hide, and only where the shell offers it', () => {
    const onExpand = vi.fn()
    const { unmount } = show({ onExpand })
    const b = screen.getByRole('button', { name: /^Expand/ })
    expect(b).toHaveAttribute('data-deck-expand')
    fireEvent.click(b)
    expect(onExpand).toHaveBeenCalledTimes(1)
    unmount()
    show()
    expect(document.querySelector('[data-deck-expand]')).toBeNull()
  })

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
        { id: 70, run_id: 7, name: 'lint', status: 'completed', conclusion: 'success', started_at: t0, completed_at: t0 + 90_000, duration_ms: 90_000, labels: ['ubuntu-latest'], os: 'linux', baseline: { median_ms: 60_000, runs: 5 },
          steps: [st(1, 'golangci-lint', 'completed', 'success', t0, t0 + 90_000)] },
        { id: 71, run_id: 7, name: 'test (macos)', status: 'completed', conclusion: 'failure', started_at: t0, completed_at: t0 + 60_000, duration_ms: 60_000, labels: ['macos-14'], os: 'macos', html_url: 'https://github.com/a/b/actions/runs/7/job/71',
          steps: [st(1, 'Set up job', 'completed', 'success', t0, t0 + 2_000), st(2, 'go test', 'completed', 'failure', t0 + 2_000, t0 + 60_000)] },
        { id: 72, run_id: 7, name: 'test (windows)', status: 'in_progress', started_at: now - 125_000, labels: ['windows-latest'], os: 'windows',
          steps: [st(1, 'go test', 'in_progress', undefined, now - 120_000)] },
      ] }] } }
    h.prs = { connected: true, prs: [prRow(9, livePR(9, RUNNING)), prRow(8, livePR(8, PASSED, { state: 'merged' }))] }
    show()
    const lint = await screen.findByText('lint')
    expect(lint.closest('[data-deck-ci-job]')).toHaveAttribute('data-tone', 'pass')
    expect(lint.closest('button')).toHaveTextContent('1m 30s')
    // Against the median of its past successful runs, coloured when well over it; a job with none says nothing.
    const vs = lint.closest('button')!.querySelector('[data-deck-vs]')!
    expect(vs).toHaveTextContent('+50%')
    expect(vs).toHaveClass('text-warn')
    expect(vs.getAttribute('title')).toMatch(/median of the last 5 successful runs/)
    expect(screen.getByText('test (windows)').closest('button')!.querySelector('[data-deck-vs]')).toBeNull()
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
    // The jobs flow into columns as the width allows; an open job takes the whole row for its steps.
    expect(document.querySelector('[data-deck-ci-grid]')!.className).toMatch(/repeat\(auto-fill/)
    expect(document.querySelector('[data-deck-ci-job="71"]')).toHaveClass('col-span-full')
    expect(document.querySelector('[data-deck-ci-job="70"]')).not.toHaveClass('col-span-full')
    fireEvent.click(failed)
    expect(await screen.findByText('##[error]Process completed with exit code 1.')).toHaveClass('ci-error-line')
    // While an error is open the earlier PRs fold into one line, so it has the room.
    expect(document.querySelector('[data-deck-pr="8"]')).toBeNull()
    expect(document.querySelector('[data-deck-prs-folded]')).toHaveTextContent('#8✓')
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
    h.prs = { connected: true, prs: [prRow(428, livePR(428, FAILED, { title: 'Add CI' }))] }
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
    const { unmount } = show()
    expect(await screen.findByText('No PR from this session yet.')).toBeInTheDocument()
    unmount()
    // Not connected: the row is what the session recorded, and opening it says how to get its CI.
    h.prs = { connected: false, prs: [prRow(4)] }
    const second = show()
    fireEvent.click(await waitFor(() => rowButton(4)))
    expect(await screen.findByText('Connect GitHub to see #4’s CI')).toBeInTheDocument()
    second.unmount()
    h.prs = { connected: true, prs: [prRow(4, livePR(4, RUNNING))] }
    h.ci = { connected: true, pr: { number: 4, url: 'https://github.com/a/b/pull/4', repo: 'a/b', head_sha: 's' }, ci: { repo: 'a/b', head_sha: 's', state: 'none', runs: [], runner_ms: 0, by_os: [], at: now } }
    show()
    expect(await screen.findByText('No GitHub Actions runs on #4’s head commit.')).toBeInTheDocument()
  })

  it('has no Branch cell: the branch is a chip in the header, with what is not committed and not pushed', async () => {
    const onReview = vi.fn()
    h.prs = { connected: true, prs: [prRow(9, livePR(9, PASSED, { branch: 'feat/deck', base: 'main' }))] }
    show({ branch: 'feat/deck', changed: 3, ahead: 2, onReviewChanges: onReview })
    expect(screen.queryByRole('heading', { name: 'Branch' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Pull requests & CI' })).toBeInTheDocument()
    const chip = document.querySelector('[data-deck-branch]')!
    expect(chip.textContent).toBe('feat/deck')
    // The current PR is from this branch: where it goes.
    await waitFor(() => expect(chip.textContent).toBe('feat/deck → main'))
    const dirty = screen.getByText('3 not committed · 2 not pushed')
    expect(dirty).toHaveAttribute('title', expect.stringMatching(/^Review changes/))
    fireEvent.click(dirty)
    expect(onReview).toHaveBeenCalled()
  })

  it('lists the current PR first, then the earlier ones, each with its state, CI, review, conflict and age', async () => {
    h.prs = { connected: true, prs: [
      prRow(8, livePR(8, FAILED, { state: 'merged' }), { merged_at: now - 2 * 3_600_000 }),
      prRow(9, livePR(9, { state: 'pending', passed: 2, failed: 0, pending: 3, items: [{ name: 'a', state: 'pass' }, { name: 'b', state: 'pass' }, { name: 'c', state: 'pending', status: 'in_progress', started_at: now - 4 * 60_000 }, { name: 'd', state: 'pending' }, { name: 'e', state: 'pending' }] },
        { review: 'approved', mergeable: false, mergeable_state: 'dirty' }), { opened_at: now - 5 * 60_000 }),
      prRow(7, livePR(7, PASSED, { state: 'merged' }), { merged_at: now - 3 * 86_400_000 }),
      prRow(6, livePR(6, { state: 'none', passed: 0, failed: 0, pending: 0, items: [] }, { state: 'closed', review: 'changes_requested' }), { closed_at: now - 5 * 86_400_000 }),
    ] }
    show()
    await screen.findByText(/^running · 2\/5 · 4m 0\ds$/)
    const order = [...document.querySelectorAll('[data-deck-pr]')].map((r) => r.getAttribute('data-deck-pr'))
    expect(order).toEqual(['9', '8', '7', '6'])
    const row = (n: number) => document.querySelector(`[data-deck-pr="${n}"]`)!
    expect(row(9).querySelector('.pr-dot')).toHaveAttribute('data-state', 'open')
    expect(row(8).querySelector('.pr-dot')).toHaveAttribute('data-state', 'merged')
    expect(row(6).querySelector('.pr-dot')).toHaveAttribute('data-state', 'closed')
    expect(row(8).querySelector('[data-deck-pr-ci]')).toHaveTextContent('✗ failed at test (macos)')
    expect(row(7).querySelector('[data-deck-pr-ci]')).toHaveTextContent('✓ passed')
    expect(row(6).querySelector('[data-deck-pr-ci]')).toHaveTextContent('no checks')
    // Review and conflict only for an open PR, and only as GitHub said them:
    // the conflict a chip beside the pipeline, approved in words.
    expect(row(9).querySelector('[data-deck-pr-review]')).toHaveTextContent('approved')
    expect(row(9).querySelector('[data-deck-pr-chip="conflict"]')).toHaveTextContent('conflict')
    expect(row(6).querySelector('[data-deck-pr-review]')).toBeNull()
    expect(row(6).querySelector('[data-deck-pr-chip]')).toBeNull()
    expect(row(9).querySelector('[data-deck-pr-age]')).toHaveTextContent('5m')
    expect(row(8).querySelector('[data-deck-pr-age]')).toHaveTextContent('2h')
    expect(row(7).querySelector('[data-deck-pr-age]')).toHaveTextContent('3d')
    expect(screen.queryByText('No earlier PRs from this session.')).toBeNull()
    // ↗ opens the PR itself.
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    fireEvent.click(screen.getByRole('button', { name: 'Open #8 on GitHub' }))
    expect(String(open.mock.calls.at(-1)?.[0] ?? '')).toBe('https://github.com/a/b/pull/8')
    open.mockRestore()
  })

  it('opens the current PR by itself while it is open with checks, and one row at a time', async () => {
    // A merged PR first stays closed: only an open one with checks opens by itself.
    h.prs = { connected: true, prs: [prRow(9, livePR(9, PASSED, { state: 'merged' })), prRow(8, livePR(8, FAILED, { state: 'merged' }))] }
    h.ciPrs = []
    const first = show()
    await screen.findByText(/✓/)
    await new Promise((r) => setTimeout(r, 20))
    expect(document.querySelector('[data-deck-pr-detail]')).toBeNull()
    // Settled rows are read once, closed, for their time against the median.
    await waitFor(() => expect(h.ciPrs).toEqual([9, 8]))
    h.ciPrs = []
    // A click opens a row in place; another closes it and opens its own.
    fireEvent.click(rowButton(8))
    await waitFor(() => expect(h.ciPrs).toContain(8))
    expect(document.querySelectorAll('[data-deck-pr-detail]')).toHaveLength(1)
    expect(document.querySelector('[data-deck-pr="8"] [data-deck-pr-detail]')).not.toBeNull()
    fireEvent.click(rowButton(9))
    await waitFor(() => expect(h.ciPrs).toContain(9))
    expect(document.querySelectorAll('[data-deck-pr-detail]')).toHaveLength(1)
    expect(document.querySelector('[data-deck-pr="9"] [data-deck-pr-detail]')).not.toBeNull()
    // The same row again closes it.
    fireEvent.click(rowButton(9))
    expect(document.querySelector('[data-deck-pr-detail]')).toBeNull()
    first.unmount()
    // An open current PR whose checks passed opens by itself: its jobs fill the room.
    h.prs = { connected: true, prs: [prRow(6, livePR(6, PASSED))] }
    const second = show()
    await waitFor(() => expect(document.querySelector('[data-deck-pr="6"] [data-deck-pr-detail]')).not.toBeNull())
    second.unmount()
    // A failed current PR opens by itself; with nothing before it, the list says so.
    h.prs = { connected: true, prs: [prRow(5, livePR(5, FAILED))] }
    show()
    await waitFor(() => expect(document.querySelector('[data-deck-pr="5"] [data-deck-pr-detail]')).not.toBeNull())
    expect(rowButton(5)).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('No earlier PRs from this session.')).toBeInTheDocument()
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
    expect(screen.getByRole('tab', { name: 'PRs' })).toHaveAttribute('aria-selected', 'true')
    expect(document.querySelector('[data-deck-pr="8"] [data-deck-pr-detail]')).not.toBeNull()
    h.prs = { connected: true, prs: [] }
    h.ci = { connected: true }
  })

  it('keeps an open job in view with a Fold control, folds it with Esc, then the PR, and remembers that fold', async () => {
    const t0 = now - 5 * 60_000
    const steps = Array.from({ length: 25 }, (_, i) => ({ number: i + 1, name: `step ${i + 1}`, status: 'completed', conclusion: 'success', started_at: t0, completed_at: t0 + 1_000, duration_ms: 1_000 }))
    const job = (id: number) => ({ id, run_id: 7, name: `job ${id}`, status: 'completed', conclusion: 'success', started_at: t0, completed_at: t0 + 60_000, duration_ms: 60_000, labels: [], steps })
    h.ci = { connected: true, pr: { number: 9, url: 'https://github.com/a/b/pull/9', repo: 'a/b', head_sha: 's' }, ci: {
      repo: 'a/b', head_sha: 's', state: 'pass', runner_ms: 120_000, by_os: [], at: now, runs: [{ id: 7, name: 'CI', status: 'completed', conclusion: 'success', jobs: [job(70), job(71)] }] } }
    h.prs = { connected: true, prs: [prRow(9, livePR(9, PASSED)), prRow(8, livePR(8, PASSED, { state: 'merged' }))] }
    const first = show()
    const jobButton = (id: number) => document.querySelector<HTMLElement>(`[data-deck-ci-job="${id}"] button[aria-expanded]`)!
    await waitFor(() => expect(jobButton(70)).not.toBeNull())
    // Nothing failed, so nothing is open: no Fold control.
    expect(document.querySelector('[data-deck-ci-fold]')).toBeNull()
    fireEvent.click(jobButton(70))
    expect(jobButton(70)).toHaveAttribute('aria-expanded', 'true')
    // Its line is pinned at the top of the scroll area, its steps bounded and scrolling on their own.
    expect(document.querySelector('[data-deck-ci-job="70"] [data-deck-ci-job-head]')).toHaveClass('sticky')
    expect(document.querySelector('[data-deck-ci-job="70"] [data-deck-ci-steps]')!.className).toMatch(/max-h-.*100cqh/)
    // The earlier PRs fold into one line while a job is open.
    expect(document.querySelector('[data-deck-pr="8"]')).toBeNull()
    expect(document.querySelector('[data-deck-prs-folded]')).toHaveTextContent('#8')
    // Opening another job closes the first: one at a time.
    fireEvent.click(jobButton(71))
    expect(jobButton(70)).toHaveAttribute('aria-expanded', 'false')
    expect(document.querySelectorAll('[data-deck-ci-fold]')).toHaveLength(1)
    // The Fold control names its key and folds the job.
    const fold = document.querySelector('[data-deck-ci-fold]')!
    expect(fold).toHaveAccessibleName(/Fold job 71’s steps \((Esc)\)/)
    fireEvent.click(fold)
    expect(jobButton(71)).toHaveAttribute('aria-expanded', 'false')
    expect(document.querySelector('[data-deck-pr="8"]')).not.toBeNull()
    // Esc in the deck folds the innermost open thing: the job, then the PR.
    fireEvent.click(jobButton(70))
    fireEvent.keyDown(jobButton(70), { key: 'Escape' })
    expect(jobButton(70)).toHaveAttribute('aria-expanded', 'false')
    expect(document.activeElement).toBe(jobButton(70))
    fireEvent.keyDown(jobButton(70), { key: 'Escape' })
    expect(document.querySelector('[data-deck-pr-detail]')).toBeNull()
    expect(rowButton(9)).toHaveAttribute('aria-expanded', 'false')
    // Esc with nothing open is not the deck's: it goes on to whoever wants it.
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    rowButton(9).dispatchEvent(esc)
    expect(esc.defaultPrevented).toBe(false)
    first.unmount()
    // The current PR folded by hand stays folded when the deck comes back.
    show()
    await waitFor(() => expect(rowButton(9)).toHaveAttribute('aria-expanded', 'false'))
    await new Promise((r) => setTimeout(r, 20))
    expect(document.querySelector('[data-deck-pr-detail]')).toBeNull()
    // Opened again by hand, it is open, and the next deck opens it by itself.
    fireEvent.click(rowButton(9))
    await waitFor(() => expect(document.querySelector('[data-deck-pr="9"] [data-deck-pr-detail]')).not.toBeNull())
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

  it('prices each job, the run and the PR, and leaves a self-hosted job unpriced with the reason', async () => {
    const t0 = now - 10 * 60_000
    const table = { table_version: '2026-10-12.1', table_source: 'https://docs.github.com/en/billing/reference/actions-runner-pricing' }
    const runCost = { usd: 0.31, minutes_billed: 5, free_minutes: 0, unpriced_minutes: 3, priced_jobs: 1, unpriced_jobs: 1, unfinished_jobs: 0, partial: true, visibility: 'private', ...table }
    h.ci = { connected: true, pr: { number: 9, url: 'https://github.com/a/b/pull/9', repo: 'a/b', head_sha: 's' }, ci: {
      repo: 'a/b', head_sha: 's', state: 'pass', runner_ms: 480_000, by_os: [], at: now, cost: runCost, runs: [{ id: 7, name: 'CI', status: 'completed', conclusion: 'success', started_at: t0, updated_at: t0 + 300_000, cost: runCost, jobs: [
        { id: 70, run_id: 7, name: 'macOS', status: 'completed', conclusion: 'success', started_at: t0, completed_at: t0 + 285_000, duration_ms: 285_000, labels: ['macos-14'], os: 'macos', steps: [],
          cost: { priced: true, sku: 'actions_macos', display: 'macOS 3-core (M1)', rate_usd_per_min: 0.062, minutes_billed: 5, usd: 0.31, free_public: false } },
        { id: 71, run_id: 7, name: 'gpu', status: 'completed', conclusion: 'success', started_at: t0, completed_at: t0 + 150_000, duration_ms: 150_000, labels: ['self-hosted', 'gpu'], os: 'self-hosted', steps: [],
          cost: { priced: false, reason: 'self_hosted', minutes_billed: 3, usd: 0, free_public: false } },
      ] }] } }
    h.prs = { connected: true, prs: [prRow(9, livePR(9, PASSED))] }
    show()
    // An open PR with checks opens by itself.
    await waitFor(() => expect(rowButton(9)).toHaveAttribute('aria-expanded', 'true'))
    const mac = await screen.findByText('macOS')
    const cost = mac.closest('button')!.querySelector('[data-deck-cost="job"]')!
    expect(cost).toHaveTextContent('$0.31')
    expect(cost.getAttribute('title')).toMatch(/Rate table 2026-10-12\.1 · https:\/\/docs\.github\.com/)
    const gpu = screen.getByText('gpu').closest('button')!.querySelector('[data-deck-cost="job"]')!
    expect(gpu).toHaveTextContent('unpriced')
    expect(gpu).toHaveAttribute('data-tone', 'muted')
    expect(gpu.getAttribute('title')).toMatch(/self-hosted/)
    // The sum beside the runner total, short of the whole while a job is unpriced, said once for one run; the PR row carries it too.
    expect(document.querySelector('[data-deck-cost="ci"]')).toHaveTextContent('≥$0.31')
    expect(document.querySelector('[data-deck-run-time] [data-deck-cost]')).toBeNull()
    await waitFor(() => expect(document.querySelector('[data-deck-pr="9"] [data-deck-cost="pr"]')).toHaveTextContent('≥$0.31'))
  })

  it('says what GitHub billed this month in Main, or which permission the token lacks', async () => {
    h.main = { connected: true, repo: 'ada/b', branch: 'main', ci: { repo: 'ada/b', head_sha: 'm', branch: 'main', state: 'pass', runner_ms: 60_000, by_os: [], at: now, runs: [
      { id: 50, name: 'CI', status: 'completed', conclusion: 'success', jobs: [] }] } }
    h.usage = { account: 'ada', org: false, year: 2026, month: 10, available: true, minutes: 1240, gross_usd: 12.4, discount_usd: 5, net_usd: 7.4, by_sku: [], at: now }
    // Not asked outside the Main view.
    const first = show()
    await new Promise((r) => setTimeout(r, 20))
    expect(h.usageAsked).toBe(0)
    first.unmount()
    localStorage.setItem('caprock.deck.ciView', 'main')
    const second = show()
    expect(await screen.findByText('Actions this month: 1,240 min · $7.40')).toBeInTheDocument()
    expect(document.querySelector('[data-deck-usage]')).toHaveAttribute('data-deck-usage', 'available')
    second.unmount()
    h.usage = { account: 'ada', org: false, year: 2026, month: 10, available: false, reason: 'permission', needs: ['"Plan" user permission (read), for a fine-grained token'], minutes: 0, gross_usd: 0, discount_usd: 0, net_usd: 0, by_sku: [], at: now }
    show()
    expect(await screen.findByText('Real billing: needs the token’s Plan (read) permission')).toBeInTheDocument()
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    fireEvent.click(screen.getByRole('button', { name: /token settings/ }))
    expect(String(open.mock.calls.at(-1)?.[0] ?? '')).toBe('https://github.com/settings/personal-access-tokens')
    open.mockRestore()
  })

  it('lists the branches, the current one first, marks the stale ones, and opens a branch’s PR in the PRs view', async () => {
    const b = (name: string, p: object = {}) => ({ name, local: true, remote: true, committed_ms: now - 3_600_000, author: 'Ada', cost_usd: 0, sessions: 0, agents: [], activity_at: now, ahead: 1, behind: 0, ...p })
    h.branches = { connected: true, repo: 'a/b', default: 'main', current: 'feat/9', branches: [
      b('feat/9', { current: true, ahead: 2, behind: 1, cost_usd: 4.5, sessions: 3, agents: ['claude'], pr: { number: 9, url: 'https://github.com/a/b/pull/9', state: 'open' }, live: livePR(9, PASSED) }),
      b('main', { default: true, ahead: 0, behind: 0 }),
      b('feat/77', { pr: { number: 77, url: 'https://github.com/a/b/pull/77', state: 'merged' } }),
      b('old', { committed_ms: now - 40 * 86_400_000, stale: true }),
      ...Array.from({ length: 14 }, (_, i) => b(`more-${i}`)),
    ] }
    h.prs = { connected: true, prs: [prRow(9, livePR(9, PASSED))] }
    h.ci = { connected: true, pr: { number: 9, url: 'https://github.com/a/b/pull/9', repo: 'a/b', head_sha: 's' }, ci: { repo: 'a/b', head_sha: 's', state: 'pass', runner_ms: 0, by_os: [], at: now, runs: [] } }
    show()
    await waitFor(() => rowButton(9))
    fireEvent.click(screen.getByRole('tab', { name: 'Branches' }))
    await waitFor(() => expect(document.querySelectorAll('[data-deck-branch-row]').length).toBe(15))
    const rows = [...document.querySelectorAll('[data-deck-branch-row]')]
    expect(rows.slice(0, 4).map((r) => r.getAttribute('data-deck-branch-row'))).toEqual(['feat/9', 'main', 'feat/77', 'old'])
    expect(rows[0]).toHaveAttribute('data-current')
    expect(rows[0]!.querySelector('[data-deck-branch-ab]')).toHaveTextContent('↑2 ↓1')
    expect(rows[0]!.querySelector('[data-deck-branch-spend]')).toHaveTextContent('$4.50 · 3 sessions')
    expect(rows[0]!.querySelector('[data-deck-branch-pr="9"]')).toBeInTheDocument()
    expect(rows[3]).toHaveAttribute('data-stale')
    expect(rows[3]!.querySelector('[data-deck-stale]')!.getAttribute('title')).toMatch(/no commit in 30 days and no open pull request/)
    expect(rows[1]!.querySelector('[data-deck-stale]')).toBeNull()
    // Show all.
    fireEvent.click(screen.getByRole('button', { name: 'Show all 18' }))
    expect(document.querySelectorAll('[data-deck-branch-row]').length).toBe(18)
    // A PR that is not this session's opens on GitHub.
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    fireEvent.click(rows[2]!.firstElementChild!)
    expect(String(open.mock.calls.at(-1)?.[0] ?? '')).toBe('https://github.com/a/b/pull/77')
    open.mockRestore()
    // The session's own PR opens in the PRs view.
    fireEvent.click(rows[0]!.firstElementChild!)
    expect(screen.getByRole('tab', { name: 'PRs' })).toHaveAttribute('aria-selected', 'true')
    await waitFor(() => expect(document.querySelector('[data-deck-pr="9"]')).toHaveAttribute('data-open'))
  })
})

describe('the deck’s pull request rows: who is on them, and forcing a fix', () => {
  const wt = (branch: string, agents: { s: Partial<SessionSummary>; dot: 'working' | 'waiting' | 'idle' }[], path = `/w/.caprock-worktrees/${branch.replace('/', '-')}`) =>
    ({ branch, path, agents: agents.map((a) => ({ session: agent({ session_id: 'x', git_branch: branch, ...a.s }), dot: a.dot })) })

  it('says conflict, behind, review and draft beside the pipeline, and nothing while GitHub is still computing', async () => {
    h.prs = { connected: true, prs: [
      prRow(9, livePR(9, PASSED, { mergeable: false, mergeable_state: 'dirty' })),
      prRow(8, livePR(8, PASSED, { mergeable: true, mergeable_state: 'behind', review: 'changes_requested' })),
      prRow(7, livePR(7, PASSED, { mergeable: null, mergeable_state: 'unknown', draft: true })),
      prRow(6, livePR(6, PASSED, { mergeable: false, state: 'merged' })),
    ] }
    show()
    await waitFor(() => rowButton(6))
    const chips = (n: number) => [...document.querySelectorAll(`[data-deck-pr="${n}"] [data-deck-pr-chip]`)].map((c) => c.textContent)
    expect(chips(9)).toEqual(['conflict'])
    expect(document.querySelector('[data-deck-pr="9"] [data-deck-pr-chip]')).toHaveClass('text-danger')
    // One chip, the most important; the rest in its tooltip.
    expect(chips(8)).toEqual(['behind'])
    expect(document.querySelector('[data-deck-pr="8"] [data-deck-pr-chip]')!.getAttribute('title')).toMatch(/\nAlso: changes requested$/)
    expect(chips(7)).toEqual(['draft'])
    expect(chips(6)).toEqual([])
  })

  it('marks the agent on the PR’s branch with its initial and state, opening its tab; several are counted', async () => {
    h.prs = { connected: true, prs: [prRow(9, livePR(9, PASSED)), prRow(8, livePR(8, PASSED))] }
    const onOpenSession = vi.fn()
    show({ onOpenSession, worktrees: [
      wt('feat/9', [{ s: { session_id: 'a1', title: 'merge fixer' }, dot: 'working' }]),
      wt('feat/8', [{ s: { session_id: 'b1', title: 'bob' }, dot: 'idle' }, { s: { session_id: 'b2', title: 'carol' }, dot: 'waiting' }, { s: { session_id: 'b3', status: 'ended' }, dot: 'idle' }]),
      wt('feat/x', [{ s: { session_id: 'c1' }, dot: 'working' }]),
    ] })
    await waitFor(() => rowButton(8))
    // One word for whether anything is on it, the agent's initial beside it.
    const mark9 = document.querySelector('[data-deck-pr="9"] [data-deck-pr-status]')!
    expect(mark9).toHaveAttribute('data-deck-pr-status', 'in work')
    expect(mark9).toHaveTextContent(/^Min work$/)
    expect(mark9.querySelector('[data-deck-pr-agent]')).toHaveAttribute('data-deck-pr-agent', 'fixing')
    fireEvent.click(mark9)
    expect(onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ session_id: 'a1' }))
    // Two live agents, the waiting one first; the ended one is not on it.
    const mark8 = document.querySelector('[data-deck-pr="8"] [data-deck-pr-status]')!
    expect(mark8).toHaveAttribute('data-deck-pr-status', 'waiting')
    expect(mark8).toHaveTextContent(/^Cwaiting\+1$/)
    expect(mark8.getAttribute('title')).toMatch(/carol — waiting on feat\/8\n.*bob — idle/)
  })

  it('re-runs the checks after a confirm in the row, and says so in the row', async () => {
    h.prs = { connected: true, prs: [prRow(9, livePR(9, FAILED, { head_sha: 'h1', mergeable: true, mergeable_state: 'behind' }))] }
    h.ci = { connected: true, pr: { number: 9, url: 'https://github.com/a/b/pull/9', repo: 'a/b', head_sha: 'h1' }, ci: { repo: 'a/b', head_sha: 'h1', state: 'fail', runner_ms: 0, by_os: [], at: now, runs: [] } }
    show()
    const rerun = await waitFor(() => {
      const b = document.querySelector<HTMLButtonElement>('[data-deck-pr="9"] [data-deck-pr-action="rerun"]')
      if (!b) throw new Error('no actions')
      return b
    })
    // Behind and no conflict: Update branch; no conflict fix.
    expect(document.querySelector('[data-deck-pr-action="update"]')).toBeInTheDocument()
    expect(document.querySelector('[data-deck-pr-action="conflict"]')).toBeNull()
    expect(document.querySelector('[data-deck-pr-action="ci"]')).toBeInTheDocument()
    // A click asks first, in the row; Esc cancels and nothing is sent.
    fireEvent.click(rerun)
    expect(document.querySelector('[data-deck-pr-confirm]')).toHaveTextContent('Re-run #9’s failed jobs on GitHub?')
    fireEvent.keyDown(document.querySelector('[data-deck-pr-confirm-yes]')!, { key: 'Escape' })
    expect(document.querySelector('[data-deck-pr-confirm]')).toBeNull()
    expect(h.forced).toEqual([])
    fireEvent.click(document.querySelector('[data-deck-pr-action="rerun"]')!)
    fireEvent.click(document.querySelector('[data-deck-pr-confirm-yes]')!)
    await waitFor(() => expect(h.forced).toEqual(['rerun 9']))
    // The row says it is in work; what it is doing is the word's tooltip.
    await waitFor(() => expect(document.querySelector('[data-deck-pr="9"] [data-deck-pr-status="in work"]')).toHaveAttribute('title', 're-running 2 jobs…'))
    // Update branch the same way.
    fireEvent.click(document.querySelector('[data-deck-pr-action="update"]')!)
    expect(document.querySelector('[data-deck-pr-confirm]')).toHaveTextContent('Merge main into feat/9 on GitHub (Update branch)?')
    fireEvent.click(document.querySelector('[data-deck-pr-confirm-yes]')!)
    await waitFor(() => expect(h.forced).toEqual(['rerun 9', 'update 9']))
    await waitFor(() => expect(document.querySelector('[data-deck-pr="9"] [data-deck-pr-status="in work"]')).toHaveAttribute('title', 'updating branch…'))
  })

  it('says which permission GitHub wants when it refuses a re-run', async () => {
    h.prs = { connected: true, prs: [prRow(9, livePR(9, FAILED, { head_sha: 'h1' }))] }
    h.rerunFail = new ApiError(502, '502', { error: 'Re-running the checks: Resource not accessible by personal access token (403).', needs: ['"Actions" repository permission (write), for a fine-grained token'] })
    const onToast = vi.fn()
    show({ onToast })
    const rerun = await waitFor(() => {
      const b = document.querySelector('[data-deck-pr="9"] [data-deck-pr-action="rerun"]')
      if (!b) throw new Error('no actions')
      return b
    })
    fireEvent.click(rerun)
    fireEvent.click(document.querySelector('[data-deck-pr-confirm-yes]')!)
    await waitFor(() => expect(onToast).toHaveBeenCalledWith(expect.stringMatching(/^Re-run checks: .*Needs the token's "Actions" repository permission \(write\)/)))
    expect(document.querySelector('[data-deck-pr-status]')).toBeNull()
  })

  it('sends a conflict to the Caprock-started agent on the branch, else starts one, never typing into another', async () => {
    const conflict = livePR(9, PASSED, { head_sha: 'h1', mergeable: false, mergeable_state: 'dirty', title: 'Add x' })
    h.prs = { connected: true, prs: [prRow(9, conflict)] }
    const onStartAgent = vi.fn(async () => {})
    const owned = wt('feat/9', [{ s: { session_id: 'a1', title: 'fixer', owned: true }, dot: 'idle' }])
    const r = show({ onStartAgent, worktrees: [owned] })
    const fix = await waitFor(() => {
      const b = document.querySelector('[data-deck-pr="9"] [data-deck-pr-action="conflict"]')
      if (!b) throw new Error('no actions')
      return b
    })
    // A conflict: no Update branch.
    expect(document.querySelector('[data-deck-pr-action="update"]')).toBeNull()
    fireEvent.click(fix)
    expect(document.querySelector('[data-deck-pr-confirm]')).toHaveTextContent('Ask fixer to merge origin/main, resolve the conflicts, run the checks and push?')
    fireEvent.click(document.querySelector('[data-deck-pr-confirm-yes]')!)
    await waitFor(() => expect(h.queuedTo).toEqual(['a1']))
    expect(h.queued[0]).toMatch(/has merge conflicts with main/)
    expect(h.queued[0]).toMatch(/git merge origin\/main/)
    expect(onStartAgent).not.toHaveBeenCalled()
    await waitFor(() => expect(document.querySelector('[data-deck-pr="9"] [data-deck-pr-status="in work"]')!.getAttribute('title')).toMatch(/^agent fixing…/))
    r.unmount()
    forgetPRProgress()

    // Someone Caprock did not start is on it: a new agent in a new worktree
    // at the PR's head, and nothing typed into theirs (rule 7).
    const foreign = wt('feat/9', [{ s: { session_id: 'f1', title: 'theirs', owned: false }, dot: 'working' }])
    show({ onStartAgent, worktrees: [foreign], s: agent({ repo_root: '/w' }) })
    fireEvent.click(await waitFor(() => {
      const b = document.querySelector('[data-deck-pr="9"] [data-deck-pr-action="conflict"]')
      if (!b) throw new Error('no actions')
      return b
    }))
    expect(document.querySelector('[data-deck-pr-confirm]')).toHaveTextContent(/Start an agent in a new worktree at #9’s head .*was not started by Caprock, so nothing is typed into it/)
    fireEvent.click(document.querySelector('[data-deck-pr-confirm-yes]')!)
    await waitFor(() => expect(onStartAgent).toHaveBeenCalledTimes(1))
    const [req] = onStartAgent.mock.calls[0] as unknown as [{ cwd: string; worktree: string; worktree_pr: number; prompt: string }]
    expect(req).toMatchObject({ cwd: '/w', worktree: 'pr-9-fix', worktree_pr: 9 })
    expect(req.prompt).toMatch(/git push origin HEAD:feat\/9/)
    expect(h.queuedTo).toEqual(['a1'])
  })

  it('offers the one direct action beside the problem on every open row, asking in the row without opening it', async () => {
    h.prs = { connected: true, prs: [
      prRow(9, livePR(9, { state: 'none', passed: 0, failed: 0, pending: 0, items: [] }, { mergeable: false, mergeable_state: 'dirty' })),
      prRow(8, livePR(8, FAILED, { mergeable: false, mergeable_state: 'dirty' })),
      prRow(7, livePR(7, FAILED)),
      prRow(6, livePR(6, PASSED, { mergeable_state: 'behind' })),
      prRow(5, livePR(5, PASSED, { mergeable: false, mergeable_state: 'dirty', state: 'merged' })),
    ] }
    forgetFoldedPRs()
    show()
    await waitFor(() => rowButton(5))
    const quick = (n: number) => [...document.querySelectorAll(`[data-deck-pr="${n}"] [data-deck-pr-quick]`)].map((b) => `${b.getAttribute('data-deck-pr-quick')}:${b.textContent}`)
    expect(quick(9)).toEqual(['conflict:Fix'])
    // A conflict outranks the failed CI: one chip, one action, the CI in its tooltip.
    expect(quick(8)).toEqual(['conflict:Fix'])
    expect(document.querySelector('[data-deck-pr="8"] [data-deck-pr-chip]')!.getAttribute('title')).toMatch(/Also: CI failed$/)
    // Failed CI: no chip (the CI words say it), Fix and Re-run.
    expect(document.querySelector('[data-deck-pr="7"] [data-deck-pr-chip]')).toBeNull()
    expect(quick(7)).toEqual(['ci:Fix', 'rerun:Re-run'])
    expect(quick(6)).toEqual(['update:Update'])
    expect(quick(5)).toEqual([])
    // Every open row has its ⋯, the merged one none.
    for (const n of [9, 8, 7, 6]) expect(document.querySelector(`[data-deck-pr="${n}"] [data-deck-pr-menu]`)).toBeInTheDocument()
    expect(document.querySelector('[data-deck-pr="5"] [data-deck-pr-menu]')).toBeNull()
    // Update on a row that is not the open one: the confirm in that row, its CI not opened.
    fireEvent.click(document.querySelector('[data-deck-pr="6"] [data-deck-pr-quick="update"]')!)
    expect(document.querySelector('[data-deck-pr="6"] [data-deck-pr-confirm]')).toHaveTextContent('Merge main into feat/6 on GitHub (Update branch)?')
    expect(document.querySelector('[data-deck-pr="6"] [data-deck-pr-detail]')).toBeNull()
    fireEvent.click(document.querySelector('[data-deck-pr-confirm-yes]')!)
    await waitFor(() => expect(h.forced).toEqual(['update 6']))
  })

  it('says queued for a message waiting for the agent on the branch, or GitHub’s auto-merge, and nothing when nobody is on it', async () => {
    h.prs = { connected: true, prs: [prRow(9, livePR(9, PASSED)), prRow(8, livePR(8, PASSED, { auto_merge: true })), prRow(7, livePR(7, PASSED))] }
    h.queues = { a1: [{ text: 'rebase and push' }] }
    show({ worktrees: [wt('feat/9', [{ s: { session_id: 'a1', title: 'fixer', owned: true }, dot: 'idle' }])] })
    await waitFor(() => expect(document.querySelector('[data-deck-pr="9"] [data-deck-pr-status]')).toHaveAttribute('data-deck-pr-status', 'queued'))
    expect(document.querySelector('[data-deck-pr="9"] [data-deck-pr-status]')).toHaveTextContent(/^Fqueued$/)
    expect(document.querySelector('[data-deck-pr="9"] [data-deck-pr-status]')!.getAttribute('title')).toMatch(/1 message queued/)
    expect(document.querySelector('[data-deck-pr="8"] [data-deck-pr-status]')).toHaveAttribute('data-deck-pr-status', 'queued')
    expect(document.querySelector('[data-deck-pr="8"] [data-deck-pr-status]')!.getAttribute('title')).toMatch(/auto-merge is on/)
    expect(document.querySelector('[data-deck-pr="7"] [data-deck-pr-status]')).toBeNull()
    h.queues = {}
  })

  it('offers the actions greyed with Connect GitHub while GitHub is not connected', async () => {
    h.prs = { connected: false, prs: [prRow(9, undefined), prRow(8, undefined, { merged_at: now - 60_000 })] }
    forgetFoldedPRs()
    show()
    await waitFor(() => rowButton(8))
    expect(document.querySelector('[data-deck-pr="8"] [data-deck-pr-menu]')).toBeNull()
    fireEvent.click(document.querySelector('[data-deck-pr="9"] [data-deck-pr-menu]')!)
    const line = await waitFor(() => {
      const l = document.querySelector('[data-deck-pr="9"] [data-deck-pr-actions]')
      if (!l) throw new Error('no actions')
      return l
    })
    const acts = [...line.querySelectorAll<HTMLButtonElement>('[data-deck-pr-action]')]
    expect(acts.map((b) => b.getAttribute('data-deck-pr-action'))).toEqual(['conflict', 'ci', 'rerun', 'update'])
    expect(acts.every((b) => b.disabled)).toBe(true)
    expect(line.querySelector('[data-deck-pr-connect]')).toHaveTextContent('Connect GitHub')
  })

  it('opens a row at its actions from ⋯, and Fix CI reaches the session in front when nobody is on the branch', async () => {
    h.prs = { connected: true, prs: [prRow(9, livePR(9, PASSED)), prRow(8, livePR(8, PASSED, { state: 'merged' }))] }
    forgetFoldedPRs()
    show()
    await waitFor(() => rowButton(8))
    // The merged one has no actions.
    expect(document.querySelector('[data-deck-pr="8"] [data-deck-pr-menu]')).toBeNull()
    fireEvent.click(document.querySelector('[data-deck-pr="9"] [data-deck-pr-menu]')!)
    await waitFor(() => expect(document.activeElement).toHaveAttribute('data-deck-pr-action', 'ci'))
    fireEvent.click(document.activeElement!)
    expect(document.querySelector('[data-deck-pr-confirm]')).toHaveTextContent(/^Ask .* to fix #9’s CI and push\?$/)
    fireEvent.click(document.querySelector('[data-deck-pr-confirm-yes]')!)
    await waitFor(() => expect(h.queuedTo).toEqual(['s1']))
    expect(h.queued[0]).toMatch(/Look at the CI of pull request #9/)
  })
})

describe('the pull requests cell opens on what it last knew', () => {
  /** A read that waits until the test lets it go. */
  const gate = () => { let open = () => {}; const p = new Promise<void>((r) => { open = r }); return { p, open } }

  it('draws three grey rows the first time ever, never an empty area', async () => {
    const g = gate()
    h.prsGate = g.p
    h.prs = { connected: true, prs: [prRow(9, livePR(9, PASSED))] }
    show()
    const sk = document.querySelector('[data-deck-skeleton]')
    expect(sk).toBeInTheDocument()
    expect(sk!.querySelectorAll('li')).toHaveLength(3)
    expect(sk).toHaveAttribute('aria-busy', 'true')
    await act(async () => { g.open() })
    await waitFor(() => rowButton(9))
    expect(document.querySelector('[data-deck-skeleton]')).toBeNull()
    // What it was told is kept for the next open, in memory and in storage.
    expect(readDeck('prs:s1')).toBeDefined()
    expect(localStorage.getItem('caprock-swr-v1:deck:prs:s1')).toContain('PR 9')
  })

  it('draws the last answer at once, says it is updating, then how fresh the new one is', async () => {
    writeDeck('prs:s1', { connected: true, prs: [prRow(9, livePR(9, PASSED, { title: 'Kept title' }))], fetched_at: now - 60_000 }, now - 60_000)
    const g = gate()
    h.prsGate = g.p
    h.prs = { connected: true, prs: [prRow(9, livePR(9, PASSED, { title: 'New title' }))], fetched_at: Date.now() } as typeof h.prs
    show()
    // Before any answer: the kept rows, no skeleton, and the quiet marker.
    expect(rowButton(9)).toHaveTextContent('Kept title')
    expect(document.querySelector('[data-deck-skeleton]')).toBeNull()
    await waitFor(() => expect(document.querySelector('[data-deck-fresh]')).toHaveAttribute('data-deck-fresh', 'updating'))
    expect(document.querySelector('[data-deck-fresh]')).toHaveTextContent('updating…')
    await act(async () => { g.open() })
    await waitFor(() => expect(rowButton(9)).toHaveTextContent('New title'))
    expect(document.querySelector('[data-deck-fresh]')).toHaveAttribute('data-deck-fresh', 'ok')
    expect(document.querySelector('[data-deck-fresh]')!.textContent).toMatch(/^updated (just now|\d+ s ago)$/)
  })

  it('keeps the last answer when a read fails, and says it could not refresh', async () => {
    writeDeck('prs:s1', { connected: true, prs: [prRow(9, livePR(9, PASSED, { title: 'Kept title' }))], fetched_at: now - 60_000 })
    h.prsFail = new Error('daemon away')
    show()
    expect(rowButton(9)).toHaveTextContent('Kept title')
    await waitFor(() => expect(document.querySelector('[data-deck-fresh]')).toHaveAttribute('data-deck-fresh', 'failed'))
    expect(document.querySelector('[data-deck-fresh]')).toHaveTextContent('couldn’t refresh')
    expect(rowButton(9)).toHaveTextContent('Kept title')
  })

  it('reopens on the answer from before it was closed, and a view switch is instant from what was kept', async () => {
    h.prs = { connected: true, prs: [prRow(9, livePR(9, PASSED))] }
    const first = show()
    await waitFor(() => rowButton(9))
    first.unmount()
    // Closed and opened again, with the daemon slow this time.
    const g = gate()
    h.prsGate = g.p
    writeDeck('branches:/w', { connected: true, repo: 'a/b', default: 'main', current: 'main', branches: [{ name: 'main', default: true, current: true, local: true, remote: true, committed_ms: now, cost_usd: 0, sessions: 0, agents: [], activity_at: now, ahead: 0, behind: 0 }] })
    h.branchesGate = new Promise(() => {})
    show()
    expect(rowButton(9)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Branches' }))
    expect(document.querySelector('[data-deck-branch-row="main"]')).toBeInTheDocument()
    expect(document.querySelector('[data-deck-skeleton]')).toBeNull()
    await act(async () => { g.open() })
  })

  it('asks nothing while the window is hidden, and asks once it is shown', async () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    show()
    await new Promise((r) => setTimeout(r, 20))
    expect(h.prsAsked).toBe(0)
    hidden.mockReturnValue(false)
    await act(async () => { document.dispatchEvent(new window.Event('visibilitychange')) })
    await waitFor(() => expect(h.prsAsked).toBe(1))
    hidden.mockRestore()
  })
})
