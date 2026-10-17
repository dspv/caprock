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
import { SessionSubagents } from './Cockpit'
import { WorkView } from '@/screens/Work'
import { forgetDeckAnswers, writeDeck } from '@/lib/deckCache'
import { planForRepo, type ReleasePlanData } from '@/lib/releaseplan'
import { releaseStatus } from '@/lib/releasestatus'
import { live } from '@/lib/live'
import { PipelineHostContext } from '@/lib/pipelineHost'

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
    // Plain words; the usual gap on hover only (owner, 2026-10-17).
    const since = document.querySelector('[data-release-since]')!
    expect(since).toHaveTextContent('1 change waiting for the next release · last release v0.117.4, 2h 05m ago')
    expect(since.textContent).not.toContain('median')
    expect(since).toHaveAttribute('title', expect.stringContaining('usually come 2h 40m apart'))
    const rows = [...document.querySelectorAll<HTMLElement>('[data-release-row]')]
    expect(rows.map((r) => r.getAttribute('data-release-row'))).toEqual(['630', '631', '633', expect.stringMatching(/^s:/)])
    for (const r of rows) {
      expect([...r.querySelectorAll('[data-step]')].map((e) => e.getAttribute('data-step'))).toEqual(['agent', 'PR', 'CI', 'merged', 'released'])
    }
    const merged = rows[0]!
    expect(merged.querySelectorAll('[data-step-state="done"]')).toHaveLength(4)
    // Owner, 2026-10-18: the empty released step says what it means and what the merge waits for.
    expect(merged.querySelector('[data-step="released"]')).toHaveAttribute('title', 'Released (shipped in a published release): waits for the next release (v0.118.0)\nAgent → PR → CI → Merged → Released')
    expect(within(merged).getByText('merged')).toBeInTheDocument()
    // The landing label is the word, and its step is red.
    const red = rows[1]!
    expect(red.querySelector('[data-release-word]')).toHaveTextContent('landing: CI red')
    expect(red.querySelector('[data-step="CI"]')).toHaveAttribute('data-step-state', 'red')
    expect(red.querySelector('[data-step="CI"]')).toHaveAttribute('title', 'CI: failed — landing: CI red\nAgent → PR → CI → Merged → Released')
    expect(rows[3]!.querySelector('[data-release-word]')).toHaveTextContent('no PR yet')
    expect(rows[3]!.querySelector('[data-step="PR"]')).toHaveAttribute('title', 'Pull request: none yet — the agent has not opened one\nAgent → PR → CI → Merged → Released')
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
    expect(ci).toHaveAttribute('title', 'CI: under way — CI running\nAgent → PR → CI → Merged → Released')
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
    expect(row(630).querySelector('[data-release-wait]')).toHaveTextContent('the next release')
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

  // Owner, 2026-10-18, translated, of caprock-web: eighteen merged pull
  // requests under Next release, each waiting for a release that never comes.
  it('has no next release where the repository ships on merge: one line, open work, and a short Merged recently', () => {
    const stats = statsFixture()
    stats.board!.ships_by = 'merge'
    for (const n of [640, 641, 642, 643]) {
      stats.prs!.push({ number: n, url: `u/${n}`, title: `site page ${n}`, state: 'merged', head: `p/${n}`, created_at: NOW - 900 * 60_000, merged_at: NOW - (700 - n) * 60_000 })
      stats.board!.cards.push({ number: n, stage: 'merged', stage_at: NOW - (700 - n) * 60_000, spend: { cost_usd: 0, sessions: 0, live: 0, agents: [] } })
    }
    const p = planForRepo(withKinds(), '/w/caprock', stats, NOW)
    expect(p.next).toBeUndefined()
    render(<ReleasePlan plan={p} />)
    expect(screen.queryByRole('heading')).toBeNull()
    expect(document.querySelector('[data-release-since]')).toHaveTextContent('No releases here: work ships when it merges')
    expect(document.querySelector('[data-release-plan]')).toHaveAttribute('data-release-ships', 'merge')
    // The open ones are in flight, their bars without a released step.
    const open = document.querySelector('[data-release-row="631"]')!
    expect([...open.querySelectorAll('[data-step]')].map((e) => e.getAttribute('data-step'))).toEqual(['agent', 'PR', 'CI', 'merged'])
    // The merges are done: the three newest of six (#630 50m ago, then #643…), under Merged recently, the bar full.
    expect(document.querySelector('[data-release-later="merged"]')).toHaveTextContent('Merged recently')
    const merges = [...document.querySelectorAll('[data-release-row][data-stage="merged"]')].map((e) => e.getAttribute('data-release-row'))
    expect(merges).toEqual(['630', '643', '642'])
    const full = document.querySelector('[data-release-row="643"]')!
    expect([...full.querySelectorAll('[data-step]')].map((e) => e.getAttribute('data-step-state'))).toEqual(['done', 'done', 'done', 'done'])
    expect(full.querySelector('[data-release-wait]')).toBeNull()
  })

  it('draws the released step neutral when nothing read says whether releases are cut', () => {
    const stats = statsFixture()
    delete stats.board!.ships_by
    render(<ReleasePlan plan={planForRepo(withKinds(), '/w/caprock', stats, NOW)} />)
    const step = document.querySelector('[data-release-row="630"] [data-step="released"]')!
    expect(step).toHaveAttribute('data-step-state', 'unknown')
    expect(step.getAttribute('title')).toMatch(/^Released \(shipped in a published release\): not known/)
  })
})

