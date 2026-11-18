/**
 * A job GitHub never ran (owner, 2026-11-18): hosted macOS jobs sometimes
 * wait ~15 minutes for a machine and are then ended with no step run and no
 * runner (run 44324234291, job 134871157816). The folded CI line said "✕ 1
 * failed"; it now says "⚠ 1 no runner" in muted amber with Rerun beside it,
 * and the unfolded row says the same with Re-run as its one action. GitHub
 * is not connected on the stand: the session's pull requests and the
 * Pipeline answer are stubbed at the page, as the daemon composes them for
 * such a job (its contract, internal/github/norunner.go), and so is the
 * re-run, so nothing is ever sent to GitHub.
 *
 * With CAPROCK_SHOTS_DIR set it photographs the folded line at 324 px and
 * the unfolded list there (the PR's own verification).
 */
import path from 'node:path'
import { expect, test } from './fixtures'

const now = Date.now()
const json = (b: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) })
const SPEND = { cost_usd: 0.42, sessions: 1, live: 0, agents: ['claude'] }
const FLOW = { counts: {}, days: 14, merged: 1, ttm_count: 0, release_lag_count: 0, cost_usd: 0 }
const job = (id: number, name: string, state: string, extra: object = {}) => ({ name, state, status: 'completed', job_id: id,
  url: `https://github.com/acme/app/actions/runs/44324234291/job/${id}`, started_at: now - 900_000, completed_at: now - 20_000, ...extra })
const IDLE = { state: 'no_runner', passed: 12, failed: 0, pending: 0, no_runner: 1, items: [
  job(134871157816, 'go (macos-latest)', 'fail', { no_runner: true }),
  job(1, 'go (ubuntu-latest)', 'pass'), job(2, 'go (windows-latest)', 'pass'),
  ...Array.from({ length: 10 }, (_, i) => job(10 + i, `check ${i}`, 'pass')),
  { name: 'skip a', state: 'skipped' }, { name: 'skip b', state: 'skipped' },
] }
const live = (n: number, checks: object) => ({ number: n, url: `https://github.com/acme/app/pull/${n}`, title: 'docs(readme): first paragraph answers what Caprock is', state: 'open', draft: false,
  review: '', reviews: [], branch: 'docs/readme-answer-first', base: 'master', mergeable: true, mergeable_state: 'unstable', head_sha: '98c0e765', checks, at: now })
const STATS = {
  connected: true, repo: 'acme/app', fetched_at: now, read_at: now,
  prs: [
    { number: 941, url: 'https://github.com/acme/app/pull/941', title: 'docs(readme): first paragraph answers what Caprock is', state: 'open', created_at: now - 1_800_000 },
    { number: 940, url: 'https://github.com/acme/app/pull/940', title: 'feat: Cursor context reading', state: 'merged', created_at: now - 7_200_000, merged_at: now - 3_600_000 },
  ],
  board: {
    cards: [
      { number: 941, stage: 'open', ci: 'no_runner', stage_at: now - 900_000, spend: SPEND },
      { number: 940, stage: 'merged', stage_at: now - 3_600_000, spend: { cost_usd: 0, sessions: 0, live: 0, agents: [] } },
    ],
    releases: [], flow: FLOW, ships_by: 'release',
  },
}

const shotsDir = process.env.CAPROCK_SHOTS_DIR ? path.resolve(process.env.CAPROCK_SHOTS_DIR) : ''

