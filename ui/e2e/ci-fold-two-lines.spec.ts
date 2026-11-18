/**
 * The folded CI block is two lines (owner, 2026-11-18): the PR it
 * summarizes — number and title, cut with an ellipsis — and the age on the
 * first; its checks and the one action the state calls for on the second
 * (Fix CI on a real failure, Rerun and the switch on a job GitHub never gave
 * a machine, nothing while running or green). From 280 to 460 px nothing
 * passes the panel's edge and there is never a third line. GitHub is not
 * connected on the stand: the session's pull requests and the Pipeline
 * answer are stubbed at the page, so nothing is ever sent to GitHub.
 *
 * With CAPROCK_SHOTS_DIR set it photographs each state at 324 and 460 px.
 */
import path from 'node:path'
import { expect, test } from './fixtures'

const now = Date.now()
const json = (b: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) })
const check = (id: number, name: string, state: string, extra: object = {}) => ({ name, state, status: 'completed', job_id: id,
  url: `https://github.com/acme/app/actions/runs/44324234291/job/${id}`, started_at: now - 600_000, completed_at: now - 20_000, ...extra })
const pass = (n: number) => Array.from({ length: n }, (_, i) => check(100 + i, `check ${i}`, 'pass'))
const skip = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `skip ${i}`, state: 'skipped' }))
const STATES: Record<string, { checks: object; action: string | null }> = {
  failed: { checks: { state: 'fail', passed: 11, failed: 1, pending: 0, items: [check(1, 'go (ubuntu-latest)', 'fail'), ...pass(11), ...skip(2)] }, action: 'ci' },
  'no-runner': { checks: { state: 'no_runner', passed: 12, failed: 0, pending: 0, no_runner: 1, items: [check(2, 'go (macos-latest)', 'fail', { no_runner: true }), ...pass(12), ...skip(2)] }, action: 'rerun' },
  running: { checks: { state: 'pending', passed: 9, failed: 0, pending: 3, items: [
    { ...check(3, 'go (windows-latest)', 'pending'), status: 'in_progress', completed_at: undefined },
    { ...check(4, 'go (macos-latest)', 'pending'), status: 'queued', started_at: undefined, completed_at: undefined },
    { ...check(5, 'e2e', 'pending'), status: 'queued', started_at: undefined, completed_at: undefined }, ...pass(9), ...skip(2)] }, action: null },
  green: { checks: { state: 'pass', passed: 13, failed: 0, pending: 0, items: [...pass(13), ...skip(2)] }, action: null },
}
const TITLE = 'feat(ci): rerun jobs GitHub never ran, and say so on the line'
const live = (checks: object) => ({ number: 944, url: 'https://github.com/acme/app/pull/944', title: TITLE, state: 'open', draft: false,
  review: '', reviews: [], branch: 'feat/ci-auto-rerun', base: 'master', mergeable: true, mergeable_state: 'unstable', head_sha: '98c0e765', checks, at: now })
const STATS = { connected: true, repo: 'acme/app', fetched_at: now, read_at: now,
  prs: [{ number: 944, url: 'https://github.com/acme/app/pull/944', title: TITLE, state: 'open', created_at: now - 1_800_000 }],
  board: { cards: [{ number: 944, stage: 'open', stage_at: now - 900_000, spend: { cost_usd: 0.42, sessions: 1, live: 0, agents: ['claude'] } }],
    releases: [], flow: { counts: {}, days: 14, merged: 1, ttm_count: 0, release_lag_count: 0, cost_usd: 0 }, ships_by: 'release' } }
const STATUS = { connected: true, source: 'token', user: { login: 'ada' }, scopes: ['repo'], scopes_known: true, token_kind: 'classic',
  sources: { gh: false, stored: true, store: 'file', oauth: false }, health: { last_ok_at: now }, notify: true, auto_rerun: false, tracked: 0 }

const shotsDir = process.env.CAPROCK_SHOTS_DIR ? path.resolve(process.env.CAPROCK_SHOTS_DIR) : ''

test('folded CI is two lines in every state, with the one action that fits, and nothing past the edge', async ({ app, page }) => {
  test.setTimeout(120_000)
  let state = 'failed'
  await page.route(/\/v1\/github$/, (r) => r.fulfill(json(STATUS)))
  await page.route(/\/v1\/sessions\/[^/]+\/ci\/stats$/, (r) => r.fulfill(json(STATS)))
  await page.route(/\/v1\/sessions\/([^/]+)\/prs$/, (r) => {
    const id = /\/v1\/sessions\/([^/]+)\/prs$/.exec(r.request().url())![1]
    return r.fulfill(json({ connected: true, fetched_at: Date.now(), prs: [{ session_id: id, number: 944, url: 'https://github.com/acme/app/pull/944', title: TITLE, last_at: now, live: live(STATES[state]!.checks) }] }))
  })
  await page.addInitScript(() => {
    if (!localStorage.getItem('caprock.app.cockpit-looks')) localStorage.setItem('caprock.app.cockpit-looks', JSON.stringify({ ci: 'compact', release: 'compact', changes: 'compact', processes: 'compact', tasks: 'compact', now: 'compact' }))
  })
  await app.open()
  const alpha = app.session('alpha')
  await app.openSession('alpha').catch(async () => { await app.row(alpha.name).first().click() })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  const frame = inspector.locator('[data-section-frame="ci"]')
  const pastEdge = () => page.evaluate(() => {
    const head = document.querySelector('section[aria-label="CI"] [data-section-head]') as HTMLElement
    const edge = head.getBoundingClientRect().right + 0.5
    const out: string[] = []
    for (const el of head.querySelectorAll<HTMLElement>('span, button, label')) {
      if (el.closest('.invisible') || el.offsetWidth === 0) continue
      const r = el.getBoundingClientRect()
      if (r.right > edge) out.push(`"${el.textContent}" ends at ${Math.round(r.right)} > ${Math.round(edge)}`)
    }
    return out
  })
  // Two lines at most: the head is no taller than its two rows.
  const lines = () => page.evaluate(() => {
    const head = document.querySelector('section[aria-label="CI"] [data-section-head]') as HTMLElement
    return Array.from(head.children).map((c) => Math.round((c as HTMLElement).getBoundingClientRect().height))
  })

  for (const name of Object.keys(STATES)) {
    state = name
    await page.reload()
    await expect(app.tabs.getByRole('tab', { name: new RegExp(`^${alpha.name}`), selected: true })).toBeVisible()
    const fold = inspector.locator('[data-cockpit-ci-fold]')
    await expect(fold).toHaveAttribute('data-cockpit-ci-fold', '944')
    await expect(inspector.locator('[data-cockpit-ci-fold-pr="944"]')).toContainText(TITLE.slice(0, 12))
    const act = fold.locator('[data-cockpit-ci-fold-action]')
    if (STATES[name]!.action) await expect(act).toHaveAttribute('data-cockpit-ci-fold-action', STATES[name]!.action!)
    else await expect(act).toHaveCount(0)
    for (const w of [280, 300, 324, 360, 400, 460]) {
      await page.evaluate((px) => document.documentElement.style.setProperty('--app-inspector-w', `${px}px`), w)
      await page.waitForTimeout(250)
      expect(await pastEdge(), `${name} at ${w}px`).toEqual([])
      const hs = await lines()
      expect(hs.length, `${name} at ${w}px`).toBe(2)
      for (const h of hs) expect(h, `${name} at ${w}px: one line each`).toBeLessThan(26)
      if (shotsDir && (w === 324 || w === 460)) await frame.screenshot({ path: path.join(shotsDir, `fold-${name}-${w}.png`) })
    }
  }
})
