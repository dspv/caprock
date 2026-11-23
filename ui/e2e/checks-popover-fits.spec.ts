/**
 * The list of a PR's checks stays inside the window (owner screenshot,
 * 2026-11-24, translated: "the modal is cut off at the bottom"): in the
 * cockpit's CI block near the foot of a short window, the card for a PR with
 * 16 checks used to open level with the row and lose its last seven rows
 * past the window's edge, with no scroll. It is now lifted off the foot
 * (lib/popoverPlace), its list scrolls under a header that stays when the
 * window is shorter than it, and the keys scroll it from the focused
 * summary. GitHub is not connected on the stand: the session's pull
 * requests and the Pipeline answer are stubbed at the page.
 *
 * With CAPROCK_SHOTS_DIR set it photographs the open card at each size.
 */
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

const now = Date.now()
const json = (b: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) })
const check = (id: number, name: string, state: string, extra: object = {}) => ({ name, state, status: 'completed', job_id: id,
  url: `https://github.com/acme/app/actions/runs/44324234291/job/${id}`, started_at: now - 600_000, completed_at: now - 20_000, ...extra })
// 16 checks: 1 running, 13 passed, 2 skipped — the owner's #1045.
const CHECKS = { state: 'pending', passed: 13, failed: 0, pending: 1, items: [
  { ...check(1, 'e2e (headless shell)', 'pending'), status: 'in_progress', completed_at: undefined },
  ...['ubuntu-latest', 'macos-latest', 'windows-latest'].map((os, i) => check(10 + i, `go (${os})`, 'pass')),
  ...Array.from({ length: 10 }, (_, i) => check(20 + i, `check ${i}`, 'pass')),
  { name: 'last skipped a', state: 'skipped' }, { name: 'last skipped b', state: 'skipped' },
] }
const TITLE = 'fix(ui): the checks card stays inside the window'
const live = { number: 1045, url: 'https://github.com/acme/app/pull/1045', title: TITLE, state: 'open', draft: false,
  review: '', reviews: [], branch: 'fix/checks-popover-fits', base: 'master', mergeable: true, mergeable_state: 'unstable', head_sha: '98c0e765', checks: CHECKS, at: now }
const STATS = { connected: true, repo: 'acme/app', fetched_at: now, read_at: now,
  prs: [{ number: 1045, url: 'https://github.com/acme/app/pull/1045', title: TITLE, state: 'open', created_at: now - 1_800_000 }],
  board: { cards: [{ number: 1045, stage: 'open', ci: 'pending', stage_at: now - 900_000, spend: { cost_usd: 0.42, sessions: 1, live: 0, agents: ['claude'] } }],
    releases: [], flow: { counts: {}, days: 14, merged: 1, ttm_count: 0, release_lag_count: 0, cost_usd: 0 }, ships_by: 'release' } }

const shotsDir = process.env.CAPROCK_SHOTS_DIR ? path.resolve(process.env.CAPROCK_SHOTS_DIR) : ''

/** The open card's box against the window, and its last row against its own scrolled list once brought into view. */
async function cardFits(page: Page) {
  return page.evaluate(() => {
    const card = document.querySelector('[data-check-list]') as HTMLElement
    const list = card.querySelector('[data-check-list-scroll]') as HTMLElement
    const head = card.querySelector('[data-check-list-head]') as HTMLElement
    const rows = card.querySelectorAll<HTMLElement>('[data-check-row]')
    const last = rows[rows.length - 1]!
    const c = card.getBoundingClientRect()
    last.scrollIntoView({ block: 'nearest' })
    const l = list.getBoundingClientRect(), r = last.getBoundingClientRect(), h = head.getBoundingClientRect()
    return {
      vw: window.innerWidth, vh: window.innerHeight,
      card: { top: c.top, bottom: c.bottom, left: c.left, right: c.right },
      rows: rows.length, lastText: last.textContent,
      lastShown: r.top >= l.top - 0.5 && r.bottom <= l.bottom + 0.5 && r.bottom <= window.innerHeight,
      headShown: h.top >= c.top - 0.5 && h.bottom <= c.bottom + 0.5,
    }
  })
}

