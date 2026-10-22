import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/lib/api'

const now = Date.now()
const day = (i: number) => new Date(now - (13 - i) * 86_400_000).toISOString().slice(0, 10)

const h = vi.hoisted(() => ({ statsGate: undefined as Promise<void> | undefined, stats: undefined as unknown, prs: { connected: true, prs: [] as unknown[] } as unknown, ci: {} as Record<number, unknown>, asked: [] as string[], queued: [] as string[], logs: 0, work: 0 }))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api,
    sessionCIStats: async () => { h.asked.push('stats'); if (h.statsGate) await h.statsGate; return h.stats },
    sessionPRs: async () => { h.asked.push('prs'); return h.prs },
    work: async () => {
      h.work++
      return { now, day_start: 0, sessions: [], hive: 'off', queued: [], totals: { live: 0, working: 0, waiting_you: 0, today_usd: 0, machine_today_usd: 0 },
        repos: [{ root: '/w', name: 'w', via_session: 's1', live: 1, unreleased: { ref: 'origin/main', items: ['x'], count: 1, kinds: { Fixed: 1 } }, tags: { last: { name: 'v1.2.0', at: now - 600_000 }, gaps: 0 } }] }
    },
    sessionCI: async (_id: string, pr?: number) => { h.asked.push(`ci ${pr}`); return h.ci[pr ?? 0] ?? { connected: true } },
    actionsUsage: async () => { h.asked.push('usage'); throw new Error('no billing') },
    sessionCILog: async () => { h.logs++; return { job_id: 72, lines: ['--- FAIL: TestRestore (0.42s)', '##[error]Process completed with exit code 1.'], error_line: 1 } },
    queueSend: async (_id: string, text: string) => { h.queued.push(text); return { sent: true, queue: { session_id: 's1', messages: [], waiting: '' } } },
  } }
})

import { PipelineView } from './PipelineView'
import { forgetDeckAnswers, writeDeck } from '@/lib/deckCache'

const session = { session_id: 's1', cwd: '/w', repo_root: '/w', project: 'w', status: 'active', owned: true, agent: 'claude', git_branch: 'fix/x', started_at: 0, last_event_at: now } as unknown as SessionSummary

const job = (id: number, name: string, os: string, conclusion: string | undefined, status = 'completed', ms = 120_000) => ({
  id, run_id: 7, name, os, labels: [], status, conclusion, started_at: now - 6 * 60_000, completed_at: status === 'completed' ? now - 6 * 60_000 + ms : undefined,
  duration_ms: status === 'completed' ? ms : undefined, baseline: { median_ms: 100_000, runs: 5 },
  steps: [{ number: 1, name: 'go test', status: 'completed', conclusion: conclusion === 'failure' ? 'failure' : 'success', duration_ms: 9_000 }],
})

const live = { number: 21, url: 'https://github.com/a/b/pull/21', title: 'Fix the scrollback', state: 'open', draft: false, branch: 'fix/x', base: 'main', head_sha: 'h21', mergeable: true, mergeable_state: 'clean',
  review: '', reviews: [], additions: 181, deletions: 59, changed_files: 13, commits: 2, created_at: now - 14 * 60_000,
  checks: { state: 'fail', passed: 2, failed: 1, pending: 0, items: [{ name: 'go (ubuntu-latest)', state: 'pass' }, { name: 'go (macos-latest)', state: 'fail' }] } }