// Owner, 2026-10-17, translated, of an idle agent's row: "from here I want
// to go into the session". It goes as a Waiting for you row does.
describe('a row opens its session', () => {
  afterEach(() => { location.hash = '' })

  it('an agent row is a button: in the app it opens the session\'s tab, by click or keyboard', () => {
    const onOpenSession = vi.fn()
    render(
      <PipelineHostContext.Provider value={{ onOpenSession }}>
        <ReleasePlan plan={plan()} />
      </PipelineHostContext.Provider>,
    )
    const agent = document.querySelector<HTMLElement>('[data-release-row^="s:"]')!
    const btn = within(agent).getByRole('button', { name: /^Open the session: / })
    expect(btn).toHaveAttribute('title', expect.stringMatching(/^Open the session: /))
    fireEvent.click(btn)
    expect(onOpenSession).toHaveBeenCalledWith('s2')
    // A native button: Enter and Space press it, and it takes focus.
    btn.focus()
    expect(document.activeElement).toBe(btn)
  })

  it('in a browser, an agent row goes to the session\'s page: its timeline when another terminal holds it', () => {
    render(<ReleasePlan plan={plan()} />)
    const agent = document.querySelector<HTMLElement>('[data-release-row^="s:"]')!
    fireEvent.click(within(agent).getByRole('button', { name: /^Open the session: / }))
    expect(location.hash).toMatch(/^#\/session\/s2\?tab=timeline/)
  })

  it('a pull request row keeps its link and adds an Open session button when an agent is on it', () => {
    const onOpenSession = vi.fn()
    const onOpen = vi.fn()
    render(
      <PipelineHostContext.Provider value={{ onOpenSession }}>
        <ReleasePlan plan={plan()} onOpen={onOpen} />
      </PipelineHostContext.Provider>,
    )
    const row = (n: number) => document.querySelector<HTMLElement>(`[data-release-row="${n}"]`)!
    fireEvent.click(within(row(631)).getByRole('button', { name: /^Open session: / }))
    expect(onOpenSession).toHaveBeenCalledWith('s1')
    expect(onOpen).not.toHaveBeenCalled()
    fireEvent.click(within(row(631)).getByRole('button', { name: /folder search/ }))
    expect(onOpen).toHaveBeenCalledWith(631)
    // No agent recorded on a merged one: no button.
    expect(within(row(630)).queryByRole('button', { name: /^Open session/ })).toBeNull()
  })

  it('in a browser, a pull request row\'s button opens the terminal of a session Caprock holds', () => {
    render(<ReleasePlan plan={plan()} />)
    fireEvent.click(within(document.querySelector<HTMLElement>('[data-release-row="631"]')!).getByRole('button', { name: /^Open session: / }))
    expect(location.hash).toBe('#/session/s1?tab=terminal')
  })

  it('on the phone, an agent row is a tap target into the session\'s chat', () => {
    render(<ReleasePlan plan={plan()} phone />)
    const agent = document.querySelector<HTMLElement>('[data-release-row^="s:"]')!
    const a = within(agent).getByRole('link')
    expect(a).toHaveAttribute('href', '#/session/s2?tab=chat')
    expect(a).toHaveAttribute('title', expect.stringMatching(/^Open the session: /))
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

  // Owner, 2026-10-18, translated: "it shows vaguely what's going on on the
  // way to the release". The pushed branches and the working subagents, in
  // sections with counts, compact.
  it('lists in the right panel the pushed branches with no pull request and the session’s working subagents, in sections', async () => {
    h.data = withKinds()
    writeDeck('stats:/w/caprock', statsFixture())
    writeDeck('branches:/w/caprock', { connected: true, repo: 'dspv/caprock', default: 'master', base: 'origin/master', fetched_at: NOW,
      branches: [{ name: 'feat/batch-1', local: false, remote: true, ahead: 2, behind: 0, committed_ms: Date.now() - 30 * 60_000, cost_usd: 0, sessions: 0, agents: [], activity_at: 0, subject: 'fix(deck): the ring' }] })
    const subs = { working: [{ agent_id: 'a1', description: 'Port the ring', tool_calls: 3, started_at: Date.now() - 12 * 60_000, last_at: Date.now(), running: true, asking: false }], finished: 0 }
    render(<SessionSubagents.Provider value={subs}><CockpitRelease sessionId="s1" repoRoot="/w/caprock" /></SessionSubagents.Provider>)
    const region = await screen.findByRole('region', { name: 'Release' })
    await within(region).findByRole('heading', { name: '0.118.0' })
    const sections = [...region.querySelectorAll('[data-release-section]')].map((e) => e.textContent)
    expect(sections).toEqual(['In this release · 1 merged', 'Pull requests · 2 open', 'Ready · 1 branch', 'In progress · 2 agents'])
    const branch = region.querySelector('[data-release-row="b:feat/batch-1"]')!
    expect(branch).toHaveTextContent('fix(deck): the ring')
    expect(branch.querySelector('[data-release-word]')).toHaveTextContent('+2 · 30m')
    expect([...branch.querySelectorAll('[data-step-state]')].map((e) => e.getAttribute('data-step-state'))).toEqual(['done', 'off', 'off', 'off', 'off'])
    expect(region.querySelector('[data-release-row="sa:a1"] [data-release-word]')).toHaveTextContent('working · 12m')
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
