import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReposCI, RepoCIRow } from '@/lib/reposci'

const h = vi.hoisted(() => ({ answer: undefined as unknown, asked: 0, usage: [] as string[], q: [] as unknown[], stats: [] as string[] }))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api,
    sessionCIStats: async (id: string) => {
      h.stats.push(id)
      return { connected: true, repo: 'ada/app', fetched_at: Date.now(), prs: [], board: { cards: [], releases: [], flow: { counts: { draft: 1, open: 2, fix: 1, ready: 3, merged: 0, released: 0 }, days: 14, merged: 14, ttm_count: 0, release_lag_count: 0, ci_median_ms: 430_000, cost_usd: 0,
        // Every earlier day's CI median 7m 10s, today's 10m: longer, amber.
        series: { ci: Array.from({ length: 14 }, (_, i) => ({ day: `2026-10-${String(i + 1).padStart(2, '0')}`, value: i === 13 ? 600_000 : 430_000, n: 3 })) } } } }
    },
    reposCI: async (q?: unknown) => { h.asked++; h.q.push(q); return typeof h.answer === 'function' ? (h.answer as (q: unknown) => unknown)(q) : h.answer },
    actionsUsage: async (owner?: string) => {
      h.usage.push(owner ?? '')
      return { account: owner, org: false, year: 2026, month: 10, available: false, reason: 'permission', minutes: 0, gross_usd: 0, discount_usd: 0, net_usd: 0, by_sku: [], at: 0 }
    },
  } }
})

import { CICDPanel } from './CICDPanel'
import { PANEL_FOLDS_KEY } from './ui'
import { forgetDeckAnswers } from '@/lib/deckCache'
import { compactTokens, HIDDEN_REPOS_KEY, keepWhileReading, prTokens, quietText, redPct, rowErrorText, sectionErrorText, statusLine, stuckText } from '@/lib/reposci'
import { spanText } from '@/lib/prstats'
import type { SessionSummary } from '@/lib/api'

const now = Date.now()
const days = Array.from({ length: 14 }, (_, i) => new Date(now - (13 - i) * 86_400_000).toISOString().slice(0, 10))
const row = (p: Partial<RepoCIRow>): RepoCIRow => ({
  project_id: 1, name: 'app', repo: 'ada/app', live: 2, days, stuck: [], open: 3, merged_7d: 9, top_prs: [], authors: [],
  ci: { runs: 50, red: 4, reruns: 2, listed: 100, per_day: Array.from({ length: 14 }, () => ({ runs: 3, red: 0 })), workflows: [{ name: 'ci', runs: 40, red: 4, median_ms: 430_000, median_runs: 36, daily_median_ms: Array(14).fill(430_000) }] },
  ...p,
})

afterEach(() => { h.answer = undefined; h.asked = 0; h.usage = []; h.q = []; h.stats = []; forgetDeckAnswers(); localStorage.clear() })

