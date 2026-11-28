/**
 * Fix CI and Re-run from the phone (owner, 2026-11-28, translated: "on the
 * phone there is simply no button to send a red CI to be fixed"): at 390px
 * the phone home's Releases says *PR #631 CI failed* and, under that line,
 * offers Fix CI and Re-run; each asks once inline (*New agent to fix #631
 * CI? Confirm Cancel*), every target 44px, nothing wider than the screen.
 * GitHub is not connected on the stand: the Work answer, the Pipeline
 * answer, the PR's runs, the job's log, the re-run and the new agent are
 * stubbed at the page, so nothing is sent to GitHub and no agent starts.
 */
import { devices } from '@playwright/test'
import { expect, test } from './fixtures'

const now = Date.now()
const MIN = 60_000
const json = (b: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) })

const live = { number: 631, url: 'https://github.com/acme/app/pull/631', title: 'folder search', state: 'open', draft: false, review: '', reviews: [],
  branch: 'feat/folder-search', base: 'master', mergeable: true, mergeable_state: 'unstable', head_sha: 'sha631', at: now,
  checks: { state: 'fail', passed: 1, failed: 1, pending: 0, items: [
    { name: 'lint', state: 'pass', status: 'completed', job_id: 69 },
    { name: 'go (ubuntu-latest)', state: 'fail', status: 'completed', job_id: 70 },
  ] } }

test('the phone offers Fix CI and Re-run on a red pull request, each asked once inline, at 390px', async ({ browser, stand }) => {
  test.setTimeout(60_000)
  const via = stand.sessions[0]!.id
  const work = {
    now, day_start: now - 600 * MIN, hive: 'on', sessions: [], tasks: [], queued: [],
    repos: [{ root: stand.sessions[0]!.cwd, name: 'app', remote: 'acme/app', via_session: via, live: 1,
      unreleased: { ref: 'origin/master', items: ['a'], count: 1 }, tags: { last: { name: 'v0.1.0', at: now - 60 * MIN }, gaps: 0 } }],
    totals: { live: 0, working: 0, waiting_you: 0, today_usd: 0, machine_today_usd: 0 },
  }
  const stats = { connected: true, repo: 'acme/app', fetched_at: now, read_at: now,
    prs: [{ number: 631, url: live.url, title: live.title, state: 'open', head: live.branch, created_at: now - 30 * MIN }],
    board: { cards: [{ number: 631, stage: 'fix', ci: 'fail', why: 'ci', stage_at: now - 6 * MIN, spend: { cost_usd: 0, sessions: 0, live: 0, agents: [] } }],
      releases: [], ships_by: 'release', flow: { counts: {}, days: 14, merged: 0, ttm_count: 0, release_lag_count: 0, cost_usd: 0 } } }
  const ci = { connected: true, fetched_at: now, pr: { number: 631, url: live.url, repo: 'acme/app', live },
    ci: { repo: 'acme/app', head_sha: 'sha631', state: 'fail', runner_ms: 0, by_os: [], at: now, runs: [{ id: 7, name: 'CI', status: 'completed', conclusion: 'failure',
      jobs: [{ id: 70, run_id: 7, name: 'go (ubuntu-latest)', status: 'completed', conclusion: 'failure', lines: [], error_line: -1, steps: [] }] }] } }

  const ctx = await browser.newContext({ ...devices['Pixel 7'], viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 } })
  try {
    const page = await ctx.newPage()
    const spawned: unknown[] = []
    let reruns = 0
    await page.route(/\/v1\/work$/, (r) => r.fulfill(json(work)))
    await page.route(/\/v1\/sessions\/[^/]+\/ci\/stats(\?fresh=1)?$/, (r) => r.fulfill(json(stats)))
    await page.route(/\/v1\/sessions\/[^/]+\/ci\?pr=631$/, (r) => r.fulfill(json(ci)))
    await page.route(/\/v1\/sessions\/[^/]+\/ci\/jobs\/70\/log/, (r) => r.fulfill(json({ lines: ['--- FAIL: TestDeliver'] })))
    await page.route(/\/v1\/sessions\/[^/]+\/prs\/631\/rerun$/, (r) => { reruns++; return r.fulfill(json({ ok: true, mode: 'failed', runs: 1, jobs: 1 })) })
    await page.route(/\/v1\/agents$/, (r) => {
      if (r.request().method() !== 'POST') return r.fallback()
      spawned.push(r.request().postDataJSON())
      return r.fulfill(json({ session_id: 'stubbed', cwd: stand.sessions[0]!.cwd }))
    })
    await page.addInitScript(() => {
      localStorage.setItem('caprock.phone.installHint', '1')
      localStorage.setItem('caprock.phone.folds', JSON.stringify({ releases: false }))
    })
    await page.goto(`${stand.pageURL}/#/`)

    const releases = page.locator('[data-phone-releases]')
    await expect(releases.getByText('PR #631 CI failed')).toBeVisible()
    const fix = releases.locator('[data-release-line-fix="631"]')
    const fixCI = fix.getByRole('button', { name: 'Fix CI' })
    const rerun = fix.getByRole('button', { name: 'Re-run' })
    await expect(fixCI).toBeVisible()
    await expect(rerun).toBeVisible()
    // Not twice: the row under the line does not repeat it.
    await expect(releases.getByRole('button', { name: 'Fix CI' })).toHaveCount(1)
    for (const b of [fixCI, rerun]) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44)

    // Fix CI asks once, inline; Cancel sends nothing.
    await fixCI.tap()
    await expect(fix.getByText('New agent to fix #631 CI?')).toBeVisible()
    const confirm = fix.getByRole('button', { name: 'Confirm' })
    const cancel = fix.getByRole('button', { name: 'Cancel' })
    for (const b of [confirm, cancel]) {
      const box = (await b.boundingBox())!
      expect(box.height).toBeGreaterThanOrEqual(44)
      expect(box.x + box.width).toBeLessThanOrEqual(390)
    }
    const wide = await page.evaluate(() => document.documentElement.scrollWidth)
    expect(wide).toBeLessThanOrEqual(390)
    await cancel.tap()
    await expect(fixCI).toBeVisible()
    expect(spawned).toHaveLength(0)

    // Confirm: a new agent in a worktree at #631's head, told the failed job and its log.
    await fixCI.tap()
    await fix.getByRole('button', { name: 'Confirm' }).tap()
    await expect(fix.getByText('Started an agent on #631')).toBeVisible()
    expect(spawned).toHaveLength(1)
    expect(spawned[0]).toMatchObject({ worktree: 'pr-631-fix', worktree_pr: 631 })
    expect(JSON.stringify(spawned[0])).toContain('--- FAIL: TestDeliver')
    await expect(fix.getByText('agent fixing…')).toBeVisible()
    expect(reruns).toBe(0)
  } finally {
    await ctx.close()
  }
})

