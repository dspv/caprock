/**
 * The folded CI line and the unfolded block say the same (owner,
 * 2026-11-18): the same pull request, and per state — failed, no runner,
 * running, queued, passed, skipped — the same counts, from one function over
 * the same read. Rendered folded and unfolded from one fixture per state.
 */
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CockpitCI } from './CockpitCI'
import { FoldCtx } from './Cockpit'
import { forgetDeckAnswers } from '@/lib/deckCache'
import { forgetPRProgress } from '@/lib/usePRForce'

const now = Date.now()
const check = (job: number, state: string, extra: object = {}) => ({ name: `job ${job}`, state, status: 'completed', job_id: job,
  url: `https://github.com/a/b/actions/runs/7/job/${job}`, started_at: now - 900_000, completed_at: now - 10_000, ...extra })
const running = (job: number) => ({ ...check(job, 'pending'), status: 'in_progress', completed_at: undefined })
const queued = (job: number) => ({ ...check(job, 'pending'), status: 'queued', started_at: undefined, completed_at: undefined })
const pass = (n: number, from = 100) => Array.from({ length: n }, (_, i) => check(from + i, 'pass'))
const skip = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `skip ${i}`, state: 'skipped' }))

const STATES: Record<string, { state: string; items: object[] }> = {
  failed: { state: 'fail', items: [check(1, 'fail'), ...pass(4), ...skip(2)] },
  'no runner': { state: 'no_runner', items: [check(1, 'fail', { no_runner: true }), ...pass(4), ...skip(1)] },
  'failed and no runner': { state: 'fail', items: [check(1, 'fail'), check(2, 'fail', { no_runner: true }), ...pass(3)] },
  'running and queued': { state: 'pending', items: [running(1), queued(2), queued(3), ...pass(2), ...skip(1)] },
  green: { state: 'pass', items: [...pass(5), ...skip(2)] },
}

const pr = (checks: object) => ({ number: 941, url: 'https://github.com/a/b/pull/941', title: 'feat: one summary', state: 'open', draft: false,
  review: '', reviews: [], branch: 'feat/941', base: 'main', mergeable: true, head_sha: 'h1', checks })
const STATS = { connected: true, repo: 'a/b', fetched_at: now, read_at: now,
  prs: [{ number: 941, url: 'https://github.com/a/b/pull/941', title: 'feat: one summary', state: 'open', created_at: now - 3_600_000 }],
  board: { cards: [{ number: 941, stage: 'open', stage_at: now - 600_000, spend: { cost_usd: 0, sessions: 0, live: 0, agents: [] } }],
    releases: [], flow: { counts: {}, days: 14, merged: 0, ttm_count: 0, release_lag_count: 0, cost_usd: 0 }, ships_by: 'release' } }

function serve(checks: object) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (url.endsWith('/ci/stats')) return json(STATS)
    if (url.endsWith('/prs')) return json({ connected: true, prs: [{ session_id: 's1', number: 941, url: 'https://github.com/a/b/pull/941', title: 'feat', last_at: now, live: pr(checks) }] })
    if (url === '/v1/github') return json({ connected: false, scopes: [], scopes_known: false, sources: { gh: false, stored: false, store: 'file', oauth: false }, health: {}, notify: true, tracked: 0 })
    return json({ connected: true, fetched_at: now, read_at: now, prs: [] })
  }))
}

/** Each state's count as drawn inside root: {fail: 1, pass: 4, …}. */
function counts(root: Element): Record<string, number> {
  const out: Record<string, number> = {}
  for (const part of root.querySelectorAll('[data-check-part]')) {
    const tone = part.getAttribute('data-check-part')!
    const n = /(\d+)/.exec(part.textContent ?? '')
    out[tone] = n ? Number(n[1]) : 0
  }
  return out
}

const session = { session_id: 's1', owned: true, status: 'active', title: 'Agent', cwd: '/w', repo_root: '/w' }

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'], now }) })
afterEach(() => { cleanup(); forgetDeckAnswers(); forgetPRProgress(); localStorage.clear(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('folded and unfolded CI say the same', () => {
  for (const [name, c] of Object.entries(STATES)) {
    it(`${name}: the same PR and the same counts per state`, async () => {
      serve(c)
      const f = render(
        <FoldCtx.Provider value={{ full: false, toggle: () => {} }}>
          <CockpitCI sessionId="s1" s={session as never} repoScope="/w" onOpen={() => {}} />
        </FoldCtx.Provider>,
      )
      // The widest wording (jsdom lays nothing out, so FitSummary keeps it).
      const line = await waitFor(() => {
        const l = document.querySelector('[data-cockpit-ci-fold] [data-fit-variant="0"]')
        if (!l) throw new Error('no folded line')
        return l
      })
      const foldPR = document.querySelector('[data-cockpit-ci-fold-pr]')!.getAttribute('data-cockpit-ci-fold-pr')
      const folded = counts(line)
      f.unmount()
      forgetDeckAnswers()

      serve(c)
      render(<CockpitCI sessionId="s1" s={session as never} repoScope="/w" onOpen={() => {}} />)
      const row = await waitFor(() => {
        const r = document.querySelector('[data-cockpit-ci-row-checks]')
        if (!r) throw new Error('no row checks')
        return r
      })
      expect(row.getAttribute('data-cockpit-ci-row-checks')).toBe(foldPR)
      expect(foldPR).toBe('941')
      expect(counts(row)).toEqual(folded)
      expect(Object.keys(folded).length).toBeGreaterThan(0)
    })
  }

  it('counts both a real failure and a job given no machine, apart', async () => {
    serve(STATES['failed and no runner']!)
    render(
      <FoldCtx.Provider value={{ full: false, toggle: () => {} }}>
        <CockpitCI sessionId="s1" s={session as never} repoScope="/w" onOpen={() => {}} />
      </FoldCtx.Provider>,
    )
    const line = await waitFor(() => {
      const l = document.querySelector('[data-cockpit-ci-fold] [data-fit-variant="0"]')
      if (!l) throw new Error('no folded line')
      return l
    })
    expect(counts(line)).toMatchObject({ fail: 1, norunner: 1, pass: 3 })
    // A real failure calls for Fix CI, not Rerun.
    expect(document.querySelector('[data-cockpit-ci-fold-action]')).toHaveAttribute('data-cockpit-ci-fold-action', 'ci')
  })
})