function expectInside(f: Awaited<ReturnType<typeof cardFits>>, at: string) {
  expect(f.rows, at).toBe(16)
  expect(f.card.top, at).toBeGreaterThanOrEqual(8 - 0.5)
  expect(f.card.left, at).toBeGreaterThanOrEqual(8 - 0.5)
  expect(f.card.bottom, at).toBeLessThanOrEqual(f.vh - 8 + 0.5)
  expect(f.card.right, at).toBeLessThanOrEqual(f.vw - 8 + 0.5)
  expect(f.lastShown, at).toBe(true)
  expect(f.headShown, at).toBe(true)
}

test('a PR’s checks card stays inside a short window, its last check reachable', async ({ app, page }) => {
  test.setTimeout(120_000)
  await page.route(/\/v1\/sessions\/[^/]+\/ci\/stats$/, (r) => r.fulfill(json(STATS)))
  await page.route(/\/v1\/sessions\/([^/]+)\/prs$/, (r) => {
    const id = /\/v1\/sessions\/([^/]+)\/prs$/.exec(r.request().url())![1]
    return r.fulfill(json({ connected: true, fetched_at: Date.now(), prs: [{ session_id: id, number: 1045, url: live.url, title: TITLE, last_at: now, live }] }))
  })
  await page.addInitScript(() => {
    localStorage.setItem('caprock.app.cockpit-looks', JSON.stringify({ ci: 'full', release: 'compact', changes: 'compact', processes: 'compact', tasks: 'compact', now: 'compact' }))
  })
  await page.setViewportSize({ width: 1280, height: 600 })
  await app.open()
  const alpha = app.session('alpha')
  await app.openSession('alpha').catch(async () => { await app.row(alpha.name).first().click() })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  const row = inspector.locator('[data-cockpit-ci-pr="1045"]')
  const sum = row.locator('[data-cockpit-ci-row-checks] [data-check-summary]')
  await expect(sum).toBeVisible()

  // The row at the inspector's foot, as in the owner's screenshot (the
  // banners under the inspector are the rest of the window).
  const toFoot = async () => {
    await sum.evaluate((el) => el.scrollIntoView({ block: 'end' }))
    const box = (await sum.boundingBox())!
    const pane = (await inspector.boundingBox())!
    expect(box.y + box.height).toBeGreaterThan(pane.y + pane.height - 40)
  }

  for (const height of [600, 420, 260]) {
    await page.setViewportSize({ width: 1280, height })
    await page.mouse.move(5, 5)
    await expect(page.locator('[data-check-list]')).toHaveCount(0)
    await toFoot()
    await sum.hover()
    const card = page.locator('[data-check-list]')
    await expect(card).toBeVisible()
    await expect(card).toHaveAttribute('data-side', 'beside')
    await page.waitForTimeout(100)
    expectInside(await cardFits(page), `hovered at 1280×${height}`)
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `checks-card-1280x${height}.png`) })
  }

  // Keyboard: focused, the card opens; at 1280×260 it is cut to the window and End scrolls its list to the last check.
  await page.mouse.move(5, 5)
  await expect(page.locator('[data-check-list]')).toHaveCount(0)
  await toFoot()
  await sum.focus()
  const list = page.locator('[data-check-list] [data-check-list-scroll]')
  await expect(list).toBeVisible()
  await page.waitForTimeout(100)
  const scrolls = await list.evaluate((el) => el.scrollHeight > el.clientHeight + 1)
  expect(scrolls).toBe(true)
  await page.keyboard.press('End')
  await expect.poll(() => list.evaluate((el) => Math.ceil(el.scrollTop + el.clientHeight) >= el.scrollHeight)).toBe(true)
  // Placed again as the window resizes while open.
  await page.setViewportSize({ width: 1000, height: 360 })
  await page.waitForTimeout(150)
  expectInside(await cardFits(page), 'focused, resized to 1000×360')
  await sum.blur()
  await expect(page.locator('[data-check-list]')).toHaveCount(0)

  // A phone-wide window: where the cockpit's CI block shows at 390 px, the card keeps inside it too.
  await page.setViewportSize({ width: 390, height: 700 })
  await page.waitForTimeout(300)
  if (await sum.isVisible()) {
    await toFoot()
    await sum.hover()
    await expect(page.locator('[data-check-list]')).toBeVisible()
    await page.waitForTimeout(100)
    expectInside(await cardFits(page), 'hovered at 390×700')
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, 'checks-card-390x700.png') })
  }
})
