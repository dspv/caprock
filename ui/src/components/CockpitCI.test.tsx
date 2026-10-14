import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CockpitCI, checkSummary } from './CockpitCI'
import { forgetDeckAnswers, writeDeck } from '@/lib/deckCache'
import { prChecks } from '@/lib/ci'
import { CheckSummary } from './CheckSummary'

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

afterEach(() => { forgetDeckAnswers(); localStorage.clear(); vi.unstubAllGlobals() })

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
        { number: 9, url: 'https://github.com/a/b/pull/9', title: 'Fix the login', state: 'open', created_at: now - 3_600_000 },
        { number: 8, url: 'https://github.com/a/b/pull/8', title: 'Release notes', state: 'merged', created_at: now - 7_200_000, merged_at: now - 5_000_000 },
        { number: 7, url: 'https://github.com/a/b/pull/7', title: 'Old one', state: 'merged', created_at: now - 9_000_000, merged_at: now - 8_000_000 },
      ],
      board: {
        cards: [
          { number: 9, stage: 'fix', ci: 'fail', why: 'ci', stage_at: now - 600_000, spend: { cost_usd: 0, sessions: 0, live: 0, agents: [] } },
          { number: 8, stage: 'merged', stage_at: now - 5_000_000, spend: { cost_usd: 0, sessions: 0, live: 0, agents: [] } },
          { number: 7, stage: 'released', release: 'v1.2.0', stage_at: now - 4_000_000, spend: { cost_usd: 0, sessions: 0, live: 0, agents: [] } },
        ],
        releases: [], flow: { counts: {}, days: 14, merged: 2, ttm_count: 0, release_lag_count: 0, cost_usd: 0 },
      },
    }
    const fetch = vi.fn(async () => new Response(JSON.stringify(stats), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetch)
    const onOpen = vi.fn()
    render(<CockpitCI sessionId="s1" repoScope="/w" onOpen={onOpen} />)
    await waitFor(() => expect(document.querySelector('[data-cockpit-ci-pr="9"]')).not.toBeNull())
    expect(fetch).toHaveBeenCalledWith('/v1/sessions/s1/ci/stats', expect.anything())
    // In flight first, then merged, then released.
    expect([...document.querySelectorAll('[data-cockpit-ci-pr]')].map((e) => e.getAttribute('data-cockpit-ci-pr'))).toEqual(['9', '8', '7'])
    const ci = document.querySelector('[data-cockpit-ci-pr="9"] [data-journey-seg="ci"]')!
    expect(ci).toHaveAttribute('data-step-state', 'current')
    expect(ci).toHaveClass('bg-danger')
    expect(document.querySelector('[data-cockpit-ci-pr="9"]')).toHaveTextContent('Fix the login')
    expect(document.querySelector('[data-cockpit-ci-pr="8"] [data-journey-seg="merged"]')).toHaveAttribute('data-step-state', 'current')
    expect(document.querySelector('[data-cockpit-ci-pr="7"] [data-journey-bar]')).toHaveAttribute('aria-label', expect.stringContaining('v1.2.0 (now)'))
    // It scrolls inside the block; Expand only past a few rows; the page one click away.
    expect(document.querySelector('[data-cockpit-journey]')).toHaveClass('overflow-y-auto', 'max-h-[176px]')
    expect(document.querySelector('[data-cockpit-ci-tall]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Pipeline ↗' }))
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
})
