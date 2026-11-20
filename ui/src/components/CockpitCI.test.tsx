import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CockpitCI, checkSummary } from './CockpitCI'
import { forgetDeckAnswers, writeDeck } from '@/lib/deckCache'
import { prChecks } from '@/lib/ci'
import { CheckSummary } from './CheckSummary'
import { forgetPRProgress } from '@/lib/usePRForce'
import { FoldCtx } from './Cockpit'

const now = Date.now()
const live = (n: number, checks: object, p: object = {}) => ({ number: n, url: `https://github.com/a/b/pull/${n}`, title: `PR ${n}`, state: 'open', draft: false,
  review: '', reviews: [], branch: `feat/${n}`, base: 'main', mergeable: null, checks, ...p })
const row = (n: number, l: object) => ({ session_id: 's1', number: n, url: `https://github.com/a/b/pull/${n}`, title: `PR ${n}`, last_at: now, live: l })
const RUNNING = { state: 'pending', passed: 2, failed: 0, pending: 1, items: [
  { name: 'lint', state: 'pass', started_at: now - 240_000, completed_at: now - 200_000 },
  { name: 'go (ubuntu-latest)', state: 'pass', started_at: now - 240_000, completed_at: now - 60_000 },
  { name: 'go (windows-latest)', state: 'pending', status: 'in_progress', started_at: now - 240_000 },
] }
const PASSED = { state: 'pass', passed: 1, failed: 0, pending: 0, items: [{ name: 'lint', state: 'pass' }] }