function connected() {
  h.stats = {
    connected: true, repo: 'a/b', fetched_at: now,
    prs: [{ number: 22, url: 'https://github.com/a/b/pull/22', title: 'Bump deps', state: 'open' }, { number: 21, url: live.url, title: live.title, state: 'open' }, { number: 20, url: 'https://github.com/a/b/pull/20', title: 'Release', state: 'merged', created_at: now - 3_600_000, merged_at: now - 3_000_000 }],
    stats: {
      days: Array.from({ length: 14 }, (_, i) => day(i)), merged: [5, 27, 13, 12, 22, 37, 22, 35, 32, 27, 28, 91, 30, 19], ttm_median_ms: 8 * 60_000, ttm_count: 300, prs_listed: 50,
      ci: { runs: 47, red: 3, reruns: 1, listed: 100, per_day: Array.from({ length: 14 }, () => ({ runs: 3, red: 0 })), workflows: [{ name: 'ci', runs: 40, red: 3, median_ms: 430_000, median_runs: 37, daily_median_ms: Array(14).fill(430_000) }] },
    },
  }
  h.prs = { connected: true, prs: [{ session_id: 's1', url: live.url, number: 21, title: live.title, last_at: now, live }] }
  h.ci[21] = { connected: true, pr: { number: 21, url: live.url, repo: 'a/b', head_sha: 'h21', live }, ci: { repo: 'a/b', head_sha: 'h21', state: 'fail', runner_ms: 360_000, by_os: [], at: now, runs: [{ id: 7, name: 'ci', status: 'completed', conclusion: 'failure', started_at: now - 6 * 60_000, updated_at: now, jobs: [
    job(71, 'go (ubuntu-latest)', 'linux', 'success', 'completed', 118_000), job(72, 'go (macos-latest)', 'macos', 'failure'), job(73, 'changes', 'linux', 'success', 'completed', 3_000), job(74, 'app (x)', '', 'skipped'),
  ] }] } }
}

afterEach(() => { h.statsGate = undefined; h.stats = undefined; h.prs = { connected: true, prs: [] }; h.ci = {}; h.asked = []; h.queued = []; h.logs = 0; h.work = 0; forgetDeckAnswers(); localStorage.clear() })

const card = (number: number, stage: string, p: object = {}) => ({ number, stage, stage_at: now - 600_000, spend: { cost_usd: 0, sessions: 0, live: 0, agents: [] }, ...p })
const FLOW = { counts: { draft: 0, open: 1, fix: 1, ready: 0, merged: 0, released: 1 }, days: 14, merged: 7, ttm_median_ms: 2 * 3_600_000, ttm_count: 7, release_lag_median_ms: 5 * 3_600_000, release_lag_count: 4, ci_median_ms: 430_000, cost_usd: 15.5 }

function withBoard() {
  connected()
  const st = h.stats as { prs: Record<string, unknown>[] } & Record<string, unknown>
  st.prs[0] = { ...st.prs[0], author: 'grace', author_avatar: 'https://avatars.githubusercontent.com/u/2', labels: [{ name: 'dependencies', color: '0366d6' }] }
  st.board = {
    default_branch: 'main',
    cards: [
      card(22, 'open', { ci: 'running', stage_at: now - 5 * 60_000, spend: { cost_usd: 3.5, sessions: 2, live: 2, agents: ['claude'] } }),
      card(21, 'fix', { ci: 'fail', why: 'ci', stage_at: now - 3_600_000 }),
      card(20, 'released', { release: 'v1.2.0', spend: { cost_usd: 12, sessions: 1, live: 0, agents: ['codex'] } }),
    ],
    releases: [{ tag: 'v1.2.0', url: 'https://github.com/a/b/releases/tag/v1.2.0', published_at: now - 600_000, prs: [20], cost_usd: 12, sessions: 1 }],
    flow: FLOW,
  }
}

const rowOrder = () => [...document.querySelectorAll('[data-prs-row]')].map((e) => e.getAttribute('data-prs-row'))
async function rowsDrawn() {
  await waitFor(() => { if (!document.querySelector('[data-prs-row]')) throw new Error('no rows') })
}

