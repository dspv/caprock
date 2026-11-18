/**
 * Rerun jobs GitHub never ran (owner, 2026-11-18): beside the folded line's
 * Rerun of a job GitHub never gave a machine sits the switch Settings →
 * GitHub has (*always*, the whole of it on hover), and the unfolded row
 * carries it worded in full (*Always rerun these*). Once Caprock re-ran a
 * run by itself, the line and the row say *re-run by Caprock*. GitHub is not
 * connected on the stand: the connection, the switch and the session's pull
 * requests are answered at the page, as the daemon answers them (its
 * contract, internal/github/autorerun.go), so nothing is ever sent to GitHub.
 *
 * With CAPROCK_SHOTS_DIR set it photographs the folded line, the row and
 * the "re-run by Caprock" state at 324 px.
 */
import path from 'node:path'
import { expect, test } from './fixtures'

const now = Date.now()
const json = (b: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) })
const job = (id: number, name: string, state: string, extra: object = {}) => ({ name, state, status: 'completed', job_id: id,
  url: `https://github.com/acme/app/actions/runs/44324234291/job/${id}`, started_at: now - 900_000, completed_at: now - 20_000, ...extra })
const PASSED = Array.from({ length: 12 }, (_, i) => job(10 + i, `check ${i}`, 'pass'))
const IDLE = { state: 'no_runner', passed: 12, failed: 0, pending: 0, no_runner: 1, items: [job(134871157816, 'go (macos-latest)', 'fail', { no_runner: true }), ...PASSED] }
const RERUN = { state: 'pending', passed: 12, failed: 0, pending: 1, items: [{ ...job(134871999999, 'go (macos-latest)', 'pending'), status: 'in_progress', completed_at: undefined }, ...PASSED],
  auto_rerun: { attempt: 1, at: now - 30_000, jobs: 1 } }
const live = (checks: object) => ({ number: 941, url: 'https://github.com/acme/app/pull/941', title: 'docs(readme): first paragraph answers what Caprock is', state: 'open', draft: false,
  review: '', reviews: [], branch: 'docs/readme-answer-first', base: 'master', mergeable: true, mergeable_state: 'unstable', head_sha: '98c0e765', checks, at: now })
const STATS = {
  connected: true, repo: 'acme/app', fetched_at: now, read_at: now,
  prs: [{ number: 941, url: 'https://github.com/acme/app/pull/941', title: 'docs(readme): first paragraph answers what Caprock is', state: 'open', created_at: now - 1_800_000 }],
  board: { cards: [{ number: 941, stage: 'open', ci: 'no_runner', stage_at: now - 900_000, spend: { cost_usd: 0.42, sessions: 1, live: 0, agents: ['claude'] } }],
    releases: [], flow: { counts: {}, days: 14, merged: 1, ttm_count: 0, release_lag_count: 0, cost_usd: 0 }, ships_by: 'release' },
}
const STATUS = { connected: true, source: 'token', user: { login: 'ada' }, scopes: ['repo'], scopes_known: true, token_kind: 'classic',
  sources: { gh: false, stored: true, store: 'file', oauth: false }, health: { last_ok_at: now }, notify: true, auto_rerun: false, tracked: 0 }

const shotsDir = process.env.CAPROCK_SHOTS_DIR ? path.resolve(process.env.CAPROCK_SHOTS_DIR) : ''