test('a job GitHub never ran reads "no runner", not failed, with Rerun on the folded line and the row', async ({ app, page }) => {
  test.setTimeout(90_000)
  const reruns: string[] = []
  await page.route(/\/v1\/sessions\/[^/]+\/ci\/stats$/, (r) => r.fulfill(json(STATS)))
  await page.route(/\/v1\/sessions\/([^/]+)\/prs$/, (r) => {
    const id = /\/v1\/sessions\/([^/]+)\/prs$/.exec(r.request().url())![1]
    return r.fulfill(json({ connected: true, fetched_at: Date.now(), prs: [{ session_id: id, number: 941, url: 'https://github.com/acme/app/pull/941', title: 'docs(readme)', last_at: now, live: live(941, IDLE) }] }))
  })
  // The re-run, answered here: the stand never reaches GitHub.
  await page.route(/\/v1\/sessions\/[^/]+\/prs\/\d+\/rerun$/, (r) => { reruns.push(r.request().url()); return r.fulfill(json({ ok: true, mode: 'failed', runs: 1, jobs: 1 })) })
  await page.addInitScript(() => {
    if (!localStorage.getItem('caprock.app.cockpit-looks')) localStorage.setItem('caprock.app.cockpit-looks', JSON.stringify({ ci: 'compact', release: 'compact', changes: 'compact', processes: 'compact', tasks: 'compact', now: 'compact' }))
  })
  await app.open()
  const alpha = app.session('alpha')
  await app.openSession('alpha').catch(async () => { await app.row(alpha.name).first().click() })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  const fold = inspector.locator('[data-cockpit-ci-fold]')
  await expect(fold).toHaveAttribute('data-cockpit-ci-fold', '941')
  await expect(fold.locator('[data-check-summary]:not(.invisible *)').first()).toBeVisible()
  const rerun = fold.locator('[data-cockpit-ci-fold-rerun]')
  await expect(rerun).toBeEnabled()
  await expect(rerun).toHaveAttribute('title', /GitHub did not give this job a machine; the code was not tested\. Rerun it\./)
  // Never "failed": no red part in any wording.
  expect(await fold.locator('[data-check-part="fail"]').count()).toBe(0)

  // What of the folded line passes the panel's edge: nothing, at any width.
  const pastEdge = () => page.evaluate(() => {
    const head = document.querySelector('section[aria-label="CI"] [data-section-head]') as HTMLElement
    const edge = head.getBoundingClientRect().right + 0.5
    const out: string[] = []
    for (const el of head.querySelectorAll<HTMLElement>('span, button')) {
      if (el.closest('.invisible') || el.offsetWidth === 0) continue
      const r = el.getBoundingClientRect()
      if (r.right > edge) out.push(`"${el.textContent}" ends at ${Math.round(r.right)} > ${Math.round(edge)}`)
    }
    return out
  })
  const widths = [280, 300, 324, 360, 460]
  for (const w of widths) {
    await page.evaluate((px) => document.documentElement.style.setProperty('--app-inspector-w', `${px}px`), w)
    await page.waitForTimeout(250)
    expect(await pastEdge(), `at ${w}px`).toEqual([])
    const shown = await fold.locator('[data-fit-summary] > [data-fit-variant]:not(.invisible)').innerText()
    expect(shown, `at ${w}px`).toMatch(/no runner|⚠|1/)
    if (shotsDir) await inspector.locator('[data-section-frame="ci"]').screenshot({ path: path.join(shotsDir, `ci-fold-no-runner-${w}.png`) })
  }

  // At 324 px: Rerun asks once, then re-runs.
  await page.evaluate(() => document.documentElement.style.setProperty('--app-inspector-w', '324px'))
  await page.waitForTimeout(250)
  if (shotsDir) await inspector.locator('[data-section-frame="ci"]').screenshot({ path: path.join(shotsDir, 'folded-324.png') })
  await rerun.click()
  await expect(fold.locator('[data-cockpit-ci-fold-confirm]')).toContainText('Re-run?')
  expect(reruns).toEqual([])
  for (const w of [280, 324]) {
    await page.evaluate((px) => document.documentElement.style.setProperty('--app-inspector-w', `${px}px`), w)
    await page.waitForTimeout(200)
    expect(await pastEdge(), `confirming, at ${w}px`).toEqual([])
  }
  await page.evaluate(() => document.documentElement.style.setProperty('--app-inspector-w', '324px'))
  await page.waitForTimeout(200)
  if (shotsDir) await inspector.locator('[data-section-frame="ci"]').screenshot({ path: path.join(shotsDir, 'folded-324-confirm.png') })
  await fold.locator('[data-cockpit-ci-fold-confirm-yes]').click()
  await expect.poll(() => reruns.length).toBe(1)
  expect(reruns[0]).toMatch(/\/prs\/941\/rerun$/)
  await expect(fold.locator('[data-cockpit-ci-fold-progress]')).toHaveAttribute('title', 're-running 1 job…')
  if (shotsDir) await inspector.locator('[data-section-frame="ci"]').screenshot({ path: path.join(shotsDir, 'folded-324-rerunning.png') })
  // The confirm and the progress fit as the summary does, at every width.
  for (const w of widths) {
    await page.evaluate((px) => document.documentElement.style.setProperty('--app-inspector-w', `${px}px`), w)
    await page.waitForTimeout(200)
    expect(await pastEdge(), `re-running, at ${w}px`).toEqual([])
  }
  await page.evaluate(() => document.documentElement.style.setProperty('--app-inspector-w', '324px'))

  // Unfolded: the row says "⚠ 1 no runner" and offers Re-run; its CI step is muted amber, not red.
  await page.evaluate(() => localStorage.setItem('caprock.app.cockpit-looks', JSON.stringify({ ci: 'full', release: 'compact', changes: 'compact', processes: 'compact', tasks: 'compact', now: 'compact' })))
  await page.reload()
  await expect(app.tabs.getByRole('tab', { name: new RegExp(`^${alpha.name}`), selected: true })).toBeVisible()
  await page.evaluate(() => document.documentElement.style.setProperty('--app-inspector-w', '324px'))
  const row = inspector.locator('[data-cockpit-ci-pr="941"]')
  await expect(row.locator('[data-cockpit-ci-norunner] [data-check-part="norunner"]')).toHaveText('1 no runner')
  await expect(row.locator('[data-cockpit-ci-action]')).toHaveAttribute('data-cockpit-ci-action', 'rerun')
  await expect(row.locator('[data-journey-seg="ci"]')).toHaveClass(/bg-norunner/)
  await page.waitForTimeout(400)
  if (shotsDir) {
    const ci = inspector.locator('[data-section-frame="ci"]')
    await ci.scrollIntoViewIfNeeded()
    await ci.screenshot({ path: path.join(shotsDir, 'unfolded-324.png') })
    // The Ring and By OS views of the same PR.
    for (const v of ['ring', 'grid'] as const) {
      await inspector.locator(`[data-cockpit-ci-view="${v}"]`).click()
      await page.waitForTimeout(300)
      await ci.screenshot({ path: path.join(shotsDir, `unfolded-324-${v}.png`) })
    }
    await inspector.locator('[data-cockpit-ci-view="dots"]').click()
    // The hover list, every check: the no-runner one says why.
    const sum = row.locator('[data-check-summary]').first()
    if (await sum.count()) {
      await sum.hover()
      await page.waitForTimeout(900)
      await page.screenshot({ path: path.join(shotsDir, 'hover-list.png') })
    }
  }
})
