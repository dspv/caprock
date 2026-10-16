import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NOW, statsFixture, workFixture } from '@/lib/work.fixture'
import type { Work } from '@/lib/api'

const h = vi.hoisted(() => ({ work: 0, data: undefined as Work | undefined }))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api,
    work: async () => { h.work++; return h.data! },
  } }
})

import { CockpitRelease, ReleasePlan } from './ReleasePlan'
import { WorkView } from '@/screens/Work'
import { forgetDeckAnswers, writeDeck } from '@/lib/deckCache'
import { planForRepo, type ReleasePlanData } from '@/lib/releaseplan'
import { releaseStatus } from '@/lib/releasestatus'
import { live } from '@/lib/live'

afterEach(() => { h.work = 0; h.data = undefined; forgetDeckAnswers(); localStorage.clear() })

function withKinds(): Work {
  const w = workFixture()
  w.repos[0]!.unreleased = { ref: 'origin/master', items: ['a', 'b'], count: 2, kinds: { Added: 1, Fixed: 1 } }
  return w
}

const plan = (): ReleasePlanData => {
  const stats = statsFixture()
  stats.prs!.find((p) => p.number === 631)!.labels = [{ name: 'landing: CI red' }]
  return planForRepo(withKinds(), '/w/caprock', stats, NOW)
}