describe('the CI/CD section', () => {
  it('shows each repository’s CI, stuck runs, release, the costliest pull requests and who opened them', async () => {
    h.answer = {
      github_connected: true,
      status: { indicator: 'minor', description: 'Partially Degraded Service', components: [{ name: 'Actions', status: 'degraded_performance' }, { name: 'API Requests', status: 'operational' }], incidents: [{ name: 'Delayed Actions runs', status: 'investigating', url: 'https://stspg.io/x' }], at: now },
      repos: [row({
        stuck: [{ id: 7, name: 'ci', branch: 'feat/x', status: 'in_progress', since: now - 41 * 60_000, median_ms: 9 * 60_000, url: 'https://github.com/ada/app/actions/runs/7' }],
        release: { tag: 'v1.2.0', published_at: now - 2 * 3_600_000, url: 'https://github.com/ada/app/releases/tag/v1.2.0' },
        top_prs: [{ number: 41, title: 'Kanban board', url: 'https://github.com/ada/app/pull/41', state: 'open', author: 'grace', author_avatar: 'https://avatars.githubusercontent.com/u/2', cost_usd: 18.25, sessions: 3, live: 1 }],
        authors: [{ login: 'grace', avatar: 'https://avatars.githubusercontent.com/u/2', prs: 2, merged: 1, cost_usd: 18.25 }, { login: 'ada', prs: 1, merged: 1, cost_usd: 0 }],
      })],
      quiet: [],
    } satisfies ReposCI
    render(<CICDPanel />)
    const block = await waitFor(() => {
      const b = document.querySelector('[data-cicd-repo="ada/app"]')
      if (!b) throw new Error('no block')
      return b
    })
    expect(document.querySelector('[data-cicd-status]')).toHaveAttribute('data-cicd-status', 'warn')
    expect(document.querySelector('[data-cicd-status]')).toHaveTextContent('GitHub: Actions degraded')
    expect(document.querySelector('[data-cicd-status]')).toHaveTextContent('Delayed Actions runs')
    expect(block.querySelector('[data-cicd-cell="ci"]')).toHaveTextContent('7m 10s')
    expect(block.querySelector('[data-cicd-cell="red"]')).toHaveTextContent('8%')
    expect(block.querySelector('[data-cicd-cell="stuck"]')).toHaveTextContent('1')
    expect(block.querySelector('[data-cicd-cell="stuck"]')).toHaveTextContent('ci on feat/x running 41m, median 9m')
    expect(block).toHaveTextContent('released v1.2.0')
    expect(block.querySelector('[data-cicd-top]')).toHaveTextContent('#41')
    expect(block.querySelector('[data-cicd-top]')).toHaveTextContent('$18.25')
    expect(block.querySelector('[data-cicd-who]')).toHaveTextContent('grace')
    expect(block.querySelector('[data-cicd-who] img')).toHaveAttribute('src', 'https://avatars.githubusercontent.com/u/2')
    // ada has no avatar: initials stand in, nothing loaded.
    expect(block.querySelectorAll('[data-cicd-who] img')).toHaveLength(1)
    // The Actions bill is asked once per owner; without Plan (read) it says how to grant it.
    await waitFor(() => expect(block.querySelector('[data-cicd-cell="usage"]')).toHaveTextContent('grant Plan (read) to see it'))
    expect(h.usage).toEqual(['ada'])
  })

  it('asks nothing folded, and says how to connect GitHub', async () => {
    localStorage.setItem(PANEL_FOLDS_KEY, JSON.stringify(['now.cicd']))
    h.answer = { github_connected: false, repos: [] }
    render(<CICDPanel />)
    await new Promise((r) => setTimeout(r, 20))
    expect(h.asked).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: /CI\/CD/ }))
    expect(await screen.findByText(/Connect GitHub in Settings/)).toBeInTheDocument()
    expect(h.asked).toBe(1)
    expect(h.usage).toEqual([])
  })

  it('folds older and hidden repositories into one line, reads them only when shown, and hides a row from its menu', async () => {
    h.answer = (q: { older?: boolean; hide?: string[] } | undefined) => ({
      github_connected: true,
      recent_days: 14,
      repos: [
        row({ project_id: 1, name: 'app', repo: 'ada/app' }),
        row({ project_id: 2, name: 'site', repo: 'ada/site', live: 0, last_active: now - 3 * 86_400_000 }),
        ...(q?.older ? [row({ project_id: 3, name: 'bloq', repo: 'ada/bloq', live: 0, older: true, last_active: now - 200 * 86_400_000 })] : []),
      ].filter((r) => !(q?.hide ?? []).includes(r.repo)),
      quiet: [
        ...(q?.older ? [] : [{ project_id: 3, name: 'bloq', repo: 'ada/bloq', last_active: now - 200 * 86_400_000, why: 'older' }]),
        { project_id: 4, name: 'amarketer', repo: 'ada/amarketer', last_active: now - 90 * 86_400_000, why: 'older' },
        ...(q?.hide ?? []).map((r) => ({ project_id: 9, name: r.split('/')[1], repo: r, why: 'hidden' })),
      ].filter((x) => !(q?.older && x.why === 'older' && x.repo === 'ada/bloq')),
    })
    render(<CICDPanel />)
    const line = await screen.findByText(/2 older repositories/)
    expect(document.querySelector('[data-cicd-repo="ada/bloq"]')).toBeNull()
    expect(h.q[0]).toEqual({ older: false, hide: [] })
    // Hide one from its menu: gone at once, remembered, and the next ask names it.
    fireEvent.click(screen.getByRole('button', { name: 'site: actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Hide from CI\/CD/ }))
    expect(document.querySelector('[data-cicd-repo="ada/site"]')).toBeNull()
    expect(JSON.parse(localStorage.getItem(HIDDEN_REPOS_KEY) ?? '[]')).toEqual(['ada/site'])
    await waitFor(() => expect(h.q.at(-1)).toEqual({ older: false, hide: ['ada/site'] }))
    await waitFor(() => expect(document.querySelector('[data-cicd-quiet]')).toHaveTextContent('2 older repositories · 1 hidden'))
    // Shown: the older one is read and drawn; the hidden one can come back.
    fireEvent.click(document.querySelector('[data-cicd-quiet] button')!)
    await waitFor(() => expect(document.querySelector('[data-cicd-repo="ada/bloq"]')).not.toBeNull())
    expect(h.q.at(-1)).toEqual({ older: true, hide: ['ada/site'] })
    fireEvent.click(screen.getByRole('button', { name: 'Show again' }))
    await waitFor(() => expect(document.querySelector('[data-cicd-repo="ada/site"]')).not.toBeNull())
    expect(JSON.parse(localStorage.getItem(HIDDEN_REPOS_KEY) ?? '[]')).toEqual([])
    expect(line).toBeTruthy()
  })

  it('says a slow GitHub calmly, once for the section when every row is the same', async () => {
    const slow = { message: 'could not reach GitHub (api.github.com): context deadline exceeded. Check the connection; Caprock tries again later.', kind: 'network' }
    h.answer = { github_connected: true, repos: [row({ repo: 'ada/a', project_id: 1, slow: true, error: slow, ci: undefined }), row({ repo: 'ada/b', project_id: 2, slow: true, error: slow, ci: undefined })], quiet: [] }
    render(<CICDPanel />)
    expect(await screen.findByText('GitHub didn’t answer in time — retrying')).toBeInTheDocument()
    expect(document.querySelectorAll('[data-cicd-error]')).toHaveLength(0)
    expect(document.body).not.toHaveTextContent('context deadline exceeded')
  })

  it('puts the tokens beside a pull request’s cost, and marks a shared session', async () => {
    h.answer = { github_connected: true, quiet: [], repos: [row({ top_prs: [{ number: 601, title: 'chore(release)', url: 'u', state: 'open', cost_usd: 2.12, sessions: 1, live: 0, shared: 1, tokens_in: 74, tokens_out: 5431, cache_read: 9_388_958, cache_write: 23_881 }] })] }
    render(<CICDPanel />)
    const tok = await waitFor(() => {
      const t = document.querySelector('[data-cicd-tokens]')
      if (!t) throw new Error('no tokens')
      return t
    })
    expect(tok).toHaveTextContent('9.4M tok')
    expect(tok.getAttribute('title')).toMatch(/cache read 9.4M/)
    expect(document.querySelector('[data-cicd-shared]')?.getAttribute('title')).toMatch(/also worked on other pull requests/)
  })

  it('keeps the figures already drawn while a new ask is read', () => {
    const prev = { github_connected: true, quiet: [], status: { indicator: 'none', description: 'ok', components: [], incidents: [], at: 0 }, repos: [row({ repo: 'ada/app', open: 7 })] }
    const next = { github_connected: true, quiet: [], refreshing: true, repos: [row({ repo: 'ada/app', open: 0, pending: true, ci: undefined }), row({ repo: 'ada/old', pending: true, older: true })] }
    const got = keepWhileReading(prev, next)
    expect(got.repos[0]).toMatchObject({ repo: 'ada/app', open: 7 })
    expect(got.repos[0]!.pending).toBeFalsy()
    expect(got.repos[1]).toMatchObject({ repo: 'ada/old', pending: true })
    expect(got.status?.description).toBe('ok')
  })

  it('says the quiet parts in words', () => {
    expect(compactTokens(412_300_000)).toBe('412.3M')
    expect(compactTokens(18_000)).toBe('18k')
    expect(compactTokens(950)).toBe('950')
    expect(prTokens({ number: 1, url: '', state: 'open', cost_usd: 0, sessions: 0, live: 0 })).toBeUndefined()
    expect(quietText([], 14)).toBeUndefined()
    expect(quietText([{ project_id: 1, name: 'a', repo: 'o/a', why: 'older' }], 14)?.text).toBe('1 older repository')
    expect(rowErrorText({ error: { message: 'Bad credentials', kind: 'auth' } })).toBe('Bad credentials')
    expect(rowErrorText({ error: { message: 'x', kind: 'network' } })).toBe('GitHub not reachable — retrying')
    const r = row({ error: { message: 'x', kind: 'network' } })
    expect(sectionErrorText([r, row({})])).toBeUndefined()
    expect(sectionErrorText([r, r])).toBe('GitHub not reachable — retrying')
  })

  it('says GitHub’s status, red share and stuck runs in words', () => {
    expect(statusLine({ indicator: 'none', description: 'All Systems Operational', components: [{ name: 'Actions', status: 'operational' }], incidents: [], at: 0 })?.tone).toBe('ok')
    expect(statusLine({ indicator: 'major', description: 'Major Outage', components: [{ name: 'Git Operations', status: 'major_outage' }], incidents: [], at: 0 })?.text).toBe('GitHub: Git Operations down')
    expect(statusLine({ indicator: '', description: '', components: [], incidents: [], at: 0, error: 'could not reach githubstatus.com' })?.tone).toBe('faint')
    expect(redPct({ runs: 47, red: 3, reruns: 0, listed: 100, per_day: [], workflows: [] })).toBe('6.4%')
    expect(redPct({ runs: 0, red: 0, reruns: 0, listed: 0, per_day: [], workflows: [] })).toBeUndefined()
    expect(stuckText({ id: 1, name: 'release', status: 'queued', since: now - 22 * 60_000 }, now, spanText)).toBe('release waiting for a runner 22m')
  })
})

// Owner, 2026-10-15, translated: "so that metrics from it can be
// harmoniously put into the Dashboard". The Pipeline's own figures head the
// CI/CD panel — not a second CI block — for the repository it shows.
describe('the Pipeline in the CI/CD section', () => {
  const agent = (id: string, root: string, at: number) => ({ session_id: id, cwd: root, repo_root: root, project: root.split('/').pop(), status: 'active', last_event_at: at }) as unknown as SessionSummary
  const connected = { github_connected: true, repos: [row({})], quiet: [] } satisfies ReposCI

  it('shows in flight, needing a fix, ready, throughput and the CI median, read through the newest agent, and links to the page', async () => {
    h.answer = connected
    localStorage.setItem('caprock.pipeline.repo', '/w/app')
    render(<CICDPanel sessions={[agent('old', '/w/app', 1), agent('new', '/w/app', 5), agent('other', '/w/site', 9)]} />)
    const card = await waitFor(() => {
      const c = document.querySelector('[data-pipeline-card]')
      if (!c) throw new Error('no card')
      return c
    })
    expect(h.stats).toEqual(['new'])
    expect(card).toHaveTextContent('ada/app')
    expect(card.querySelector('[data-stat="flight"]')).toHaveTextContent('7')
    expect(card.querySelector('[data-stat="fix"]')).toHaveTextContent('1')
    expect(card.querySelector('[data-stat="ready"]')).toHaveTextContent('3')
    expect(card.querySelector('[data-stat="throughput"]')).toHaveTextContent('1.0/day')
    expect(card.querySelector('[data-stat="ci"]')).toHaveTextContent('7m 10s')
    expect(card.querySelector('[data-stat="cost"]')).toBeNull()
    // The same tiles as the page: the CI median's last 14 days and today
    // against them; a figure without a series in the answer has no line.
    const word = card.querySelector('[data-trend="ci"] [data-compare]')!
    expect(word).toHaveTextContent('above usual +40%')
    expect(word).toHaveAttribute('data-tone', 'warn')
    expect(card.querySelector('[data-stat="flight"] [data-trend]')).toBeNull()
    expect(card.querySelector('[data-pipeline-open]')).toHaveAttribute('href', '#/pipeline?repo=%2Fw%2Fapp')
  })

  it('is not drawn, and asks nothing, without an agent session or with GitHub not connected', async () => {
    h.answer = connected
    const first = render(<CICDPanel sessions={[]} />)
    await waitFor(() => expect(document.querySelector('[data-cicd-repo]')).toBeInTheDocument())
    expect(document.querySelector('[data-pipeline-card]')).toBeNull()
    expect(h.stats).toEqual([])
    first.unmount()
    forgetDeckAnswers()
    localStorage.clear()
    h.answer = { github_connected: false, repos: [] }
    render(<CICDPanel sessions={[agent('a', '/w/app', 1)]} />)
    await waitFor(() => expect(document.querySelector('[data-cicd="off"]')).toBeInTheDocument())
    expect(h.stats).toEqual([])
  })
})
