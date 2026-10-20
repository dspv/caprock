import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CockpitCI, checkSummary } from './CockpitCI'
import { forgetDeckAnswers, writeDeck } from '@/lib/deckCache'
import { prChecks } from '@/lib/ci'
import { CheckSummary } from './CheckSummary'
import { forgetPRProgress } from '@/lib/usePRForce'

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
    fireEvent.click(screen.getByRole('button', { name: 'Pipeline →' }))
    expect(onOpen).toHaveBeenCalledTimes(1)
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
    // The log is the Pipeline's, on that PR.
    fireEvent.click(document.querySelector('[data-cockpit-ci-pr="9"] [data-cockpit-ci-log]')!)
    expect(onOpen).toHaveBeenCalledWith(9)
    fireEvent.click(act1)
    expect(document.querySelector('[data-cockpit-ci-confirm]')).toHaveTextContent('Ask Login agent to fix #9’s CI and push?')
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
  })
})