describe('the release plan', () => {
  it('heads with the next version, its rule on hover, then rows with a named segment per step and the stage word', () => {
    render(<ReleasePlan plan={plan()} />)
    const v = screen.getByRole('heading', { name: '0.118.0' })
    expect(v.title).toMatch(/^Next version, by the pending changes: a feature \(an Added entry\) makes a minor release/)
    expect(document.querySelector('[data-release-since]')).toHaveTextContent('1 merged since v0.117.4 · 2h 05m ago · usual gap 2h 40m (median of 9)')
    const rows = [...document.querySelectorAll<HTMLElement>('[data-release-row]')]
    expect(rows.map((r) => r.getAttribute('data-release-row'))).toEqual(['630', '631', '633', expect.stringMatching(/^s:/)])
    for (const r of rows) {
      expect([...r.querySelectorAll('[data-step]')].map((e) => e.getAttribute('data-step'))).toEqual(['agent', 'PR', 'CI', 'merged', 'released'])
    }
    const merged = rows[0]!
    expect(merged.querySelectorAll('[data-step-state="done"]')).toHaveLength(4)
    expect(merged.querySelector('[data-step="released"]')).toHaveAttribute('title', 'Released: to come')
    expect(within(merged).getByText('merged')).toBeInTheDocument()
    // The landing label is the word, and its step is red.
    const red = rows[1]!
    expect(red.querySelector('[data-release-word]')).toHaveTextContent('landing: CI red')
    expect(red.querySelector('[data-step="CI"]')).toHaveAttribute('data-step-state', 'red')
    expect(red.querySelector('[data-step="CI"]')).toHaveAttribute('title', 'CI: failed — landing: CI red')
    expect(rows[3]!.querySelector('[data-release-word]')).toHaveTextContent('agent')
    expect([...rows[3]!.querySelectorAll('[data-step]')].map((e) => e.getAttribute('data-step-state'))).toEqual(['done', 'off', 'off', 'off', 'off'])
    // A pull request row goes to its detail on the Pipeline.
    expect(within(merged).getByRole('link')).toHaveAttribute('href', expect.stringContaining('pipeline'))
  })

  it('says beside the word what each row waits for, its age and its CI per OS', () => {
    const stats = statsFixture()
    stats.board!.cards.find((c) => c.number === 631)!.os = [
      { os: 'linux', state: 'pass', checks: 3 },
      { os: 'windows', state: 'running', since: NOW - 4 * 60_000, checks: 2 },
      { os: 'macos', state: 'running', since: NOW - 6 * 60_000, checks: 2 },
    ]
    stats.board!.cards.find((c) => c.number === 633)!.ci_ms = 14 * 60_000
    render(<ReleasePlan plan={planForRepo(withKinds(), '/w/caprock', stats, NOW)} />)
    const row = (n: number) => document.querySelector<HTMLElement>(`[data-release-row="${n}"]`)!
    // Running: which OS it waits for and since when; the CI step breathes.
    expect(row(631).querySelector('[data-release-wait]')).toHaveTextContent('CI on macOS, Windows · 6m')
    expect(row(631).querySelector('[data-release-wait]')!.getAttribute('title')).toMatch(/usually 11m/)
    const ci = row(631).querySelector('[data-step="CI"]')!
    expect(ci).toHaveAttribute('data-step-state', 'now')
    expect(ci).toHaveClass('release-step-pulse')
    expect(ci).toHaveAttribute('title', 'CI: under way — CI running')
    // A dot per OS, macOS · Linux · Windows, each named.
    const dots = [...row(631).querySelectorAll('[data-os]')]
    expect(dots.map((d) => [d.getAttribute('data-os'), d.getAttribute('data-os-state')])).toEqual([['macos', 'running'], ['linux', 'pass'], ['windows', 'running']])
    expect(dots[0]).toHaveAttribute('title', 'macOS: running 6m (2 checks)')
    expect(dots[1]).toHaveAttribute('title', 'Linux: passed (3 checks)')
    // CI time: running, so far over the usual; the agent cost recorded on it, "—" where none was.
    expect(row(631).querySelector('[data-release-citime]')).toHaveTextContent('6m / ~11m')
    expect(row(631).querySelector('[data-release-cost]')).toHaveTextContent('$5.10')
    expect(row(631).querySelector('[data-release-cost]')!.getAttribute('title')).toMatch(/over 2 sessions, at API list price, not a bill/)
    expect(row(633).querySelector('[data-release-citime]')).toHaveTextContent('14m +27%')
    expect(row(633).querySelector('[data-release-citime]')).toHaveClass('text-warn')
    expect(document.querySelector('[data-release-row^="s:"] [data-release-cost]')).toHaveTextContent('$2.50')
    // Age since opened.
    expect(row(631).querySelector('[data-release-age]')).toHaveTextContent('30m')
    expect(row(633).querySelector('[data-release-age]')).toHaveTextContent('1h')
    // Ready waits for a merge; merged for a release, the usual lag on hover; no dots without OS-named checks.
    expect(row(633).querySelector('[data-release-wait]')).toHaveTextContent('a merge')
    expect(row(633).querySelector('[data-release-ci]')).toBeNull()
    expect(row(630).querySelector('[data-release-wait]')).toHaveTextContent('a release')
    expect(row(630).querySelector('[data-release-wait]')!.getAttribute('title')).toMatch(/usually released in ~2h/)
    // The agent asking for a permission waits on the person.
    const agent = document.querySelector<HTMLElement>('[data-release-row^="s:"]')!
    expect(agent.querySelector('[data-release-wait]')).toHaveTextContent('your permission')
    expect(agent.querySelector('[data-release-wait]')).toHaveClass('text-warn')
  })

  it('drops the extra columns first as the container narrows, the bar growing with the row', () => {
    const { unmount } = render(<ReleasePlan plan={plan()} />)
    const rows = document.querySelector<HTMLElement>('[data-release-rows]')!
    // A container query on the plan, not the window: the right panel and the Pipeline differ.
    expect(rows.parentElement).toHaveClass('@container/plan')
    // Below 520px: title, bar, word; the bar's track a share of the row, never fixed.
    expect(rows.className).toContain('grid-cols-[minmax(0,1.4fr)_minmax(88px,1fr)_auto]')
    expect(rows.className).toContain('@[840px]/plan:grid-cols-[minmax(0,1.4fr)_minmax(88px,1fr)_repeat(6,auto)]')
    const r = document.querySelector<HTMLElement>('[data-release-row="631"]')!
    const col = (k: string) => r.querySelector<HTMLElement>(`[data-release-col="${k}"]`)!
    // Hidden until their width: the age drops first, then CI time, CI per OS, cost; what it waits for last.
    expect(col('age')).toHaveClass('hidden', '@[840px]/plan:block')
    expect(col('citime')).toHaveClass('hidden', '@[760px]/plan:block')
    expect(col('ci')).toHaveClass('hidden', '@[680px]/plan:block')
    expect(col('cost')).toHaveClass('hidden', '@[600px]/plan:block')
    expect(col('wait')).toHaveClass('hidden', '@[520px]/plan:block')
    expect(r.querySelector('[data-release-bar]')).toHaveClass('w-full')
    unmount()
    // The cockpit's narrower shares.
    render(<ReleasePlan plan={plan()} compact />)
    expect(document.querySelector('[data-release-rows]')!.className).toContain('grid-cols-[minmax(0,2.2fr)_minmax(60px,1fr)_auto]')
  })

  it('opens a row in place when the page asks to', () => {
    const onOpen = vi.fn()
    render(<ReleasePlan plan={plan()} onOpen={onOpen} />)
    fireEvent.click(screen.getByRole('button', { name: /#630/ }))
    expect(onOpen).toHaveBeenCalledWith(630)
  })

  it('says Next release without a number when the entries say no kind', () => {
    render(<ReleasePlan plan={planForRepo(workFixture(), '/w/caprock', statsFixture(), NOW)} />)
    expect(screen.getByRole('heading', { name: 'Next release' }).title).toMatch(/No number/)
  })
})

describe('where it is drawn', () => {
  it('is the Work page’s third view, Release, beside List and Kanban, remembered', () => {
    render(<WorkView work={withKinds()} stats={new Map([['/w/caprock', statsFixture()]])} now={NOW} passed={0} />)
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['List', 'Kanban', 'Release'])
    fireEvent.click(screen.getByRole('tab', { name: 'Release' }))
    expect(localStorage.getItem('caprock.work.view')).toBe('release')
    const plans = [...document.querySelectorAll('[data-release-plan]')].map((e) => e.getAttribute('data-release-plan'))
    expect(plans).toEqual(['caprock', 'site'])
    expect(screen.getByRole('heading', { name: '0.118.0' })).toBeInTheDocument()
    // The strip the other views carry is the plan's heading here.
    expect(document.querySelector('[data-work-next-release]')).toBeNull()
  })

  it('is the right panel’s Release section: the kept Pipeline answer and one Work read, again on GitHub news only', async () => {
    h.data = withKinds()
    writeDeck('stats:/w/caprock', statsFixture())
    render(<CockpitRelease sessionId="s1" repoRoot="/w/caprock" />)
    const region = await screen.findByRole('region', { name: 'Release' })
    expect(await within(region).findByRole('heading', { name: '0.118.0' })).toBeInTheDocument()
    expect(region.querySelectorAll('[data-release-row]').length).toBeGreaterThan(0)
    expect(h.work).toBe(1)
    vi.useFakeTimers()
    try {
      // A turn of the agent beside it reads nothing again; GitHub news does.
      act(() => { live.handle({ type: 'session', data: {} } as never) })
      await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
      expect(h.work).toBe(1)
      act(() => { live.handle({ type: 'github', data: {} } as never) })
      await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
      expect(h.work).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('draws nothing in the right panel for a session outside a repository', () => {
    const { container } = render(<CockpitRelease sessionId="s1" />)
    expect(container).toBeEmptyDOMElement()
    expect(h.work).toBe(0)
  })
})

// Owner, 2026-10-16, translated: "it's not clear how releases go and where".
describe('the release status on the plan', () => {
  it('draws the bump and why beside the version, the stages as pills, and the last release', () => {
    const status = releaseStatus({ lastTag: { name: 'v0.117.4', at: NOW - 7_500_000 }, unreleased: withKinds().repos[0]!.unreleased, merged: 1,
      prs: [], releases: [{ tag: 'v0.117.4', url: 'https://github.com/o/r/releases/tag/v0.117.4', published_at: NOW - 7_500_000, prs: [], cost_usd: 0, sessions: 0, assets: 14 }] })
    render(<ReleasePlan plan={plan()} status={status} now={NOW} />)
    expect(screen.getByRole('heading', { name: '0.118.0' })).toBeInTheDocument()
    expect(document.querySelector('[data-release-why]')).toHaveTextContent('minora feature since v0.117.4 (1 feature, 1 other)')
    const stages = screen.getByRole('list', { name: 'Release 0.118.0: stages' })
    expect([...stages.querySelectorAll('[data-journey-step]')].map((e) => e.getAttribute('data-journey-step'))).toEqual(['merged', 'pr', 'ci', 'tag', 'builds', 'published', 'site'])
    expect(stages.querySelector('[data-journey-step="pr"]')).toHaveAttribute('data-step-state', 'current')
    expect(stages.querySelector('[data-journey-step="site"]')).toHaveAttribute('data-step-unknown')
    expect(document.querySelector('[data-release-last]')).toHaveTextContent('Last releasev0.117.4·2h ago·14 files·GitHub ↗')
    // The pull request rows stay as they were.
    expect(document.querySelectorAll('[data-release-row]').length).toBe(plan().rows.length)
  })

  it('puts a tag under way above the next release', () => {
    const status = releaseStatus({ lastTag: { name: 'v0.118.0', at: NOW - 600_000 }, unreleased: { ref: 'origin/master', items: [], count: 0 }, merged: 0, prs: [],
      releases: [{ tag: 'v0.117.4', published_at: NOW - 7_500_000, prs: [], cost_usd: 0, sessions: 0, assets: 14 }],
      run: { repo: 'o/r', tag: 'v0.118.0', state: 'running', at: NOW } })
    render(<ReleasePlan plan={plan()} status={status} now={NOW} />)
    const box = document.querySelector<HTMLElement>('[data-release-status="tagged"]')!
    expect(box).toHaveTextContent('0.118.0releasing')
    expect(within(box).getByRole('list')).toBeInTheDocument()
    expect(box.querySelector('[data-journey-step="builds"]')).toHaveAttribute('data-step-state', 'current')
  })
})