test('Re-run from the session sheet asks once, then asks GitHub for the failed jobs', async ({ browser, stand }) => {
  test.setTimeout(60_000)
  const sid = stand.sessions[1]!.id
  const ctx = await browser.newContext({ ...devices['Pixel 7'], viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 } })
  try {
    const page = await ctx.newPage()
    let reruns = 0
    // The session sheet's Pull requests: the session's PR list says #631 failed.
    await page.route(/\/v1\/sessions\/[^/]+\/prs$/, (r) => r.fulfill(json({ connected: true, fetched_at: now, prs: [{ session_id: sid, number: 631, url: live.url, title: live.title, last_at: now, live }] })))
    await page.route(/\/v1\/sessions\/[^/]+\/ci\?pr=631$/, (r) => r.fulfill(json({ connected: true, fetched_at: now, pr: { number: 631, url: live.url, repo: 'acme/app', live } })))
    await page.route(/\/v1\/sessions\/[^/]+\/prs\/631\/rerun$/, (r) => { reruns++; return r.fulfill(json({ ok: true, mode: 'failed', runs: 1, jobs: 1 })) })
    await page.addInitScript(() => { localStorage.setItem('caprock.phone.installHint', '1') })
    await page.goto(`${stand.pageURL}/#/session/${sid}`)
    // The title opens the sheet.
    await page.getByRole('button', { name: /— session details$/ }).tap()
    const row = page.locator('[data-phone-session-pr="631"]')
    await expect(row.getByText('CI failed')).toBeVisible()
    await row.getByRole('button', { name: 'Re-run' }).tap()
    await expect(row.getByText('Re-run #631 on GitHub?')).toBeVisible()
    await row.getByRole('button', { name: 'Confirm' }).tap()
    await expect(row.getByText('re-running 1 job…')).toBeVisible()
    expect(reruns).toBe(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  } finally {
    await ctx.close()
  }
})
