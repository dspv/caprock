/**
 * A job GitHub never gave a machine (run 44324234291, 2026-11-18: a hosted
 * macOS job waited ~15 minutes, then was cancelled with no step run and no
 * runner): drawn apart from a real failure, muted amber, with the re-run
 * right there. Real failures stay red.
 */
import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CockpitCI } from './CockpitCI'
import { CheckSummary } from './CheckSummary'
import { FoldCtx } from './Cockpit'
import { forgetDeckAnswers } from '@/lib/deckCache'
import { forgetPRProgress } from '@/lib/usePRForce'
import { NO_RUNNER_TITLE, checksSentence, ciTone, prChecks } from '@/lib/ci'
import { prProblems, quickActions } from '@/lib/prforce'

const now = Date.now()
const live = (n: number, checks: object, p: object = {}) => ({ number: n, url: `https://github.com/a/b/pull/${n}`, title: `PR ${n}`, state: 'open', draft: false,
  review: '', reviews: [], branch: `feat/${n}`, base: 'main', mergeable: true, head_sha: 'h1', checks, ...p })
const row = (n: number, l: object) => ({ session_id: 's1', number: n, url: `https://github.com/a/b/pull/${n}`, title: `PR ${n}`, last_at: now, live: l })
const job = (job: number, name: string, state: string, extra: object = {}) => ({ name, state, status: 'completed', job_id: job,
  url: `https://github.com/a/b/actions/runs/7/job/${job}`, started_at: now - 900_000, completed_at: now - 10_000, ...extra })