// The clock stands at `now` in every test. The block reads Date.now() as it
// draws, and the fixtures were stamped when this file loaded: on a busy runner
// the first test here started more than a second later, so "4m 00s" read
// "4m 01s". Only Date is faked; timers stay real.
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'], now }) })
afterEach(() => { forgetDeckAnswers(); forgetPRProgress(); localStorage.clear(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('the cockpit’s CI block', () => {
  it('counts a PR’s checks and the time since the first started', () => {
    expect(checkSummary(RUNNING.items as never, now)).toMatchObject({ total: 3, pass: 2, running: 1, ms: 240_000 })
  })

  // Owner, 2026-10-14, translated: "showing PRs as progress bars toward
  // release; scrollable; we see PR statuses and CI statuses".
  it('draws the repository’s pull requests as progress bars toward a release, the CI colour on its step', async () => {
    const stats = {
      connected: true, repo: 'a/b', fetched_at: now, read_at: now,
      prs: [
        { number: 9, url: 'https://github.com/a/b/pull/9', title: 'Fix the login', state: 'open', created_at: now - 3_600_000, labels: [{ name: 'landing: queued' }] },
        { number: 8, url: 'https://github.com/a/b/pull/8', title: 'Release notes', state: 'merged', created_at: now - 7_200_000, merged_at: now - 3_000_000 },
        { number: 7, url: 'https://github.com/a/b/pull/7', title: 'Old one', state: 'merged', created_at: now - 9_000_000, merged_at: now - 8_000_000 },
        { number: 6, url: 'https://github.com/a/b/pull/6', title: 'Dropped', state: 'closed', created_at: now - 9_500_000 },
      ],
      board: {
        cards: [
          { number: 9, stage: 'fix', ci: 'fail', why: 'ci', stage_at: now - 600_000, spend: { cost_usd: 0, sessions: 0, live: 0, agents: [] } },
          { number: 8, stage: 'merged', stage_at: now - 3_000_000, spend: { cost_usd: 0, sessions: 0, live: 0, agents: [] } },
          { number: 7, stage: 'released', release: 'v1.2.0', stage_at: now - 4_000_000, spend: { cost_usd: 0, sessions: 0, live: 0, agents: [] } },
        ],
        releases: [{ tag: 'v1.2.0', published_at: now - 4_000_000, prs: [7], cost_usd: 0, sessions: 0 }],
        flow: { counts: {}, days: 14, merged: 2, ttm_count: 0, release_lag_count: 0, cost_usd: 0 },
        ships_by: 'release',
      },
    }
    const fetch = vi.fn(async () => new Response(JSON.stringify(stats), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetch)
    const onOpen = vi.fn()
    render(<CockpitCI sessionId="s1" repoScope="/w" onOpen={onOpen} />)
    await waitFor(() => expect(document.querySelector('[data-cockpit-ci-pr="9"]')).not.toBeNull())
    expect(fetch).toHaveBeenCalledWith('/v1/sessions/s1/ci/stats', expect.anything())
    // Owner, 2026-10-16, translated: "on the right it sometimes shows too
    // many PRs". Only what is in flight: open first, then merged since the
    // last release; #7 shipped in v1.2.0 and #6 closed unmerged.
    expect([...document.querySelectorAll('[data-cockpit-ci-pr]')].map((e) => e.getAttribute('data-cockpit-ci-pr'))).toEqual(['9', '8'])
    expect(document.querySelector('[data-cockpit-ci-quiet]')).toBeNull()
    const ci = document.querySelector('[data-cockpit-ci-pr="9"] [data-journey-seg="ci"]')!
    expect(ci).toHaveAttribute('data-step-state', 'current')
    expect(ci).toHaveClass('bg-danger')
    expect(document.querySelector('[data-cockpit-ci-pr="9"]')).toHaveTextContent('Fix the login')
    expect(document.querySelector('[data-cockpit-ci-pr="8"] [data-journey-seg="merged"]')).toHaveAttribute('data-step-state', 'current')
    // Owner, 2026-10-15, translated: "it's not clear what the stages are".
    // One legend over the bars' columns, and every segment says its step and
    // state, the landing label on the step it is on; the rows do not grow.
    const legend = document.querySelector('[data-journey-legend]')!
    // Owner, 2026-10-20, translated: the final status should be merged —
    // the bar ends there, and a merge fills it; its release is a quiet word.
    expect([...legend.children].map((e) => e.textContent)).toEqual(['open', 'CI', 'merged'])
    expect(legend).toHaveClass('gap-[3px]')
    expect(legend).toHaveStyle({ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' })
    expect(document.querySelector('[data-cockpit-ci-pr="8"] [data-journey-seg="released"]')).toBeNull()
    expect(document.querySelector('[data-cockpit-ci-pr="8"] [data-journey-bar]')).toHaveAttribute('data-journey-full')
    expect([...document.querySelectorAll('[data-cockpit-ci-pr="8"] [data-journey-seg]')].every((e) => e.classList.contains('bg-merged'))).toBe(true)
    expect(document.querySelector('[data-cockpit-ci-pr="9"] [data-journey-bar]')).not.toHaveAttribute('data-journey-full')
    const note = document.querySelector('[data-cockpit-ci-pr="8"] [data-release-note]')!
    expect(note).toHaveTextContent('not released')
    expect(note).toHaveAttribute('title', 'Merged, in no published release yet: it ships with the next release, after v1.2.0.')
    expect(legend.nextElementSibling).toBe(document.querySelector('[data-cockpit-journey]'))
    expect(ci).toHaveAttribute('title', 'CI: failed — CI red · landing: queued. A check on its head commit failed')
    expect(document.querySelector('[data-cockpit-ci-pr="9"] [data-journey-seg="open"]')).toHaveAttribute('title', 'Open: done. Opened')
    expect(document.querySelector('[data-cockpit-ci-pr="9"] [data-journey-seg="merged"]')).toHaveAttribute('title', 'Merged: waiting. Not merged yet')
    expect(document.querySelector('[data-cockpit-ci-pr="8"] [data-journey-seg="ci"]')!.getAttribute('title')).toMatch(/^CI: done\./)
    expect(document.querySelector('[data-cockpit-ci-pr="9"] [data-journey-seg="ci"]')).toHaveClass('h-[4px]')
    // It scrolls inside the block; Expand only past a few rows; the page one click away.
    expect(document.querySelector('[data-cockpit-journey]')).toHaveClass('overflow-y-auto', 'max-h-[176px]')
    expect(document.querySelector('[data-cockpit-ci-tall]')).toBeNull()
    // One link under the list (owner, 2026-11-20: "Log in Pipeline →" and
    // "Pipeline →" — "the difference is unclear, keep one"): with #9 failing
    // it opens the Pipeline on #9's log.
    expect(document.querySelectorAll('[data-cockpit-ci-open]')).toHaveLength(1)
    expect(document.querySelector('[data-cockpit-ci-log]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '#9 log in Pipeline →' }))
    expect(onOpen).toHaveBeenCalledWith(9)
  })

  it('grows taller on Expand, remembered', async () => {
    const prs = Array.from({ length: 6 }, (_, i) => ({ number: 20 + i, url: `https://github.com/a/b/pull/${20 + i}`, title: `PR ${20 + i}`, state: 'open', created_at: now - 1000 }))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ connected: true, prs, fetched_at: now }), { status: 200 })))
    const first = render(<CockpitCI sessionId="s1" onOpen={() => {}} />)
    await waitFor(() => expect(document.querySelector('[data-cockpit-ci-tall]')).not.toBeNull())
    fireEvent.click(document.querySelector('[data-cockpit-ci-tall]')!)
    expect(document.querySelector('[data-cockpit-journey]')).toHaveClass('max-h-[440px]')
    first.unmount()
    render(<CockpitCI sessionId="s1" onOpen={() => {}} />)
    await waitFor(() => expect(document.querySelector('[data-cockpit-journey]')).toHaveClass('max-h-[440px]'))
  })

  const SPEND = { cost_usd: 0, sessions: 0, live: 0, agents: [] }
  const FLOW = { counts: {}, days: 14, merged: 0, ttm_count: 0, release_lag_count: 0, cost_usd: 0 }
  const merged = (n: number, at: number, release?: string) => ({
    pr: { number: n, url: `https://github.com/a/b/pull/${n}`, title: `Merge ${n}`, state: 'merged', base: 'master', created_at: at - 60_000, merged_at: at },
    card: { number: n, stage: release ? 'released' : 'merged', release, stage_at: at, spend: SPEND },
  })
  const answer = (body: object) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  // Answers …/ci/stats with stats and …/ci?pr= with that PR's checks.
  const route = (stats: object, checks: Record<number, object> = {}) => vi.fn(async (url: string) => {
    const m = /\/ci\?pr=(\d+)$/.exec(url)
    if (m) return answer({ connected: true, fetched_at: now, pr: { number: Number(m[1]), url: '', repo: 'a/b', live: live(Number(m[1]), checks[Number(m[1])] ?? PASSED) } })
    return answer(stats)
  })

  // caprock-web's shape on 2026-10-16: every PR merged, no release ever published.
  it('says nothing is in flight in one line, over the three newest merges, where no release is published', async () => {
    const rows = [5, 4, 3, 2, 1].map((n) => merged(n, now - (6 - n) * 3_600_000))
    vi.stubGlobal('fetch', route({ connected: true, fetched_at: now, prs: rows.map((r) => r.pr), board: { cards: rows.map((r) => r.card), releases: [], flow: FLOW } }))
    render(<CockpitCI sessionId="s1" onOpen={() => {}} />)
    await waitFor(() => expect(document.querySelector('[data-cockpit-ci-quiet]')).not.toBeNull())
    expect(document.querySelector('[data-cockpit-ci-quiet]')).toHaveTextContent('Nothing in flight · no release published')
    expect([...document.querySelectorAll('[data-cockpit-ci-pr]')].map((e) => e.getAttribute('data-cockpit-ci-pr'))).toEqual(['5', '4', '3'])
    expect(document.querySelector('[data-cockpit-ci-tall]')).toBeNull()
    expect(screen.getByRole('button', { name: 'Pipeline →' })).toBeInTheDocument()
    // An older daemon says nothing of how it ships: the bar full, no word of a release, never a wait.
    expect(document.querySelector('[data-cockpit-ci-pr="5"] [data-journey-bar]')).toHaveAttribute('data-journey-full')
    expect(document.querySelector('[data-cockpit-ci-pr="5"] [data-release-note]')).toBeNull()
  })

  // Owner, 2026-10-18, translated: "why isn't merged the final state". A
  // site deployed on every merge (ships_by merge): three steps, merged the
  // last, the bar full, no released column, and the quiet line says why.
  it('ends at merged, the bar full, where the repository ships on merge', async () => {
    const rows = [12, 11, 10].map((n) => merged(n, now - (13 - n) * 86_400_000 * 28))
    vi.stubGlobal('fetch', route({ connected: true, fetched_at: now, prs: rows.map((r) => r.pr), board: { cards: rows.map((r) => r.card), releases: [], ships_by: 'merge', flow: FLOW } }))
    render(<CockpitCI sessionId="s1" onOpen={() => {}} />)
    await waitFor(() => expect(document.querySelector('[data-cockpit-ci-quiet]')).not.toBeNull())
    expect(document.querySelector('[data-cockpit-ci-quiet]')).toHaveTextContent('Nothing in flight · no releases here: work ships when it merges')
    const legend = document.querySelector('[data-journey-legend]')!
    expect([...legend.children].map((e) => e.textContent)).toEqual(['open', 'CI', 'merged'])
    const segs = [...document.querySelectorAll('[data-cockpit-ci-pr="12"] [data-journey-seg]')]
    expect(segs.map((e) => e.getAttribute('data-journey-seg'))).toEqual(['open', 'ci', 'merged'])
    expect(segs.map((e) => e.getAttribute('data-step-state'))).toEqual(['done', 'done', 'current'])
    expect(document.querySelector('[data-cockpit-ci-pr="12"] [data-journey-bar]')).toHaveStyle({ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' })
    expect(segs[2]!.getAttribute('title')).toContain('Merged: the last step')
    expect(document.querySelector('[data-release-note]')).toBeNull()
  })

  it('names the last release when everything shipped', async () => {
    const rows = [merged(3, now - 7_200_000, 'v1.4.0'), merged(2, now - 9_000_000, 'v1.4.0')]
    vi.stubGlobal('fetch', route({ connected: true, fetched_at: now, prs: rows.map((r) => r.pr),
      board: { cards: rows.map((r) => r.card), releases: [{ tag: 'v1.4.0', published_at: now - 3_600_000, prs: [3, 2], cost_usd: 0, sessions: 0 }], flow: FLOW } }))
    render(<CockpitCI sessionId="s1" onOpen={() => {}} />)
    await waitFor(() => expect(document.querySelector('[data-cockpit-ci-quiet]')).toHaveTextContent('Nothing in flight · last release v1.4.0, 1h ago'))
    expect(document.querySelector('[data-cockpit-ci-pr="3"] [data-journey-bar]')).toHaveAttribute('data-journey-full')
    expect(document.querySelector('[data-cockpit-ci-pr="3"] [data-release-note="released"]')).toHaveTextContent('in v1.4.0')
  })

  // Owner, 2026-10-16, translated: "in CI/CD on the right, the Ring mode is empty".
  it('draws Ring and By OS from the newest PR in flight when the deck read none, asking its checks itself', async () => {
    const stats = { connected: true, fetched_at: now, prs: [
      { number: 12, url: 'https://github.com/a/b/pull/12', title: 'New', state: 'open', created_at: now - 600_000 },
      { number: 11, url: 'https://github.com/a/b/pull/11', title: 'Older', state: 'open', created_at: now - 7_200_000 },
    ], board: { cards: [], releases: [], flow: FLOW } }
    const fetch = route(stats, { 12: RUNNING })
    vi.stubGlobal('fetch', fetch)
    localStorage.setItem('caprock.cockpit.ciView', 'ring')
    // The session's own PR has no checks yet: that is no ring to draw.
    writeDeck('prs:s1', { connected: true, prs: [row(9, live(9, { state: '', passed: 0, failed: 0, pending: 0, items: [] }))] })
    render(<CockpitCI sessionId="s1" onOpen={() => {}} />)
    await waitFor(() => expect(document.querySelector('[data-cockpit-ci-ring]')).not.toBeNull())
    expect(document.querySelector('[data-cockpit-ci-ring]')).toHaveTextContent('2/3 · 4m 00s')
    expect(document.querySelector('[data-cockpit-ci-ring]')).toHaveTextContent('#12')
    expect(fetch).toHaveBeenCalledWith('/v1/sessions/s1/ci?pr=12', expect.anything())
    fireEvent.click(document.querySelector('[data-cockpit-ci-view="grid"]')!)
    const byOS = document.querySelector('[data-cockpit-ci-os]')!
    expect(byOS.querySelector('[data-os="windows"]')).toHaveAttribute('data-tone', 'running')
  })

  it('says nothing is in flight in Ring and By OS rather than an empty box', async () => {
    const rows = [merged(3, now - 7_200_000, 'v1.4.0')]
    const fetch = route({ connected: true, fetched_at: now, prs: rows.map((r) => r.pr),
      board: { cards: rows.map((r) => r.card), releases: [{ tag: 'v1.4.0', published_at: now - 3_600_000, prs: [3], cost_usd: 0, sessions: 0 }], flow: FLOW } })
    vi.stubGlobal('fetch', fetch)
    localStorage.setItem('caprock.cockpit.ciView', 'ring')
    render(<CockpitCI sessionId="s1" onOpen={() => {}} />)
    await waitFor(() => expect(document.querySelector('[data-cockpit-ci-quiet]')).toHaveTextContent('Nothing in flight · last release v1.4.0, 1h ago'))
    fireEvent.click(document.querySelector('[data-cockpit-ci-view="grid"]')!)
    expect(document.querySelector('[data-cockpit-ci-quiet]')).toHaveTextContent('Nothing in flight')
    expect(fetch.mock.calls.some(([u]) => String(u).includes('?pr='))).toBe(false)
  })

  it('asks nothing with no page to open, and draws nothing with nothing to say', () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const { container } = render(<CockpitCI sessionId="s1" />)
    expect(container).toBeEmptyDOMElement()
    expect([...document.querySelectorAll('[data-cockpit-ci-view]')]).toHaveLength(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('switches between the PRs, a ring and the jobs by OS, kept per viewer, and opens the tab on a click', () => {
    writeDeck('prs:s1', { connected: true, prs: [row(9, live(9, RUNNING))] })
    const onOpen = vi.fn()
    const first = render(<CockpitCI sessionId="s1" onOpen={onOpen} />)
    fireEvent.click(document.querySelector('[data-cockpit-ci-view="ring"]')!)
    expect(document.querySelector('[data-cockpit-ci-ring]')).toHaveTextContent('2/3 · 4m 00s')
    expect(document.querySelector('[data-cockpit-ci-ring]')).toHaveTextContent('1 running')
    fireEvent.click(document.querySelector('[data-cockpit-ci-open]')!)
    expect(onOpen).toHaveBeenCalledTimes(1)
    fireEvent.click(document.querySelector('[data-cockpit-ci-view="grid"]')!)
    // No CI of #9 kept yet: the checks' own names say the OS.
    const byOS = document.querySelector('[data-cockpit-ci-os]')!
    expect(byOS.querySelector('[data-os="linux"]')).toHaveAttribute('data-tone', 'pass')
    expect(byOS.querySelector('[data-os="windows"]')).toHaveAttribute('data-tone', 'running')
    expect(byOS).toHaveTextContent(/^Linuxpassed 3m 00s1 checkWindowsrunning 4m 00s1 check$/)
    first.unmount()
    act(() => {
      writeDeck('ci:s1:9', { connected: true, pr: { number: 9, url: '', repo: 'a/b' }, ci: { repo: 'a/b', head_sha: 's', state: 'running', runner_ms: 0, by_os: [], at: now, runs: [{ id: 1, name: 'ci', status: 'in_progress', jobs: [
        { id: 1, run_id: 1, name: 'go (ubuntu-latest)', os: 'linux', labels: [], status: 'completed', conclusion: 'success', steps: [] },
        { id: 2, run_id: 1, name: 'go (windows-latest)', os: 'windows', labels: [], status: 'in_progress', steps: [] },
      ] }] } })
    })
    render(<CockpitCI sessionId="s1" onOpen={onOpen} />)
    expect(document.querySelector('[data-cockpit-ci="grid"]')).not.toBeNull()
    const grid = document.querySelector('[data-cockpit-ci-os]')!
    expect(grid).toHaveTextContent('Linux')
    expect(grid).toHaveTextContent('Windows')
    expect(grid.querySelector('[data-tone="running"]')).not.toBeNull()
  })

  it('names no OS it cannot read', () => {
    writeDeck('prs:s1', { connected: true, prs: [row(9, live(9, PASSED))] })
    localStorage.setItem('caprock.cockpit.ciView', 'grid')
    render(<CockpitCI sessionId="s1" />)
    expect(screen.getByText('#9’s checks name no runner OS.')).toBeInTheDocument()
  })

  // "You can't move the mouse here — on hover a modal opens and you can't
  // see anything" (owner, 2026-10-14, translated): the folded block's line.
  it('lists a PR’s checks only after the pointer rests, beside the panel, and closes on leaving', () => {
    vi.useFakeTimers()
    try {
      const sumOf = prChecks(row(9, live(9, RUNNING)) as never, now)!
      render(<CheckSummary s={sumOf} label="#9: its checks" focusable={false} beside />)
      const sum = document.querySelector('[data-check-summary]')!
      fireEvent.mouseEnter(sum)
      act(() => { vi.advanceTimersByTime(300) })
      // Passing over opens nothing.
      fireEvent.mouseLeave(sum)
      act(() => { vi.advanceTimersByTime(1000) })
      expect(document.querySelector('[data-check-list]')).toBeNull()
      fireEvent.mouseEnter(sum)
      act(() => { vi.advanceTimersByTime(650) })
      const list = document.querySelector('[data-check-list]') as HTMLElement
      expect(list).toHaveAttribute('data-beside')
      expect(list.style.pointerEvents).toBe('none')
      fireEvent.mouseLeave(sum)
      expect(document.querySelector('[data-check-list]')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  // Owner, 2026-10-20: the session deck is gone; its per-PR actions are on
  // the inspector's PR rows, one at a time, asking first as the deck did.
  it('offers the one action a session PR needs in its row, asks once, does it, and opens its log in the Pipeline', async () => {
    const stats = {
      connected: true, repo: 'a/b', fetched_at: now, read_at: now,
      prs: [{ number: 9, url: 'https://github.com/a/b/pull/9', title: 'Fix the login', state: 'open', created_at: now - 3_600_000 }],
      board: {
        cards: [{ number: 9, stage: 'fix', ci: 'fail', why: 'ci', stage_at: now - 600_000, spend: { cost_usd: 1.25, sessions: 2, live: 0, agents: ['claude'] } }],
        releases: [], flow: { counts: {}, days: 14, merged: 0, ttm_count: 0, release_lag_count: 0, cost_usd: 1.25 }, ships_by: 'release',
      },
    }
    const FAILED = { state: 'fail', passed: 1, failed: 1, pending: 0, items: [{ name: 'lint', state: 'pass' }, { name: 'go', state: 'fail' }] }
    const prs = { connected: true, prs: [row(9, live(9, FAILED, { title: 'Fix the login', mergeable: true, merge_state: 'clean' }))] }
    const posts: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (init?.method === 'POST') { posts.push(url); return json({ sent: false, queued: 1 }) }
      if (url.endsWith('/ci/stats')) return json(stats)
      if (url.endsWith('/prs')) return json(prs)
      return new Response('', { status: 404 })
    }))
    const onOpen = vi.fn()
    const s = { session_id: 's1', owned: true, status: 'active', title: 'Login agent', cwd: '/w', repo_root: '/w' }
    render(<CockpitCI sessionId="s1" s={s as never} repoScope="/w" onOpen={onOpen} />)
    const act1 = await waitFor(() => {
      const b = document.querySelector<HTMLButtonElement>('[data-cockpit-ci-pr="9"] [data-cockpit-ci-action]')
      if (!b) throw new Error('no action')
      return b
    })
    expect(act1).toHaveAttribute('data-cockpit-ci-action', 'ci')
    expect(act1).toHaveTextContent('Fix CI')
    expect(document.querySelectorAll('[data-cockpit-ci-pr="9"] [data-cockpit-ci-action]')).toHaveLength(1)
    // Its agent cost and who worked on it, in a grey line.
    expect(document.querySelector('[data-cockpit-ci-pr="9"] [data-cockpit-ci-cost]')).toHaveTextContent('$1.25')
    expect(document.querySelector('[data-cockpit-ci-pr="9"] [data-cockpit-ci-agent]')).toHaveTextContent('claude')
    // The log is the Pipeline's, on that PR: the one link under the list.
    expect(document.querySelector('[data-cockpit-ci-pr="9"] [data-cockpit-ci-log]')).toBeNull()
    fireEvent.click(document.querySelector('[data-cockpit-ci-open="9"]')!)
    expect(onOpen).toHaveBeenCalledWith(9)
    fireEvent.click(act1)
    // One line at 330px (owner, 2026-11-20, translated: "Ask caprock to fix
    // #977's CI and push?" wrapped — "something like Ask to fix #977 CI?"):
    // a few words, never wrapping, the whole sentence on hover.
    const confirm = document.querySelector('[data-cockpit-ci-confirm]')!
    expect(confirm).toHaveClass('flex-nowrap', 'whitespace-nowrap')
    expect(confirm).toHaveTextContent(/^Ask to fix #9 CI\?ConfirmCancel$/)
    const q = confirm.querySelector('[data-cockpit-ci-confirm-text]')!
    expect(q).toHaveClass('truncate')
    expect(q).toHaveAttribute('title', 'Ask Login agent to fix #9’s CI and push?')
    expect(posts).toEqual([])
    await act(async () => { fireEvent.click(document.querySelector('[data-cockpit-ci-confirm-yes]')!) })
    await waitFor(() => expect(posts).toEqual(['/v1/agents/s1/queue']))
    await waitFor(() => expect(document.querySelector('[data-cockpit-ci-pr="9"] [data-cockpit-ci-progress]')).toHaveTextContent('agent fixing…'))
  })

  it('offers no action without the session, and none on a PR that needs none', async () => {
    const stats = { connected: true, repo: 'a/b', fetched_at: now, read_at: now,
      prs: [{ number: 9, url: 'https://github.com/a/b/pull/9', title: 'Fine', state: 'open', created_at: now - 3_600_000 }],
      board: { cards: [], releases: [], flow: { counts: {}, days: 14, merged: 0, ttm_count: 0, release_lag_count: 0, cost_usd: 0 }, ships_by: 'release' } }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url.endsWith('/ci/stats')) return json(stats)
      if (url.endsWith('/prs')) return json({ connected: true, prs: [row(9, live(9, PASSED, { mergeable: true }))] })
      return new Response('', { status: 404 })
    }))
    render(<CockpitCI sessionId="s1" s={{ session_id: 's1', owned: true, status: 'active' } as never} repoScope="/w" onOpen={vi.fn()} />)
    await waitFor(() => expect(document.querySelector('[data-cockpit-ci-pr="9"]')).not.toBeNull())
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(document.querySelector('[data-cockpit-ci-action]')).toBeNull()
    expect(document.querySelector('[data-cockpit-ci-log]')).toBeNull()
    // Nothing failing: the one link is the Pipeline itself.
    expect(document.querySelector('[data-cockpit-ci-open]')).toHaveTextContent(/^Pipeline →$/)
  })

  // Owner, 2026-10-23: folded, the line read "1 min ago #801 ● 4 running ✓ 8
  // · 11h" while #801 had merged 11 hours before and #806 was the newest, every
  // check passed. The line came from the copy kept when the block was last
  // unfolded, never read again while folded, and the time beside it was
  // another answer's.
  it('folded, draws its line from a fresh read of the session’s PRs, never the old copy’s running checks', async () => {
    const then = now - 11 * 3_600_000
    const STALE = { state: 'pending', passed: 2, failed: 0, pending: 1, items: [
      { name: 'lint', state: 'pass', started_at: then - 240_000, completed_at: then - 200_000 },
      { name: 'go (ubuntu-latest)', state: 'pass', started_at: then - 240_000, completed_at: then - 60_000 },
      { name: 'go (windows-latest)', state: 'pending', status: 'in_progress', started_at: then - 240_000 },
    ] }
    writeDeck('prs:s1', { connected: true, prs: [row(801, live(801, STALE))] }, then)
    writeDeck('stats:s1', { connected: true, fetched_at: now - 60_000, read_at: now - 60_000, prs: [
      { number: 801, url: 'https://github.com/a/b/pull/801', title: 'PR 801', state: 'open', created_at: then },
    ] }, now - 60_000)
    let answer!: (r: Response) => void
    const asked: string[] = []
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      asked.push(url)
      if (url.endsWith('/prs')) return new Promise<Response>((r) => { answer = r })
      return Promise.resolve(new Response('', { status: 404 }))
    }))
    render(
      <FoldCtx.Provider value={{ full: false, toggle: () => {} }}>
        <CockpitCI sessionId="s1" onOpen={() => {}} />
      </FoldCtx.Provider>,
    )
    // Folded, the session's PRs and the Pipeline answer are asked; the kept
    // Pipeline copy's open #801 is not read again (that answer failed), so no
    // pull request's checks are asked from it.
    await waitFor(() => expect([...asked].sort()).toEqual(['/v1/sessions/s1/ci/stats', '/v1/sessions/s1/prs']))
    expect(asked.some((u) => u.includes('?pr='))).toBe(false)
    // Until that read lands there is no line, and no time from another answer.
    expect(document.querySelector('[data-cockpit-ci-fold]')).toBeNull()
    // The label row is the folded block's one line; the rest is hidden by CSS.
    const head = () => document.querySelector('section[aria-label="CI"] [data-section-head]')!
    expect(head()).not.toHaveTextContent(/running|ago|#801/)
    const merged = live(806, PASSED, { state: 'merged' })
    await act(async () => {
      answer(new Response(JSON.stringify({ connected: true, prs: [row(806, merged), row(801, live(801, PASSED, { state: 'merged' }))] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    })
    await waitFor(() => expect(document.querySelector('[data-cockpit-ci-fold]')).toHaveAttribute('data-cockpit-ci-fold', '806'))
    expect(head()).not.toHaveTextContent(/running|#801/)
    // Two lines: the PR and its age, then its checks.
    expect(head()).toHaveTextContent(/^CI#806.*now/)
    // Merged, the line says so instead of a tally of old checks.
    expect(document.querySelector('[data-cockpit-ci-fold]')).toHaveTextContent(/^Merged$/)
  })

  // Owner, 2026-11-17, translated: "in this mode I don't see CI statuses,
  // that's very strange". Folded, the line read "#930 merged" — the session's
  // own newest PR — while the release PR #931, opened by a script, ran CI.
  describe('folded, when the session’s own PR is not open', () => {
    const json = (body: object) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    const STATS = { connected: true, fetched_at: now, read_at: now, prs: [
      { number: 931, url: 'https://github.com/a/b/pull/931', title: 'chore(release): 0.182.0', state: 'open', created_at: now - 300_000 },
      { number: 930, url: 'https://github.com/a/b/pull/930', title: 'feat(cursor): more', state: 'merged', created_at: now - 7_200_000, merged_at: now - 600_000 },
    ], board: { cards: [], releases: [], flow: { counts: {}, days: 14, merged: 1, ttm_count: 0, release_lag_count: 0, cost_usd: 0 } } }
    const serve = (own: object[], checks: Record<number, object>, asked: string[]) => vi.fn(async (url: string) => {
      asked.push(url)
      if (url.endsWith('/prs')) return json({ connected: true, prs: own })
      const m = /\/ci\?pr=(\d+)$/.exec(url)
      if (m) { const n = Number(m[1]); return json({ connected: true, fetched_at: now, pr: { number: n, url: '', repo: 'a/b', live: live(n, checks[n] ?? PASSED) } }) }
      return json(STATS)
    })
    const folded = () => render(
      <FoldCtx.Provider value={{ full: false, toggle: () => {} }}>
        <CockpitCI sessionId="s1" onOpen={() => {}} />
      </FoldCtx.Provider>,
    )
    const fold = () => document.querySelector('[data-cockpit-ci-fold]')

    it('draws the repository’s open PR’s checks in place of "merged"', async () => {
      const asked: string[] = []
      vi.stubGlobal('fetch', serve([row(930, live(930, PASSED, { state: 'merged' }))], { 931: RUNNING }, asked))
      folded()
      await waitFor(() => expect(fold()).toHaveAttribute('data-cockpit-ci-fold', '931'))
      expect(fold()).toHaveAttribute('data-cockpit-ci-fold-of', 'repo')
      expect(fold()).not.toHaveTextContent('merged')
      // Its checks, as an own open PR's are: one running, two passed.
      expect(fold()!.querySelector('[data-check-summary]')).toHaveAttribute('data-check-summary', 'running')
      expect(fold()!.querySelector('[data-check-summary]')!.getAttribute('aria-label')).toMatch(/^#931, the repository’s open pull request: its checks: /)
      expect(document.querySelector('[data-cockpit-ci-fold-pr="931"][title^="#931: the repository’s open pull request"]')).not.toBeNull()
      expect(asked).toContain('/v1/sessions/s1/ci?pr=931')
      const time = document.querySelector('section[aria-label="CI"] [data-section-head] [title^="When GitHub was last read"]')!
      expect(time).toHaveAttribute('title', 'When GitHub was last read for #931’s checks, the repository’s open pull request')
    })

    it('keeps the session’s own open PR with checks over the repository’s', async () => {
      const asked: string[] = []
      vi.stubGlobal('fetch', serve([row(929, live(929, PASSED))], { 931: RUNNING }, asked))
      folded()
      await waitFor(() => expect(fold()).toHaveAttribute('data-cockpit-ci-fold', '929'))
      expect(fold()).toHaveAttribute('data-cockpit-ci-fold-of', 'session')
      // Nothing more is asked for a line it does not draw.
      await waitFor(() => expect(asked).toContain('/v1/sessions/s1/ci/stats'))
      expect(asked.some((u) => u.includes('?pr='))).toBe(false)
    })

    it('says "#N merged" when the repository has no open PR either', async () => {
      const asked: string[] = []
      const fetch = serve([row(930, live(930, PASSED, { state: 'merged' }))], {}, asked)
      vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.endsWith('/ci/stats') ? (asked.push(url), json({ ...STATS, prs: STATS.prs.slice(1) })) : fetch(url))))
      folded()
      await waitFor(() => expect(fold()).toHaveAttribute('data-cockpit-ci-fold', '930'))
      await waitFor(() => expect(asked).toContain('/v1/sessions/s1/ci/stats'))
      expect(fold()).toHaveTextContent(/^Merged$/)
      expect(document.querySelector('[data-cockpit-ci-fold-pr]')).toHaveAttribute('data-cockpit-ci-fold-pr', '930')
      expect(asked.some((u) => u.includes('?pr='))).toBe(false)
    })
  })

  // Owner, 2026-11-20, translated: a grey "merged" under the title was
  // "cramped and visually unclear". Variant A: a green check, *Merged*, and
  // what comes next in muted words — the version as the Release section
  // writes it, without a "v".
  describe('folded, a merged PR says what comes next', () => {
    const SPEND = { cost_usd: 0, sessions: 0, live: 0, agents: [] }
    const FLOW = { counts: {}, days: 14, merged: 1, ttm_count: 0, release_lag_count: 0, cost_usd: 0 }
    const merged = { number: 970, url: 'https://github.com/a/b/pull/970', title: 'PR 970', state: 'merged', created_at: now - 7_200_000, merged_at: now - 600_000 }
    const keep = (o: { ships?: string; card?: object; releases?: object[]; state?: string; repo?: object }) => {
      writeDeck('stats:/w', { connected: true, fetched_at: now, read_at: now, prs: [{ ...merged, state: o.state ?? 'merged' }],
        board: { cards: o.card ? [o.card] : [], releases: o.releases ?? [{ tag: 'v0.185.0', published_at: now - 3_600_000, prs: [], cost_usd: 0, sessions: 0 }], flow: FLOW, ships_by: o.ships } }, now)
      writeDeck('prs:s1', { connected: true, prs: [row(970, live(970, PASSED, { state: o.state ?? 'merged', merged_at: o.state === 'closed' ? undefined : merged.merged_at }))] }, now)
      if (o.repo) writeDeck('work:/w', o.repo, now)
    }
    // The Release section's kept entry: the last tag and one Fixed entry on master → a patch.
    const REPO = { root: '/w', name: 'w', live: 1, tags: { last: { name: 'v0.185.0', at: now - 3_600_000 }, gaps: 0 },
      unreleased: { ref: 'origin/master', items: ['a'], count: 1, kinds: { Fixed: 1 } } }
    const folded = () => {
      // Nothing answers: what is drawn is what was kept; nothing new is asked for the version.
      const asked: string[] = []
      vi.stubGlobal('fetch', vi.fn((url: string) => { asked.push(url); return new Promise<Response>(() => {}) }))
      render(
        <FoldCtx.Provider value={{ full: false, toggle: () => {} }}>
          <CockpitCI sessionId="s1" repoScope="/w" onOpen={() => {}} />
        </FoldCtx.Provider>,
      )
      return asked
    }
    const fold = () => document.querySelector('[data-cockpit-ci-fold]')
    const line = () => document.querySelector('[data-cockpit-ci-merged]')

    it('merged, the next version predicted: goes out in 0.185.1', () => {
      keep({ ships: 'release', card: { number: 970, stage: 'merged', stage_at: now - 600_000, spend: SPEND }, repo: REPO })
      const asked = folded()
      expect(fold()).toHaveTextContent(/^Merged· goes out in 0\.185\.1$/)
      expect(line()).toHaveAttribute('data-cockpit-ci-merged', 'waits')
      expect(line()).toHaveAttribute('title', 'Merged. In no published release yet: it goes out in 0.185.1, the next release (predicted from the changelog entries)')
      expect(line()!.querySelector('[data-mark="pass"]')).not.toBeNull()
      expect(line()!.querySelector('span.text-ok')).toHaveTextContent(/^Merged$/)
      expect(asked.some((u) => u.includes('/work'))).toBe(false)
    })

    it('merged and released: released in 0.185.1', () => {
      keep({ ships: 'release', card: { number: 970, stage: 'released', release: 'v0.185.1', stage_at: now - 60_000, spend: SPEND }, repo: REPO })
      folded()
      expect(fold()).toHaveTextContent(/^Merged· released in 0\.185\.1$/)
      expect(line()).toHaveAttribute('data-cockpit-ci-merged', 'released')
    })

    it('merged, the version unknown: goes out in the next release', () => {
      keep({ ships: 'release', card: { number: 970, stage: 'merged', stage_at: now - 600_000, spend: SPEND } })
      folded()
      expect(fold()).toHaveTextContent(/^Merged· goes out in the next release$/)
      expect(line()).toHaveAttribute('title', 'Merged. In no published release yet: it goes out in the next release')
    })

    it('where work ships on merge: Merged alone', () => {
      keep({ ships: 'merge', releases: [], repo: REPO })
      folded()
      expect(fold()).toHaveTextContent(/^Merged$/)
      expect(line()).toHaveAttribute('data-cockpit-ci-merged', 'done')
      expect(line()).toHaveAttribute('title', 'Merged: work here ships when it merges')
    })

    it('closed without a merge: Closed, no check', () => {
      keep({ ships: 'release', state: 'closed', repo: REPO })
      folded()
      expect(fold()).toHaveTextContent(/^Closed$/)
      expect(line()).toBeNull()
      expect(fold()!.querySelector('[data-mark]')).toBeNull()
    })
  })

  // Owner, 2026-11-18, translated: "I switch to the tab and only after ~10 s
  // the CI data comes". A tab of another session on the same repository
  // draws the line from the answers kept for the repository, at once.
  describe('folded, on a tab switch', () => {
    const STATS = { connected: true, fetched_at: now - 30_000, read_at: now - 30_000, prs: [
      { number: 942, url: 'https://github.com/a/b/pull/942', title: 'chore(release): 0.183.0', state: 'open', created_at: now - 300_000 },
    ], board: { cards: [], releases: [], flow: { counts: {}, days: 14, merged: 0, ttm_count: 0, release_lag_count: 0, cost_usd: 0 } } }
    const folded = (sessionId: string) => render(
      <FoldCtx.Provider value={{ full: false, toggle: () => {} }}>
        <CockpitCI sessionId={sessionId} repoScope="/w" onOpen={() => {}} />
      </FoldCtx.Provider>,
    )
    const fold = () => document.querySelector('[data-cockpit-ci-fold]')

    it('draws the kept line before any read lands, muted, beside its own age', () => {
      writeDeck('stats:/w', STATS, now - 30_000)
      // Kept by another session's block on the same repository.
      writeDeck('ci:/w:942', { connected: true, fetched_at: now - 120_000, pr: { number: 942, url: '', repo: 'a/b', live: live(942, RUNNING) } }, now - 120_000)
      const asked: string[] = []
      vi.stubGlobal('fetch', vi.fn((url: string) => { asked.push(url); return new Promise<Response>(() => {}) }))
      folded('s2')
      // Synchronously, on the first draw: no read has answered.
      expect(fold()).toHaveAttribute('data-cockpit-ci-fold', '942')
      expect(fold()).toHaveAttribute('data-cockpit-ci-kept')
      expect(fold()).toHaveClass('opacity-70')
      expect(document.querySelector('[data-cockpit-ci-age]')).toHaveTextContent('2 min ago')
      // And the reads go out at once, not after an interval.
      expect(asked).toEqual(expect.arrayContaining(['/v1/sessions/s2/ci/stats', '/v1/sessions/s2/prs', '/v1/sessions/s2/ci?pr=942']))
    })

    it('waits for the read when the kept copy is older than an hour', () => {
      writeDeck('stats:/w', STATS, now - 30_000)
      writeDeck('ci:/w:942', { connected: true, pr: { number: 942, url: '', repo: 'a/b', live: live(942, RUNNING) } }, now - 2 * 3_600_000)
      vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
      folded('s2')
      expect(fold()).toBeNull()
    })

    it('shortens the checks rather than running past the edge', () => {
      writeDeck('stats:/w', STATS, now - 30_000)
      const MANY = { state: 'pending', passed: 12, failed: 1, pending: 1, items: [
        { name: 'a', state: 'fail' }, { name: 'b', state: 'pending', status: 'in_progress', started_at: now - 60_000 },
        ...Array.from({ length: 12 }, (_, i) => ({ name: `p${i}`, state: 'pass' })), { name: 's1', state: 'skipped' }, { name: 's2', state: 'skipped' },
      ] }
      writeDeck('ci:/w:942', { connected: true, pr: { number: 942, url: '', repo: 'a/b', live: live(942, MANY) } }, now - 10_000)
      vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
      folded('s2')
      const variants = [...fold()!.querySelectorAll('[data-fit-variant] [data-check-summary]')]
      // The bar shrinks first, 96 → 64 → 40 px, and only then do words go.
      expect(variants.map((v) => [v.getAttribute('data-check-fit'), v.getAttribute('data-check-bar-w')])).toEqual([
        [null, '96'], [null, '64'], [null, '40'], ['noskip', '40'], ['compact', '40'], ['worst', '40']])
      expect(variants[0]!.textContent).toBe('1 failed · 12/14 · 1 running · 50s · 2 skipped')
      expect(variants[2]!.textContent).toBe(variants[0]!.textContent)
      expect(variants[3]!.textContent).toBe('1 failed · 12/14 · 1 running · 50s')
      expect(variants[4]!.textContent).toBe('1 · 12/14 · 1')
      expect(variants[5]!.textContent).toBe('failed')
      // Every wording keeps the bar, a failure at its left edge; the bar is not read aloud.
      // 14 checks are a segment each at 96 px; narrower, they fill in proportion.
      expect(variants.map((v) => v.querySelector('[data-check-bar]')?.getAttribute('data-check-bar'))).toEqual(['segments', 'fill', 'fill', 'fill', 'fill', 'fill'])
      for (const v of variants) expect(v.querySelector('[data-check-bar]')).toHaveAttribute('aria-hidden')
      expect(variants[0]!.querySelector('[data-check-bar] i')).toHaveAttribute('data-tone', 'fail')
    })
  })

  // Owner, 2026-11-20, translated: "I open it, see red, click around and it
  // fixes itself". A kept copy being read again is faint, as of its age.
  it('unfolded, draws a kept list faint, as of its age, until the read lands', async () => {
    const stale = { connected: true, repo: 'a/b', fetched_at: now - 25 * 60_000, read_at: now - 25 * 60_000,
      prs: [{ number: 9, url: 'https://github.com/a/b/pull/9', title: 'Fix the login', state: 'open', created_at: now - 3_600_000 }],
      board: { cards: [{ number: 9, stage: 'fix', ci: 'fail', why: 'ci', stage_at: now - 600_000, spend: SPEND }], releases: [], flow: FLOW, ships_by: 'release' } }
    writeDeck('stats:/w', stale, now - 25 * 60_000)
    let land: (r: Response) => void = () => {}
    vi.stubGlobal('fetch', vi.fn((url: string) => url.endsWith('/ci/stats') ? new Promise<Response>((r) => { land = r }) : new Promise<Response>(() => {})))
    render(<CockpitCI sessionId="s1" repoScope="/w" onOpen={() => {}} />)
    // On the first draw, before any read answers: faint, never full-strength red.
    const body = () => document.querySelector('[data-cockpit-ci-body-kept]')
    expect(body()).not.toBeNull()
    expect(body()).toHaveClass('opacity-70', 'saturate-50')
    expect(document.querySelector('[data-cockpit-ci-pr="9"] [data-journey-seg="ci"]')).toHaveClass('bg-danger')
    expect(document.querySelector('[data-cockpit-ci-age]')).toHaveTextContent(/^as of 25 min ago$/)
    // The fresh answer: green now, at full strength, its own age.
    const fresh = { ...stale, fetched_at: now, read_at: now, board: { ...stale.board, cards: [{ ...stale.board.cards[0], stage: 'ready', ci: 'pass', why: undefined }] } }
    await act(async () => { land(answer(fresh)) })
    await waitFor(() => expect(body()).toBeNull())
    expect(document.querySelector('[data-cockpit-ci-age]')).toHaveTextContent(/^now$/)
    expect(document.querySelector('[data-cockpit-ci-pr="9"] [data-journey-seg="ci"]')).not.toHaveClass('bg-danger')
  })

  it('draws a kept copy younger than a few seconds at full strength', () => {
    writeDeck('stats:/w', { connected: true, repo: 'a/b', fetched_at: now - 5_000, read_at: now - 5_000,
      prs: [{ number: 9, url: 'https://github.com/a/b/pull/9', title: 'Fix', state: 'open', created_at: now - 3_600_000 }],
      board: { cards: [], releases: [], flow: FLOW, ships_by: 'release' } }, now - 5_000)
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
    render(<CockpitCI sessionId="s1" repoScope="/w" onOpen={() => {}} />)
    expect(document.querySelector('[data-cockpit-ci-pr="9"]')).not.toBeNull()
    expect(document.querySelector('[data-cockpit-ci-body-kept]')).toBeNull()
  })

  it('unfolded, times a kept copy as of its read until it is read again', () => {
    const then = now - 11 * 3_600_000
    const STALE = { state: 'pending', passed: 2, failed: 0, pending: 1, items: [
      { name: 'lint', state: 'pass', started_at: then - 240_000, completed_at: then - 200_000 },
      { name: 'go (windows-latest)', state: 'pending', status: 'in_progress', started_at: then - 240_000 },
    ] }
    writeDeck('prs:s1', { connected: true, prs: [row(801, live(801, STALE))] }, then)
    localStorage.setItem('caprock.cockpit.ciView', 'ring')
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
    render(<CockpitCI sessionId="s1" onOpen={() => {}} />)
    // 4 minutes as of the read, not 11 hours and growing.
    expect(document.querySelector('[data-cockpit-ci-ring]')).toHaveTextContent('1/2 · 4m 00s')
  })

  // A session in dspv/caprock opened cybrixcc/caprock-web #247 with `gh pr
  // create` run there (2026-11-19): the block read "CI #247" as this
  // repository's own.
  describe('a pull request the session opened in another repository', () => {
    const web = (n: number, checks: object) => ({ ...row(n, live(n, checks, { url: `https://github.com/c/web/pull/${n}`, repo: 'c/web' })), url: `https://github.com/c/web/pull/${n}` })
    const keep = (prs: object[]) => {
      writeDeck('prs:s1', { connected: true, prs })
      writeDeck('stats:s1', { connected: true, repo: 'a/b', fetched_at: now, read_at: now, prs: [] })
      vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
    }
    it('leads only when this repository has none open', () => {
      keep([web(247, RUNNING), row(9, live(9, PASSED))])
      localStorage.setItem('caprock.cockpit.ciView', 'ring')
      render(<CockpitCI sessionId="s1" onOpen={() => {}} />)
      const ring = document.querySelector('[data-cockpit-ci-ring]')!
      expect(ring).toHaveTextContent('1/1')
      expect(ring).toHaveTextContent('#9')
      expect(ring).not.toHaveTextContent(/web|#247/)
    })
    it('is labelled with its repository’s name before the number, the whole owner/name on hover', () => {
      keep([web(247, RUNNING)])
      localStorage.setItem('caprock.cockpit.ciView', 'ring')
      render(<CockpitCI sessionId="s1" onOpen={() => {}} />)
      expect(document.querySelector('[data-cockpit-ci-ring]')).toHaveTextContent('web #247')
      expect(screen.getByText('web #247')).toHaveAttribute('title', 'c/web')
    })
    it('folded, says its repository on the line', () => {
      keep([web(247, RUNNING)])
      render(
        <FoldCtx.Provider value={{ full: false, toggle: () => {} }}>
          <CockpitCI sessionId="s1" onOpen={() => {}} />
        </FoldCtx.Provider>,
      )
      const pr = document.querySelector('[data-cockpit-ci-fold-pr="247"]')!
      expect(pr.querySelector('[data-cockpit-ci-fold-repo="c/web"]')).toHaveTextContent(/^web #247$/)
      expect(pr.getAttribute('title')).toMatch(/^c\/web #247: this session’s pull request in another repository/)
    })
  })
})