test('the switch sits beside Rerun and fits; a run Caprock re-ran says so', async ({ app, page }) => {
  test.setTimeout(90_000)
  let checks: object = IDLE
  let status = { ...STATUS }
  const patches: unknown[] = []
  await page.route(/\/v1\/github$/, (r) => {
    if (r.request().method() === 'PATCH') {
      const b = r.request().postDataJSON() as { auto_rerun?: boolean }
      patches.push(b)
      status = { ...status, auto_rerun: !!b.auto_rerun }
    }
    return r.fulfill(json(status))
  })
  await page.route(/\/v1\/sessions\/[^/]+\/ci\/stats$/, (r) => r.fulfill(json(STATS)))
  await page.route(/\/v1\/sessions\/([^/]+)\/prs$/, (r) => {
    const id = /\/v1\/sessions\/([^/]+)\/prs$/.exec(r.request().url())![1]
    return r.fulfill(json({ connected: true, fetched_at: Date.now(), prs: [{ session_id: id, number: 941, url: 'https://github.com/acme/app/pull/941', title: 'docs(readme)', last_at: now, live: live(checks) }] }))
  })
  const looks = (ci: string) => JSON.stringify({ ci, release: 'compact', changes: 'compact', processes: 'compact', tasks: 'compact', now: 'compact' })
  await page.addInitScript((v) => { if (!localStorage.getItem('caprock.app.cockpit-looks')) localStorage.setItem('caprock.app.cockpit-looks', v) }, looks('compact'))
  await app.open()
  const alpha = app.session('alpha')
  await app.openSession('alpha').catch(async () => { await app.row(alpha.name).first().click() })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  const fold = inspector.locator('[data-cockpit-ci-fold]')
  await expect(fold).toHaveAttribute('data-cockpit-ci-fold', '941')
  const sw = fold.locator('[data-auto-rerun-switch="short"]')
  await expect(sw).toBeVisible()
  await expect(sw).toHaveAttribute('title', /once per run.*your GitHub token/s)
  await expect(fold.locator('[data-cockpit-ci-fold-rerun]')).toBeVisible()

  const pastEdge = () => page.evaluate(() => {
    const head = document.querySelector('section[aria-label="CI"] [data-section-head]') as HTMLElement
    const edge = head.getBoundingClientRect().right + 0.5
    const out: string[] = []
    for (const el of head.querySelectorAll<HTMLElement>('span, button, label, input')) {
      if (el.closest('.invisible') || el.offsetWidth === 0) continue
      const r = el.getBoundingClientRect()
      if (r.right > edge) out.push(`"${el.textContent}" ends at ${Math.round(r.right)} > ${Math.round(edge)}`)
    }
    return out
  })
  const frame = inspector.locator('[data-section-frame="ci"]')
  const seen: string[] = []
  for (const w of [280, 300, 324, 360, 460]) {
    await page.evaluate((px) => document.documentElement.style.setProperty('--app-inspector-w', `${px}px`), w)
    await page.waitForTimeout(250)
    expect(await pastEdge(), `at ${w}px`).toEqual([])
    await expect(sw.locator('input')).toBeVisible()
    // Under 400 px of line, the box and ↻ only; the whole of it on hover.
    seen.push(`${w}:${(await sw.innerText()).trim()}`)
    if (shotsDir) await frame.screenshot({ path: path.join(shotsDir, `fold-switch-${w}.png`) })
  }
  expect(seen[0]).toBe('280:↻')
  expect(seen[seen.length - 1]).toBe('460:Always rerun these')
  await page.evaluate(() => document.documentElement.style.setProperty('--app-inspector-w', '324px'))

  // Ticking it is the setting itself.
  await sw.locator('input').check()
  await expect.poll(() => patches).toEqual([{ auto_rerun: true }])
  await expect(sw.locator('input')).toBeChecked()
  if (shotsDir) await frame.screenshot({ path: path.join(shotsDir, 'fold-switch-on-324.png') })

  // Caprock re-ran it: the line says so, in place of the switch.
  checks = RERUN
  await page.reload()
  await expect(app.tabs.getByRole('tab', { name: new RegExp(`^${alpha.name}`), selected: true })).toBeVisible()
  await page.evaluate(() => document.documentElement.style.setProperty('--app-inspector-w', '324px'))
  const word = fold.locator('[data-auto-rerun]')
  await expect(word).toHaveText('re-run by Caprock')
  await expect(word).toHaveAttribute('title', /Caprock reran 1 job GitHub never gave a machine/)
  await expect(fold.locator('[data-auto-rerun-switch]')).toHaveCount(0)
  for (const w of [280, 324, 460]) {
    await page.evaluate((px) => document.documentElement.style.setProperty('--app-inspector-w', `${px}px`), w)
    await page.waitForTimeout(250)
    expect(await pastEdge(), `re-run by Caprock, at ${w}px`).toEqual([])
    if (shotsDir) await frame.screenshot({ path: path.join(shotsDir, `fold-rerun-by-caprock-${w}.png`) })
  }

  // Unfolded: the row with a job given no machine carries the switch in full;
  // the row of a run Caprock re-ran says so.
  checks = IDLE
  status = { ...status, auto_rerun: false }
  await page.evaluate((v) => localStorage.setItem('caprock.app.cockpit-looks', v), looks('full'))
  await page.reload()
  await page.evaluate(() => document.documentElement.style.setProperty('--app-inspector-w', '324px'))
  const row = inspector.locator('[data-cockpit-ci-pr="941"]')
  await expect(row.locator('[data-auto-rerun-switch="full"]')).toHaveText('Always rerun these')
  await page.waitForTimeout(300)
  if (shotsDir) await frame.screenshot({ path: path.join(shotsDir, 'unfolded-switch-324.png') })
  checks = { ...IDLE, auto_rerun: { attempt: 1, at: now - 30_000, jobs: 1, again: true } }
  await page.reload()
  await page.evaluate(() => document.documentElement.style.setProperty('--app-inspector-w', '324px'))
  await expect(row.locator('[data-auto-rerun]')).toHaveText('re-run by Caprock once')
  await expect(row.locator('[data-cockpit-ci-action]')).toHaveAttribute('data-cockpit-ci-action', 'rerun')
  await page.waitForTimeout(300)
  if (shotsDir) await frame.screenshot({ path: path.join(shotsDir, 'unfolded-again-324.png') })
})