const IDLE = { state: 'no_runner', passed: 12, failed: 0, pending: 0, no_runner: 1, items: [
  job(71, 'go (macos-latest)', 'fail', { no_runner: true }),
  ...Array.from({ length: 12 }, (_, i) => job(80 + i, `check ${i}`, 'pass')),
] }
const MIXED = { state: 'fail', passed: 11, failed: 1, pending: 0, no_runner: 1, items: [
  job(70, 'go (ubuntu-latest)', 'fail'), job(71, 'go (macos-latest)', 'fail', { no_runner: true }),
  ...Array.from({ length: 11 }, (_, i) => job(80 + i, `check ${i}`, 'pass')),
] }

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'], now }) })
afterEach(() => { forgetDeckAnswers(); forgetPRProgress(); localStorage.clear(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('a job GitHub never ran', () => {
  it('is its own state, not a failure, in the counts and the sentence', () => {
    const s = prChecks({ live: { checks: IDLE } } as never, now)!
    expect(s.counts).toMatchObject({ fail: 0, norunner: 1, pass: 12 })
    expect(s.green).toBe(false)
    expect(s.nodes[0]!.tone).toBe('norunner')
    expect(checksSentence(s)).toBe('13 checks: 1 given no runner by GitHub, 12 passed')
    expect(ciTone({ status: 'completed', conclusion: 'cancelled', no_runner: true })).toBe('norunner')
    expect(ciTone({ status: 'completed', conclusion: 'failure' })).toBe('fail')
  })

  it('draws "⚠ 1 no runner" in muted amber with the reason on hover; a real failure stays red beside it', () => {
    const s = prChecks({ live: { checks: IDLE } } as never, now)!
    const { unmount } = render(<CheckSummary s={s} label="#941: its checks" />)
    const part = document.querySelector('[data-check-part="norunner"]')!
    expect(part).toHaveTextContent('1 no runner')
    expect(part).toHaveClass('text-norunner')
    expect(part).toHaveAttribute('title', NO_RUNNER_TITLE)
    expect(document.querySelector('[data-check-summary]')).toHaveAttribute('data-check-summary', 'norunner')
    expect(document.querySelector('[data-check-part="fail"]')).toBeNull()
    unmount()
    render(<CheckSummary s={prChecks({ live: { checks: MIXED } } as never, now)!} label="#941: its checks" />)
    expect(document.querySelector('[data-check-part="fail"]')).toHaveClass('text-danger')
    expect(document.querySelector('[data-check-part="fail"]')).toHaveTextContent('1 failed')
    expect(document.querySelector('[data-check-part="norunner"]')).toHaveTextContent('1 no runner')
    expect(document.querySelector('[data-check-summary]')).toHaveAttribute('data-check-summary', 'fail')
  })

  it('keeps its mark when the summary is shortened to the worst state', () => {
    const s = prChecks({ live: { checks: IDLE } } as never, now)!
    render(<CheckSummary s={s} label="x" fit="worst" />)
    expect(document.querySelector('[data-check-part="norunner"]')).toHaveTextContent('no runner')
    expect(document.querySelector('[data-mark="norunner"]')).not.toBeNull()
  })

  it('asks for a re-run, not a fix: its PR’s one action is Re-run', () => {
    const p = row(9, live(9, IDLE)) as never
    expect(prProblems(p)).toEqual(['norunner'])
    expect(quickActions(p)).toEqual(['rerun'])
    expect(quickActions(row(9, live(9, MIXED)) as never)).toEqual(['ci', 'rerun'])
  })

  it('folded, offers Rerun on the line, asks once, and re-runs the failed jobs', async () => {
    const posts: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (init?.method === 'POST') { posts.push(url); return json({ ok: true, mode: 'failed', runs: 1, jobs: 1 }) }
      if (url.endsWith('/prs')) return json({ connected: true, prs: [row(941, live(941, IDLE))] })
      return json({ connected: true, fetched_at: now, read_at: now, prs: [] })
    }))
    const s = { session_id: 's1', owned: true, status: 'active', title: 'Agent', cwd: '/w', repo_root: '/w' }
    render(
      <FoldCtx.Provider value={{ full: false, toggle: () => {} }}>
        <CockpitCI sessionId="s1" s={s as never} repoScope="/w" onOpen={() => {}} />
      </FoldCtx.Provider>,
    )
    const btn = await waitFor(() => {
      const b = document.querySelector<HTMLButtonElement>('[data-cockpit-ci-fold] [data-cockpit-ci-fold-rerun]')
      if (!b) throw new Error('no rerun')
      return b
    })
    expect(btn).toHaveTextContent('Rerun')
    expect(btn).toBeEnabled()
    expect(btn.getAttribute('title')).toContain(NO_RUNNER_TITLE)
    expect(document.querySelector('[data-cockpit-ci-fold] [data-check-part="norunner"]')).toHaveTextContent('1 no runner')
    fireEvent.click(btn)
    expect(posts).toEqual([])
    const confirm = document.querySelector('[data-cockpit-ci-fold-confirm]')!
    expect(confirm).toHaveTextContent('Re-run?')
    expect(confirm.querySelector('[title]')).toHaveAttribute('title', 'Re-run #941’s job GitHub gave no machine?')
    await act(async () => { fireEvent.click(document.querySelector('[data-cockpit-ci-fold-confirm-yes]')!) })
    await waitFor(() => expect(posts).toEqual(['/v1/sessions/s1/prs/941/rerun']))
    await waitFor(() => expect(document.querySelector('[data-cockpit-ci-fold-progress]')).toHaveAttribute('title', 're-running 1 job…'))
  })

  it('unfolded, says "⚠ 1 no runner" on its row with Re-run, the CI step muted amber, not red', async () => {
    const stats = { connected: true, repo: 'a/b', fetched_at: now, read_at: now,
      prs: [{ number: 941, url: 'https://github.com/a/b/pull/941', title: 'docs(readme): answer first', state: 'open', created_at: now - 3_600_000 }],
      board: { cards: [{ number: 941, stage: 'open', ci: 'no_runner', stage_at: now - 600_000, spend: { cost_usd: 0, sessions: 0, live: 0, agents: [] } }],
        releases: [], flow: { counts: {}, days: 14, merged: 0, ttm_count: 0, release_lag_count: 0, cost_usd: 0 }, ships_by: 'release' } }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url.endsWith('/ci/stats')) return json(stats)
      if (url.endsWith('/prs')) return json({ connected: true, prs: [row(941, live(941, IDLE))] })
      return new Response('', { status: 404 })
    }))
    const s = { session_id: 's1', owned: true, status: 'active', title: 'Agent', cwd: '/w', repo_root: '/w' }
    render(<CockpitCI sessionId="s1" s={s as never} repoScope="/w" onOpen={() => {}} />)
    const note = await waitFor(() => {
      const n = document.querySelector('[data-cockpit-ci-pr="941"] [data-cockpit-ci-norunner]')
      if (!n) throw new Error('no note')
      return n
    })
    expect(note).toHaveTextContent('1 no runner')
    expect(note).toHaveAttribute('title', NO_RUNNER_TITLE)
    expect(document.querySelector('[data-cockpit-ci-pr="941"] [data-cockpit-ci-action]')).toHaveAttribute('data-cockpit-ci-action', 'rerun')
    const ci = document.querySelector('[data-cockpit-ci-pr="941"] [data-journey-seg="ci"]')!
    expect(ci).toHaveClass('bg-norunner')
    expect(ci).not.toHaveClass('bg-danger')
  })
})
