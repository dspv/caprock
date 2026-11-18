/**
 * Rerun jobs GitHub never ran (owner, 2026-11-18): an opt-in switch, in
 * Settings → GitHub and beside each Rerun of a job GitHub never gave a
 * machine, that lets the daemon re-run such a run once by itself; the run
 * then says "re-run by Caprock".
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CockpitCI } from './CockpitCI'
import { FoldCtx } from './Cockpit'
import { GitHubSettings } from './GitHubSettings'
import { forgetDeckAnswers } from '@/lib/deckCache'
import { forgetPRProgress } from '@/lib/usePRForce'
import { autoRerunWords } from '@/lib/ci'
import type { AutoRerun, GitHubStatus } from '@/lib/github'

const now = Date.now()
const live = (n: number, checks: object) => ({ number: n, url: `https://github.com/a/b/pull/${n}`, title: `PR ${n}`, state: 'open', draft: false,
  review: '', reviews: [], branch: `feat/${n}`, base: 'main', mergeable: true, head_sha: 'h1', checks })
const row = (n: number, l: object) => ({ session_id: 's1', number: n, url: `https://github.com/a/b/pull/${n}`, title: `PR ${n}`, last_at: now, live: l })
const job = (job: number, name: string, state: string, extra: object = {}) => ({ name, state, status: 'completed', job_id: job,
  url: `https://github.com/a/b/actions/runs/7/job/${job}`, started_at: now - 900_000, completed_at: now - 10_000, ...extra })
const IDLE = { state: 'no_runner', passed: 2, failed: 0, pending: 0, no_runner: 1, items: [
  job(71, 'go (macos-latest)', 'fail', { no_runner: true }), job(80, 'lint', 'pass'), job(81, 'test', 'pass'),
] }
const DONE: AutoRerun = { attempt: 1, at: now - 60_000, jobs: 1 }
const RERUN = { state: 'pending', passed: 2, failed: 0, pending: 1, items: [
  { ...job(72, 'go (macos-latest)', 'pending'), status: 'queued', completed_at: undefined }, job(80, 'lint', 'pass'), job(81, 'test', 'pass'),
], auto_rerun: DONE }

const STATUS: GitHubStatus = {
  connected: true, source: 'gh', user: { login: 'ada' }, scopes: ['repo'], scopes_known: true,
  sources: { gh: true, stored: false, store: 'keychain', oauth: false }, health: {}, notify: true, auto_rerun: false, tracked: 1,
}

let patches: unknown[] = []
let status: GitHubStatus = STATUS
let prs: object[] = []

function stub() {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (url === '/v1/github' && init?.method === 'PATCH') {
      const b = JSON.parse(init.body as string) as { auto_rerun?: boolean }
      patches.push(b)
      status = { ...status, auto_rerun: !!b.auto_rerun }
      return json(status)
    }
    if (url === '/v1/github') return json(status)
    if (url.endsWith('/prs')) return json({ connected: true, prs })
    if (url.includes('/github/prs')) return json({ prs: [] })
    return json({ connected: true, fetched_at: now, read_at: now, prs: [] })
  }))
}

beforeEach(() => { patches = []; status = STATUS; prs = []; vi.useFakeTimers({ toFake: ['Date'], now }); stub() })
afterEach(() => { cleanup(); forgetDeckAnswers(); forgetPRProgress(); localStorage.clear(); vi.unstubAllGlobals(); vi.useRealTimers() })

const session = { session_id: 's1', owned: true, status: 'active', title: 'Agent', cwd: '/w', repo_root: '/w' }
const folded = () => render(
  <FoldCtx.Provider value={{ full: false, toggle: () => {} }}>
    <CockpitCI sessionId="s1" s={session as never} repoScope="/w" onOpen={() => {}} />
  </FoldCtx.Provider>,
)

describe('Rerun jobs GitHub never ran', () => {
  it('words Caprock’s re-run: done, starved again, refused', () => {
    expect(autoRerunWords(undefined)).toBeUndefined()
    expect(autoRerunWords(DONE)).toMatchObject({ text: 're-run by Caprock', tone: 'muted' })
    expect(autoRerunWords(DONE)!.title).toContain('once per run')
    expect(autoRerunWords({ ...DONE, again: true })).toMatchObject({ text: 're-run by Caprock once', tone: 'norunner' })
    expect(autoRerunWords({ ...DONE, again: true })!.title).toContain('Rerun it yourself')
    const e = autoRerunWords({ ...DONE, error: 'The token lacks a scope' })!
    expect(e).toMatchObject({ text: 'Caprock could not re-run', tone: 'danger' })
    expect(e.title).toContain('The token lacks a scope')
  })

  it('Settings → GitHub: off by default, says what it sends, and saves', async () => {
    render(<GitHubSettings />)
    const box = await screen.findByRole('checkbox', { name: /Rerun jobs GitHub never ran/ })
    expect(box).not.toBeChecked()
    const hint = document.querySelector('[data-auto-rerun-hint]')!
    expect(hint.textContent).toContain('api.github.com with your GitHub token')
    expect(hint.textContent).toContain('once per run')
    expect(hint.textContent).toContain('release runs included')
    await act(async () => { fireEvent.click(box) })
    expect(patches).toEqual([{ auto_rerun: true }])
    await waitFor(() => expect(box).toBeChecked())
  })

  it('an older daemon without it shows no switch', async () => {
    status = { ...STATUS, auto_rerun: undefined }
    render(<GitHubSettings />)
    await screen.findByText(/Tell me when CI fails/)
    expect(screen.queryByRole('checkbox', { name: /Rerun jobs GitHub never ran/ })).toBeNull()
  })

  it('folded, offers the same switch beside Rerun, worded short, with the whole of it on hover', async () => {
    prs = [row(941, live(941, IDLE))]
    folded()
    const sw = await waitFor(() => {
      const s = document.querySelector('[data-cockpit-ci-fold] [data-auto-rerun-switch="short"]')
      if (!s) throw new Error('no switch')
      return s
    })
    // The words, or under 400 px of line only ↻ (a container query jsdom does not apply).
    expect(sw).toHaveTextContent('Always rerun these')
    expect(sw).toHaveTextContent('↻')
    expect(sw.getAttribute('title')).toContain('once per run')
    expect(sw.getAttribute('title')).toContain('your GitHub token')
    expect(document.querySelector('[data-cockpit-ci-fold] [data-cockpit-ci-fold-rerun]')).not.toBeNull()
    const box = sw.querySelector('input')!
    expect(box).not.toBeChecked()
    await act(async () => { fireEvent.click(box) })
    expect(patches).toEqual([{ auto_rerun: true }])
    await waitFor(() => expect(box).toBeChecked())
  })

  it('folded, a run Caprock re-ran says "re-run by Caprock" in place of the switch', async () => {
    prs = [row(941, live(941, RERUN))]
    folded()
    const w = await waitFor(() => {
      const s = document.querySelector('[data-cockpit-ci-fold] [data-auto-rerun]')
      if (!s) throw new Error('no word')
      return s
    })
    expect(w).toHaveTextContent('re-run by Caprock')
    expect(w).toHaveAttribute('data-auto-rerun', 'done')
    expect(document.querySelector('[data-cockpit-ci-fold] [data-auto-rerun-switch]')).toBeNull()
  })

  it('unfolded, its row says so, and a run starved again keeps Re-run beside "re-run by Caprock once"', async () => {
    const stats = { connected: true, repo: 'a/b', fetched_at: now, read_at: now,
      prs: [{ number: 941, url: 'https://github.com/a/b/pull/941', title: 'docs: answer first', state: 'open', created_at: now - 3_600_000 }],
      board: { cards: [{ number: 941, stage: 'open', ci: 'no_runner', stage_at: now - 600_000, spend: { cost_usd: 0, sessions: 0, live: 0, agents: [] } }],
        releases: [], flow: { counts: {}, days: 14, merged: 0, ttm_count: 0, release_lag_count: 0, cost_usd: 0 }, ships_by: 'release' } }
    prs = [row(941, live(941, { ...IDLE, auto_rerun: { ...DONE, again: true } }))]
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url.endsWith('/ci/stats')) return json(stats)
      if (url.endsWith('/prs')) return json({ connected: true, prs })
      if (url === '/v1/github') return json(status)
      return new Response('', { status: 404 })
    }))
    render(<CockpitCI sessionId="s1" s={session as never} repoScope="/w" onOpen={() => {}} />)
    const w = await waitFor(() => {
      const n = document.querySelector('[data-cockpit-ci-pr="941"] [data-auto-rerun]')
      if (!n) throw new Error('no word')
      return n
    })
    expect(w).toHaveTextContent('re-run by Caprock once')
    expect(w).toHaveAttribute('data-auto-rerun', 'again')
    expect(document.querySelector('[data-cockpit-ci-pr="941"] [data-cockpit-ci-action]')).toHaveAttribute('data-cockpit-ci-action', 'rerun')
  })

  it('unfolded, a row with a job given no machine carries the switch, worded in full', async () => {
    const stats = { connected: true, repo: 'a/b', fetched_at: now, read_at: now,
      prs: [{ number: 941, url: 'https://github.com/a/b/pull/941', title: 'docs: answer first', state: 'open', created_at: now - 3_600_000 }],
      board: { cards: [{ number: 941, stage: 'open', ci: 'no_runner', stage_at: now - 600_000, spend: { cost_usd: 0, sessions: 0, live: 0, agents: [] } }],
        releases: [], flow: { counts: {}, days: 14, merged: 0, ttm_count: 0, release_lag_count: 0, cost_usd: 0 }, ships_by: 'release' } }
    prs = [row(941, live(941, IDLE))]
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url.endsWith('/ci/stats')) return json(stats)
      if (url.endsWith('/prs')) return json({ connected: true, prs })
      if (url === '/v1/github') return json(status)
      return new Response('', { status: 404 })
    }))
    render(<CockpitCI sessionId="s1" s={session as never} repoScope="/w" onOpen={() => {}} />)
    const sw = await waitFor(() => {
      const n = document.querySelector('[data-cockpit-ci-pr="941"] [data-auto-rerun-switch="full"]')
      if (!n) throw new Error('no switch')
      return n
    })
    expect(sw).toHaveTextContent('Always rerun these')
  })
})
