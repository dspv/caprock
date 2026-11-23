/**
 * Fix CI on any open pull request with a real failure (owner, 2026-11-23:
 * #1042 failed three Go jobs; the lead session opened it from a branch a
 * subagent's worktree pushed, so it was not among the session's own pull
 * requests, and no Fix CI showed anywhere). Unfolded, its row reads its
 * checks and offers Fix CI; folded, it leads the line over the session's
 * own green one, Fix CI beside it. With nothing in flight the block stays,
 * one quiet line. GitHub is not connected on the stand: every GitHub answer
 * is stubbed at the page, so nothing is ever sent to GitHub.
 */
import { expect, test } from './fixtures'

const now = Date.now()
const json = (b: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) })
const check = (id: number, name: string, state: string) => ({ name, state, status: 'completed', job_id: id,
  url: `https://github.com/acme/app/actions/runs/7/job/${id}`, started_at: now - 600_000, completed_at: now - 20_000 })
const FAILED = { state: 'fail', passed: 1, failed: 3, pending: 0, items: [check(1, 'lint', 'pass'), check(2, 'go (ubuntu-latest)', 'fail'), check(3, 'go (macos-latest)', 'fail'), check(4, 'go (windows-latest)', 'fail')] }
const PASSED = { state: 'pass', passed: 2, failed: 0, pending: 0, items: [check(5, 'lint', 'pass'), check(6, 'go (ubuntu-latest)', 'pass')] }
const live = (n: number, title: string, checks: object) => ({ number: n, url: `https://github.com/acme/app/pull/${n}`, title, state: 'open', draft: false,
  review: '', reviews: [], branch: `feat/${n}`, base: 'master', mergeable: true, mergeable_state: 'unstable', head_sha: `sha${n}`, checks, at: now })
const SPEND = { cost_usd: 0, sessions: 0, live: 0, agents: [] }
const FLOW = { counts: {}, days: 14, merged: 1, ttm_count: 0, release_lag_count: 0, cost_usd: 0 }
const STATS = { connected: true, repo: 'acme/app', fetched_at: now, read_at: now,
  prs: [
    { number: 1044, url: 'https://github.com/acme/app/pull/1044', title: 'fix(ui): own green one', state: 'open', created_at: now - 300_000 },
    { number: 1042, url: 'https://github.com/acme/app/pull/1042', title: 'feat(spawn): effort at start', state: 'open', created_at: now - 5_340_000 },
  ],
  board: { cards: [
    { number: 1044, stage: 'ready', ci: 'pass', stage_at: now - 300_000, spend: SPEND },
    { number: 1042, stage: 'fix', ci: 'fail', why: 'ci', stage_at: now - 5_340_000, spend: { cost_usd: 33.72, sessions: 1, live: 0, agents: ['claude'] } },
  ], releases: [], flow: FLOW, ships_by: 'release' } }
const QUIET = { connected: true, repo: 'acme/app', fetched_at: now, read_at: now,
  prs: [{ number: 1041, url: 'https://github.com/acme/app/pull/1041', title: 'chore(release): 0.191.0', state: 'merged', created_at: now - 9_000_000, merged_at: now - 7_200_000 }],
  board: { cards: [{ number: 1041, stage: 'merged', stage_at: now - 7_200_000, spend: SPEND }],
    releases: [{ tag: 'v0.191.0', published_at: now - 3_600_000, prs: [], cost_usd: 0, sessions: 0 }], flow: FLOW, ships_by: 'release' } }

test('Fix CI is offered on a failing PR the session did not record, unfolded and folded; nothing in flight is one line', async ({ app, page }) => {
  test.setTimeout(90_000)
  let stats: object = STATS
  let own = true
  await page.route(/\/v1\/sessions\/[^/]+\/ci\/stats$/, (r) => r.fulfill(json(stats)))
  await page.route(/\/v1\/sessions\/([^/]+)\/prs$/, (r) => {
    const id = /\/v1\/sessions\/([^/]+)\/prs$/.exec(r.request().url())![1]
    if (!own) return r.fulfill(json({ connected: true, fetched_at: Date.now(), prs: [] }))
    return r.fulfill(json({ connected: true, fetched_at: Date.now(), prs: [{ session_id: id, number: 1044, url: 'https://github.com/acme/app/pull/1044', title: 'fix(ui): own green one', last_at: now, live: live(1044, 'fix(ui): own green one', PASSED) }] }))
  })
  await page.route(/\/v1\/sessions\/[^/]+\/ci\?pr=(\d+)$/, (r) => {
    const n = Number(/pr=(\d+)$/.exec(r.request().url())![1])
    return r.fulfill(json({ connected: true, fetched_at: Date.now(), pr: { number: n, url: `https://github.com/acme/app/pull/${n}`, repo: 'acme/app',
      live: n === 1042 ? live(1042, 'feat(spawn): effort at start', FAILED) : live(n, 'fix(ui): own green one', PASSED) } }))
  })
  await page.addInitScript(() => {
    if (!localStorage.getItem('caprock.app.cockpit-looks')) localStorage.setItem('caprock.app.cockpit-looks', JSON.stringify({ ci: 'full', release: 'compact', changes: 'compact', processes: 'compact', tasks: 'compact', now: 'compact' }))
    localStorage.setItem('caprock.cockpit.ciView', 'dots')
  })
  await app.open()
  const alpha = app.session('alpha')
  await app.openSession('alpha').catch(async () => { await app.row(alpha.name).first().click() })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })

  // Unfolded: #1042's row reads its checks and offers Fix CI.
  const row = inspector.locator('[data-cockpit-ci-pr="1042"]')
  await expect(row).toBeVisible()
  await expect(row.locator('[data-cockpit-ci-action="ci"]')).toHaveText('Fix CI')
  await expect(row.locator('[data-cockpit-ci-row-checks="1042"]')).toBeVisible()
  await expect(inspector.locator('[data-cockpit-ci-pr="1044"] [data-cockpit-ci-action]')).toHaveCount(0)

  // Folded: the failing PR leads the line, Fix CI beside it.
  await inspector.locator('section[aria-label="CI"] button[aria-expanded="true"]').first().click()
  const fold = inspector.locator('[data-cockpit-ci-fold]')
  await expect(fold).toHaveAttribute('data-cockpit-ci-fold', '1042')
  await expect(fold.locator('[data-cockpit-ci-fold-action="ci"]')).toHaveText('Fix CI')

  // Nothing in flight: the block stays, one quiet line folded.
  stats = QUIET
  own = false
  await page.reload()
  await expect(inspector.locator('section[aria-label="CI"]')).toBeVisible()
  await expect(inspector.locator('[data-cockpit-ci-fold-quiet]')).toContainText('Nothing in flight · last: #1041 merged 2h ago')
})
