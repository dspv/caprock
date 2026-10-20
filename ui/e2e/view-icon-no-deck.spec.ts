/**
 * The agent tab's one view icon and the session deck's removal (owner,
 * 2026-10-20), driven against the sandboxed stand: the icon flips chat and
 * terminal, there is no deck and ⌘B (Ctrl+Shift+B off macOS) does nothing,
 * and a failing pull request of the session offers its one action in the
 * inspector's CI block, asking first. GitHub is not connected on the stand,
 * so the session's pull requests and the Pipeline's answer are stubbed at
 * the page; the queue the action writes to is stubbed too, so nothing is
 * typed into the fake claude.
 */
import { expect, test } from './fixtures'

const now = Date.now()
const json = (b: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) })

test('the view icon flips chat and terminal, and there is no session deck', async ({ app, page }) => {
  await app.open()
  const s = await app.openSession('alpha').catch(async () => {
    // Earlier scenarios may have typed into it: the tab is what counts.
    const x = app.session('alpha')
    await app.row(x.name).first().click()
    return x
  })
  const icon = page.locator('[data-view-switch]')
  await expect(icon).toHaveCount(1)
  await expect(icon).toHaveAttribute('aria-label', 'Show as chat')
  await expect(icon).toHaveText('')
  await icon.click()
  await expect(page.locator('[data-chat-view]')).toBeVisible()
  await expect(icon).toHaveAttribute('aria-label', 'Show as terminal')
  await icon.click()
  await expect(page.locator('[data-chat-view]')).toHaveCount(0)
  await expect(icon).toHaveAttribute('aria-label', 'Show as chat')

  await expect(page.locator('[data-deck-toggle]')).toHaveCount(0)
  const before = await page.evaluate(() => location.hash)
  await app.chord('b')
  await page.waitForTimeout(300)
  await expect(page.locator('[data-deck]')).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Session deck' })).toHaveCount(0)
  expect(await page.evaluate(() => location.hash)).toBe(before)
  await expect(app.tabs.getByRole('tab', { name: new RegExp(`^${s.name}`), selected: true })).toBeVisible()
})

test('a failing pull request of the session offers Fix CI in the inspector, asks once, and opens its log in the Pipeline', async ({ app, page }) => {
  const s = app.session('alpha')
  const live = {
    number: 9, url: 'https://github.com/a/b/pull/9', title: 'Fix the login', state: 'open', draft: false, review: '', reviews: [],
    branch: 'feat/login', base: 'main', mergeable: true, merge_state: 'clean', head_sha: 'abc', created_at: now - 3_600_000,
    checks: { state: 'fail', passed: 1, failed: 1, pending: 0, items: [{ name: 'lint', state: 'pass' }, { name: 'go (windows-latest)', state: 'fail' }] },
  }
  const stats = {
    connected: true, repo: 'a/b', fetched_at: now, read_at: now,
    prs: [{ number: 9, url: live.url, title: live.title, state: 'open', created_at: live.created_at }],
    board: {
      cards: [{ number: 9, stage: 'fix', ci: 'fail', why: 'ci', stage_at: now - 600_000, spend: { cost_usd: 1.25, sessions: 2, live: 0, agents: ['claude'] } }],
      releases: [], flow: { counts: {}, days: 14, merged: 0, ttm_count: 0, release_lag_count: 0, cost_usd: 1.25 }, ships_by: 'release',
    },
  }
  const queued: string[] = []
  await page.route(`**/v1/sessions/${s.id}/prs`, (r) => r.fulfill(json({ connected: true, prs: [{ session_id: s.id, number: 9, url: live.url, title: live.title, last_at: now, live }] })))
  await page.route(`**/v1/sessions/${s.id}/ci/stats`, (r) => r.fulfill(json(stats)))
  await page.route(`**/v1/sessions/${s.id}/ci?pr=9`, (r) => r.fulfill(json({ connected: true, pr: { number: 9, live }, ci: null })))
  await page.route(`**/v1/sessions/${s.id}/ci/main`, (r) => r.fulfill(json({ connected: false })))
  await page.route(`**/v1/sessions/${s.id}/ci/release`, (r) => r.fulfill(json({ connected: false })))
  await page.route(`**/v1/agents/${s.id}/queue`, (r) => {
    if (r.request().method() !== 'POST') return r.fallback()
    queued.push(r.request().postData() ?? '')
    return r.fulfill(json({ sent: false, queued: 1 }))
  })
  await app.open()
  await app.row(s.name).first().click()
  await expect(app.tabs.getByRole('tab', { name: new RegExp(`^${s.name}`), selected: true })).toBeVisible()

  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  const row = inspector.locator('[data-cockpit-ci-pr="9"]')
  await expect(row).toBeVisible()
  const action = row.locator('[data-cockpit-ci-action]')
  await expect(action).toHaveText('Fix CI')
  await expect(row.locator('[data-cockpit-ci-cost]')).toHaveText('$1.25')
  await action.click()
  await expect(row.locator('[data-cockpit-ci-confirm]')).toContainText('fix #9’s CI and push?')
  expect(queued).toEqual([])
  await row.locator('[data-cockpit-ci-confirm-yes]').click()
  await expect.poll(() => queued.length).toBe(1)
  expect(queued[0]).toContain('#9')
  await expect(row.locator('[data-cockpit-ci-progress]')).toHaveText('agent fixing…')
  await page.screenshot({ path: test.info().outputPath('inspector-pr-action.png') })

  await row.locator('[data-cockpit-ci-log]').click()
  await expect.poll(() => page.evaluate(() => location.hash)).toContain('pr=9')
  await expect(page.locator('[data-prs-detail]')).toBeVisible()
})