describe('the Pipeline page', () => {
  // Owner, 2026-10-15, translated: "I'm missing progress bars to the release here".
  it('puts the next release under Flow: the version its changelog calls for and a bar per pull request in flight', async () => {
    withBoard()
    render(<PipelineView sessionId="s1" session={session} visible onBack={() => {}} />)
    await rowsDrawn()
    const panel = document.querySelector('[data-pipeline-release]') as HTMLElement
    expect(panel).not.toBeNull()
    expect(await screen.findByRole('heading', { name: '1.2.1' })).toBeInTheDocument()
    expect(h.work).toBe(1)
    // Flow first, then the plan, then the list.
    const flow = document.querySelector('[data-stat="flight"]')!
    expect(flow.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect([...panel.querySelectorAll('[data-release-row]')].map((e) => e.getAttribute('data-release-row'))).toEqual(['21', '22'])
    expect(panel.querySelector('[data-release-row="21"] [data-release-word]')).toHaveTextContent('CI red')
    // A row opens its pull request beside the list.
    fireEvent.click(within(panel).getByRole('button', { name: /#22/ }))
    expect(await screen.findByRole('dialog', { name: '#22 in detail' })).toBeInTheDocument()
  })

  // Owner, 2026-10-14, translated: "PR titles are missing … I'd merge it all
  // into one — PR rows with their statuses, so I understand how things
  // travel, what gets released".
  it('is one list: the flow strip, each pull request with its whole title, labels and three steps, in flight first, and the releases', async () => {
    withBoard()
    render(<PipelineView sessionId="s1" session={session} visible onBack={() => {}} />)
    await rowsDrawn()
    expect(screen.getByRole('heading', { name: 'Pull requests' })).toBeInTheDocument()
    expect(document.querySelector('[data-prs-view]')).toBeNull()
    // Needs a fix, then CI running, then released.
    expect(rowOrder()).toEqual(['21', '22', '20'])
    const r22 = document.querySelector('[data-prs-row="22"]')!
    expect(r22).toHaveTextContent('Bump deps')
    expect(r22.querySelector('[data-prs-label="dependencies"]')).toBeInTheDocument()
    expect(r22).toHaveTextContent('grace')
    expect(r22.querySelector('[data-journey-step="ci"]')).toHaveAttribute('data-step-state', 'current')
    expect(r22.querySelector('[data-journey-step="ci"]')).toHaveTextContent('CI running')
    expect(r22.querySelector('[data-journey-step="open"]')).toHaveAttribute('data-step-state', 'done')
    expect(r22).toHaveTextContent('$3.50')
    expect(document.querySelector('[data-prs-row="21"] [data-journey-step="ci"]')).toHaveTextContent('CI red')
    const r20 = document.querySelector('[data-prs-row="20"]')!
    // Owner, 2026-10-20, translated: the final status should be merged; the
    // release is a quiet word after the steps, never a step of its own.
    expect(r20.querySelector('[data-journey-step="released"]')).toBeNull()
    expect(r20.querySelector('[data-journey-step="merged"]')).toHaveAttribute('data-step-state', 'current')
    expect(r20.querySelector('[data-release-note="released"]')).toHaveTextContent('in v1.2.0')
    expect(r22.querySelector('[data-release-note]')).toBeNull()
    // The flow strip on top, the releases below; no pull request's CI asked until one is opened.
    expect(document.querySelector('[data-stat="speed"]')).toHaveTextContent('0.5/day')
    expect(document.querySelector('[data-stat="speed"]')).toHaveTextContent('merge→release ~5h')
    expect(document.querySelector('[data-stat="speed"] [data-stat-hint]')).toHaveTextContent('estimate')
    // The head's Share pill, once the figures are read.
    expect(document.querySelector('[data-pipeline-share]')).toHaveTextContent('Share')
    // The dashboard's figure tiles: needing a fix is red, and each says what
    // it means in a card under it, never a native tooltip over the figure.
    const fix = document.querySelector('[data-stat="fix"]')!
    expect(fix).toHaveTextContent('1')
    expect(fix.querySelector('.text-danger')).toBeInTheDocument()
    expect(fix.querySelector('[data-stat-hint]')).toHaveAttribute('role', 'tooltip')
    expect(fix).not.toHaveAttribute('title')
    expect(document.querySelector('[data-stat="flight"]')).toHaveTextContent('2')
    expect(document.querySelector('[data-board-release="v1.2.0"]')).toHaveTextContent('#20')
    expect(h.asked.some((a) => a.startsWith('ci '))).toBe(false)
    expect(document.querySelector('[data-prs-detail]')).toBeNull()
  })

  // Owner, 2026-10-23, translated: "TOP-5 most expensive pull requests and
  // TOP-5 most expensive releases … it must fit in organically".
  it('lists the dearest pull requests and releases from the board, saying the span, and each opens', async () => {
    withBoard()
    const nudges = await import('@/lib/nudges')
    const opened = vi.spyOn(nudges, 'openExternal').mockImplementation(() => {})
    render(<PipelineView sessionId="s1" session={session} visible onBack={() => {}} />)
    await rowsDrawn()
    const panel = document.querySelector('[data-board-expensive]') as HTMLElement
    expect(panel).not.toBeNull()
    expect(screen.getByRole('heading', { name: /Most expensive/ })).toBeInTheDocument()
    const prs = panel.querySelector('[data-expensive="prs"]') as HTMLElement
    expect(prs).toHaveTextContent('Pull requests · last 14 days')
    // Dearest first; #21 has no recorded session and is left out.
    expect([...prs.querySelectorAll('[data-expensive-pr]')].map((e) => e.getAttribute('data-expensive-pr'))).toEqual(['20', '22'])
    expect(prs.querySelector('[data-expensive-pr="20"]')).toHaveTextContent('#20Release$12.001 session')
    expect(prs.querySelector('[data-expensive-pr="22"]')).toHaveTextContent('$3.502 sessions')
    expect(prs.querySelector('[data-expensive-pr="22"]')!.getAttribute('title')).toContain('API list price')
    const rels = panel.querySelector('[data-expensive="releases"]') as HTMLElement
    expect(rels).toHaveTextContent('Releases · newest 1')
    expect(rels.querySelector('[data-expensive-release="v1.2.0"]')).toHaveTextContent('$12.00')
    expect(rels.querySelector('[data-expensive-release="v1.2.0"]')).toHaveTextContent('1 PR')
    // A pull request opens beside the list; a release on GitHub.
    fireEvent.click(prs.querySelector('[data-expensive-pr="22"]')!)
    expect(await screen.findByRole('dialog', { name: '#22 in detail' })).toBeInTheDocument()
    fireEvent.click(rels.querySelector('[data-expensive-release="v1.2.0"]')!)
    expect(opened).toHaveBeenCalledWith('https://github.com/a/b/releases/tag/v1.2.0')
    opened.mockRestore()
  })

  it('draws no Most expensive panel when nothing on the board has a recorded cost', async () => {
    withBoard()
    const b = (h.stats as { board: { cards: { spend: object }[]; releases: { cost_usd: number; sessions: number }[] } }).board
    for (const c of b.cards) c.spend = { cost_usd: 0, sessions: 0, live: 0, agents: [] }
    for (const r of b.releases) { r.cost_usd = 0; r.sessions = 0 }
    render(<PipelineView sessionId="s1" session={session} visible onBack={() => {}} />)
    await rowsDrawn()
    expect(document.querySelector('[data-board-release="v1.2.0"]')).toBeInTheDocument()
    expect(document.querySelector('[data-board-expensive]')).toBeNull()
  })

  // Owner, 2026-10-18: the Flow row is three cards; Now says All clear or the most urgent count.
  it('says All clear when nothing is in flight, red or waiting, and the red count first when a pull request needs a fix', async () => {
    withBoard()
    const st = h.stats as { board: { flow: Record<string, unknown> } }
    st.board.flow = { ...FLOW, counts: { draft: 0, open: 0, fix: 0, ready: 0, merged: 0, released: 1 } }
    const { unmount } = render(<PipelineView sessionId="s1" session={session} visible onBack={() => {}} />)
    await rowsDrawn()
    const now = document.querySelector('[data-flow-card="now"]')!
    expect(now.querySelector('[data-flow-clear]')).toHaveTextContent('All clear')
    expect(now.querySelector('[data-stat="flight"]')).toHaveTextContent(/^0in flight/)
    expect(now.querySelector('[data-stat="fix"]')).toHaveTextContent(/^0red/)
    expect(now.querySelector('[data-stat="ready"]')).toHaveTextContent(/^0waiting/)
    unmount()
    forgetDeckAnswers()
    withBoard()
    render(<PipelineView sessionId="s1" session={session} visible onBack={() => {}} />)
    await rowsDrawn()
    const busy = document.querySelector('[data-flow-card="now"]')!
    expect(busy.querySelector('[data-flow-clear]')).toBeNull()
    expect(busy.querySelector('[data-stat="fix"]')).toHaveTextContent(/^1needs a fix/)
    expect(busy.querySelector('[data-stat="fix"] > .num')).toHaveClass('text-danger')
    expect(busy.querySelector('[data-stat="flight"]')).toHaveTextContent(/^2in flight/)
    expect(busy.querySelector('[data-stat="ready"]')).toHaveTextContent(/^0ready/)
  })

  // Owner, 2026-10-15, translated: "I want the figures in dynamics, like
  // everywhere else in our app — the metric, plus a small chart, and
  // above/below the average indicator".
  it('draws a sparkline only where there is history, and says what is missing once under the row', async () => {
    withBoard()
    const pts = (v: (i: number) => number | undefined, extra: (i: number) => object = () => ({})) =>
      Array.from({ length: 14 }, (_, i) => ({ day: day(i), value: v(i), n: v(i) === undefined ? 0 : 1, ...extra(i) }))
    const st = h.stats as { board: { flow: Record<string, unknown> } }
    st.board.flow = { ...FLOW, series: {
      throughput: pts((i) => (i % 2 ? 1 : 0), (i) => ({ n: i % 2, by_now: i === 13 ? 0 : i % 2 })),
      cost: pts((i) => (i === 13 ? 1 : undefined), (i) => ({ n: i === 13 ? 1 : 0 })),
    } }
    render(<PipelineView sessionId="s1" session={session} visible onBack={() => {}} />)
    await rowsDrawn()
    expect(document.querySelector('[data-stat="speed"] [data-trend="throughput"] [role="img"]')).toHaveAttribute('aria-label', 'Throughput, last 14 days, today last')
    // The agent cost has one day: no line, and no per-card "not enough history".
    expect(document.querySelector('[data-stat="agents"] [data-trend]')).toBeNull()
    expect(document.querySelector('[data-flow-missing]')).toHaveTextContent('Trends draw once')
    expect(document.body).not.toHaveTextContent('not enough history')
    // CI, opened to merged and merged to released are one line, each with its meaning on hover.
    expect(document.querySelector('[data-flow-part="ci"]')).toHaveTextContent('CI 7m 10s')
    // Each day says itself on hover.
    expect(document.querySelectorAll('[data-trend="throughput"] rect title').length).toBeGreaterThan(0)
  })

  it('opens a row in detail beside the list, its checks by runner and its log, and closes on Esc', async () => {
    connected()
    render(<PipelineView sessionId="s1" session={session} visible onBack={() => {}} />)
    await rowsDrawn()
    fireEvent.click(document.querySelector('[data-prs-row="21"] button')!)
    await waitFor(() => expect(h.asked).toContain('ci 21'))
    const detail = await waitFor(() => {
      const d = document.querySelector('[data-prs-pr="21"]')
      if (!d) throw new Error('no detail')
      return d
    })
    expect(document.querySelector('[data-prs-detail]')).toHaveAttribute('role', 'dialog')
    expect(document.querySelector('[data-prs-row="21"] button')).toHaveAttribute('aria-current', 'true')
    expect(detail.querySelector('[data-prs-diff]')).toHaveTextContent('+181 −59 · 13 files · 2 commits')
    expect(detail.querySelector('[data-prs-pill="merge"]')).toHaveTextContent('mergeable')
    const grid = await waitFor(() => {
      const g = detail.querySelector('[data-prs-grid]')
      if (!g) throw new Error('no grid')
      return g
    })
    expect(grid).toHaveTextContent('Linux')
    expect(grid).toHaveTextContent('macOS')
    expect(grid.querySelector('[data-prs-cell="72"]')).toHaveTextContent('failed at go test')
    expect(await screen.findByText('##[error]Process completed with exit code 1.')).toHaveClass('ci-error-line')
    fireEvent.click(screen.getByRole('button', { name: 'Investigate' }))
    await waitFor(() => expect(h.queued).toHaveLength(1))
    expect(h.queued[0]).toContain('go (macos-latest)')
    fireEvent.keyDown(document.querySelector('[data-prs-detail]')!, { key: 'Escape' })
    expect(document.querySelector('[data-prs-detail]')).toBeNull()
  })

  // A Work row's title links to #/pipeline?repo=…&pr=N (lib/work pipelineHref).
  it('opens the pull request the address names in detail as the page opens', async () => {
    connected()
    render(<PipelineView sessionId="s1" session={session} visible onBack={() => {}} pr={21} />)
    await rowsDrawn()
    await waitFor(() => expect(h.asked).toContain('ci 21'))
    await waitFor(() => expect(document.querySelector('[data-prs-detail]')).toHaveAttribute('aria-label', '#21 in detail'))
    expect(document.querySelector('[data-prs-row="21"] button')).toHaveAttribute('aria-current', 'true')
  })

  // Owner, 2026-10-15, translated: "I see the red 'NEEDS A FIX 4' figure,
  // but I can't see which PRs those are or whether they were fixed".
  it('opens the pull requests behind a count tile across the repository, says why each needs a fix, and clears back', async () => {
    connected()
    const st = h.stats as { prs: Record<string, unknown>[] } & Record<string, unknown>
    const pr = (number: number, title: string) => ({ number, url: `https://github.com/a/b/pull/${number}`, title, state: 'open' })
    st.prs = [pr(683, 'Ship the brain graph'), pr(680, 'Teams reporter'), pr(662, 'Mail OAuth'), pr(661, 'Work board'), pr(21, live.title), pr(22, 'Bump deps')]
    st.prs[1] = { ...st.prs[1], labels: [{ name: 'land-next', color: '0e8a16' }] }
    st.board = {
      default_branch: 'main',
      cards: [
        card(683, 'fix', { ci: 'fail', why: 'ci', failed: ['test (windows-latest)'] }),
        card(680, 'fix', { ci: 'pass', why: 'conflict' }), card(662, 'fix', { ci: 'pass', why: 'conflict' }), card(661, 'fix', { ci: 'pass', why: 'conflict' }),
        card(21, 'ready', { ci: 'pass' }), card(22, 'open', { ci: 'running' }),
      ],
      releases: [], flow: { ...FLOW, counts: { draft: 0, open: 1, fix: 4, ready: 1, merged: 0, released: 0 } },
    }
    // This session's one pull request is green: none of the four is in it.
    h.prs = { connected: true, prs: [{ session_id: 's1', url: live.url, number: 21, title: live.title, last_at: now, live: { ...live, checks: { ...live.checks, state: 'pass' } } }] }
    localStorage.setItem('caprock.prsTab.scope', 'session')
    render(<PipelineView sessionId="s1" session={session} visible onBack={() => {}} />)
    await rowsDrawn()
    expect(rowOrder()).toEqual(['21'])
    const tile = document.querySelector('[data-stat="fix"]') as HTMLElement
    expect(tile).toHaveAttribute('role', 'button')
    // Its hover names them with the reason.
    const preview = tile.querySelector('[data-bucket-preview="fix"]')!
    expect(preview).toHaveTextContent('#683')
    expect(preview).toHaveTextContent('Ship the brain graph')
    expect(preview).toHaveTextContent('CI red')
    expect(preview).toHaveTextContent('Conflict')
    fireEvent.click(tile)
    expect(tile).toHaveAttribute('aria-pressed', 'true')
    // The scope widened to the repository, the list holds only the four.
    expect(screen.getByRole('tab', { name: /Repository/ })).toHaveAttribute('aria-selected', 'true')
    expect(rowOrder().sort()).toEqual(['661', '662', '680', '683'])
    const chip = document.querySelector('[data-prs-filter="fix"]')!
    expect(chip).toHaveTextContent('Needs a fix · 4')
    const red = document.querySelector('[data-prs-row="683"] [data-journey-step="ci"]')!
    expect(red).toHaveTextContent('CI red')
    expect(red.getAttribute('title') ?? red.querySelector('[title]')?.getAttribute('title')).toContain('test (windows-latest)')
    expect(document.querySelector('[data-prs-row="680"] [data-journey-step="ci"]')).toHaveTextContent('Conflict')
    expect(document.querySelector('[data-prs-row="680"] [data-prs-label="land-next"]')).toBeInTheDocument()
    // × clears it and the list goes back to this session.
    fireEvent.click(document.querySelector('[data-prs-filter-clear]')!)
    expect(document.querySelector('[data-prs-filter]')).toBeNull()
    expect(screen.getByRole('tab', { name: /This session/ })).toHaveAttribute('aria-selected', 'true')
    expect(rowOrder()).toEqual(['21'])
    // A second click on the tile clears it too.
    fireEvent.click(document.querySelector('[data-stat="ready"]')!)
    expect(rowOrder()).toEqual(['21'])
    fireEvent.click(document.querySelector('[data-stat="ready"]')!)
    expect(document.querySelector('[data-prs-filter]')).toBeNull()
  })

  it('switches between this session’s, the repository’s and the open pull requests, remembering the choice', async () => {
    connected()
    render(<PipelineView sessionId="s1" session={session} visible onBack={() => {}} />)
    await rowsDrawn()
    expect(rowOrder()).toEqual(['22', '21', '20'])
    fireEvent.click(document.querySelector('[data-prs-scope="session"]')!)
    expect(rowOrder()).toEqual(['21'])
    fireEvent.click(document.querySelector('[data-prs-scope="open"]')!)
    expect(rowOrder()).toEqual(['22', '21'])
    expect(localStorage.getItem('caprock.prsTab.scope')).toBe('open')
    // A pull request that is not the session's is read when opened.
    fireEvent.click(within(document.querySelector('[data-prs-list]') as HTMLElement).getByText('Bump deps'))
    await waitFor(() => expect(h.asked).toContain('ci 22'))
  })

  it('shows ten released pull requests, then the rest on Show more', async () => {
    connected()
    const st = h.stats as Record<string, unknown>
    const merged = Array.from({ length: 12 }, (_, i) => ({ number: 100 + i, url: `https://github.com/a/b/pull/${100 + i}`, title: `Shipped ${i}`, state: 'merged', merged_at: now - i * 60_000 }))
    st.prs = merged
    st.board = { cards: merged.map((m) => card(m.number, 'released', { release: 'v2.0.0', stage_at: m.merged_at })), releases: [], flow: FLOW }
    render(<PipelineView sessionId="s1" session={session} visible onBack={() => {}} />)
    await rowsDrawn()
    const released = () => document.querySelectorAll('[data-prs-row][data-stage="released"]').length
    expect(released()).toBe(10)
    fireEvent.click(screen.getByRole('button', { name: 'Show 2 more released' }))
    expect(released()).toBe(12)
  })

  it('asks GitHub for nothing while GitHub is not connected, and says how to connect', async () => {
    h.stats = { connected: false, repo: 'a/b', prs: [] }
    h.prs = { connected: false, prs: [{ session_id: 's1', url: live.url, number: 21, title: live.title, last_at: now }] }
    render(<PipelineView sessionId="s1" session={session} visible onBack={() => {}} />)
    expect(await screen.findByRole('button', { name: 'Connect GitHub' })).toBeInTheDocument()
    expect(document.querySelector('[data-prs-list]')).toBeNull()
    expect(document.querySelector('[data-pipeline-share]')).toBeNull()
    expect(h.asked).not.toContain('usage')
  })

  // Owner, 2026-10-14: the board showed an afternoon answer at night behind a
  // bare "updating…" — merged pull requests in CI running, releases missing.
  it('says how old a kept list is while it is read again, draws its rows faint, and says a refused read with its time', async () => {
    const board = (stage: string) => ({
      default_branch: 'main', releases: [],
      cards: [card(22, stage, { ci: stage === 'open' ? 'running' : undefined, stage_at: now - 5 * 3_600_000 })],
      flow: FLOW,
    })
    connected()
    const fresh = h.stats as Record<string, unknown>
    const kept = now - 5 * 3_600_000
    writeDeck('stats:/w', { ...fresh, fetched_at: kept, read_at: kept, board: board('open') }, kept)
    let open = () => {}
    h.statsGate = new Promise<void>((r) => { open = r })
    h.stats = { ...fresh, fetched_at: Date.now(), read_at: Date.now(), board: board('merged') }
    const view = render(<PipelineView sessionId="s1" session={session} visible onBack={() => {}} />)
    // Cold start on the kept copy: its age, refreshing, the rows faint.
    const fresh0 = await waitFor(() => {
      const f = document.querySelector('[data-deck-fresh="updating"]')
      if (!f) throw new Error('no marker')
      return f
    })
    expect(fresh0.textContent).toBe('Saved 5 h ago · refreshing…')
    expect(document.querySelector('[data-prs-row="22"]')).toHaveAttribute('data-prs-unconfirmed')
    expect(document.querySelector('[data-prs-row="22"]')).toHaveAttribute('data-stage', 'open')
    // The fresh answer: the merge moves the row, the marker says it, the faint goes.
    open()
    await waitFor(() => expect(document.querySelector('[data-prs-row="22"]')).toHaveAttribute('data-stage', 'merged'))
    expect(document.querySelector('[data-deck-fresh]')).toHaveAttribute('data-deck-fresh', 'ok')
    expect(document.querySelector('[data-deck-fresh]')!.textContent).toMatch(/^Updated (just now|\\d+ s ago)$/)
    expect(document.querySelector('[data-prs-row="22"]')).not.toHaveAttribute('data-prs-unconfirmed')
    // GitHub refuses the list: the reason and the time of what is shown, and Retry.
    h.stats = { ...fresh, fetched_at: Date.now(), read_at: kept, board: board('merged'), error: { message: 'GitHub answered 502', kind: 'github' } }
    view.unmount()
    render(<PipelineView sessionId="s1" session={session} visible onBack={() => {}} />)
    const failed = await waitFor(() => {
      const f = document.querySelector('[data-deck-fresh="failed"]')
      if (!f) throw new Error('not failed')
      return f
    })
    // A 502 is GitHub's side: said plainly, the age in words, the raw reason
    // in the tooltip, and GitHub's own status page asked.
    expect(failed).toHaveTextContent('Couldn’t reach GitHub.')
    expect(failed).toHaveTextContent(/Showing data from \d+ h ago\./)
    expect(failed.getAttribute('title')).toContain('GitHub answered 502')
    expect(failed.querySelector('[data-gh-status]')).toBeInTheDocument()
    expect(failed.querySelector('[data-deck-fresh-retry]')).toBeInTheDocument()
    expect(document.querySelector('[data-prs-row="22"]')).toHaveAttribute('data-prs-unconfirmed')
  })

  it('lists the pull requests from an older daemon’s answer too, with no flow strip', async () => {
    connected()
    render(<PipelineView sessionId="s1" session={session} visible onBack={() => {}} />)
    await rowsDrawn()
    expect(document.querySelector('[data-board-flow]')).toBeNull()
    expect(rowOrder()).toEqual(['22', '21', '20'])
    expect(document.querySelector('[data-prs-row="20"] [data-journey-step="merged"]')).toHaveAttribute('data-step-state', 'current')
  })

  it('asks nothing while it is not in front, and goes back to where ⌘P was pressed', async () => {
    connected()
    const back = vi.fn()
    render(<PipelineView sessionId="s1" session={session} visible={false} onBack={back} />)
    await new Promise((r) => setTimeout(r, 20))
    expect(h.asked).toEqual([])
    const b = screen.getByRole('button', { name: /^Back to where you were/ })
    expect(b).toHaveAttribute('data-prs-back')
    expect(b).toHaveTextContent(/^Back (⌘P|Ctrl\+Shift\+P)$/)
    fireEvent.click(b)
    expect(back).toHaveBeenCalledTimes(1)
  })
})
