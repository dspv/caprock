/**
 * Now's subagent tree (owner, 2026-11-23, picked from a clickable mockup):
 * the Subagents section merged into Now as one header, an entry per working
 * subagent and the finished folded into *N done*, drawn as Cards or Rows.
 * The fake claude starts no subagents, so the session's subagents, one's
 * calls and the session's background state are stubbed at the page; nothing
 * is typed into the fake claude.
 *
 * With CAPROCK_SHOTS_DIR set it also photographs both looks, folded and
 * opened, in both themes there (the PR's own verification, not a test).
 */
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

const json = (b: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) })
const shotsDir = process.env.CAPROCK_SHOTS_DIR ? path.resolve(process.env.CAPROCK_SHOTS_DIR) : ''
const now = Date.now()

const SUBS = {
  working: [
    { agent_id: 'p1', agent_type: 'general-purpose', description: 'Running python3', tool_calls: 12, started_at: now - 214_000, last_at: now - 2_000, tool: 'Bash', detail: 'python3 stand.py', tool_at: now - 9_000, running: true, asking: false, cost_usd: 0.69 },
    { agent_id: 'c2', agent_type: 'Explore', description: 'Check error codes and available crates', tool_calls: 31, started_at: now - 199_000, last_at: now - 1_000, tool: 'Bash', detail: 'cargo tree -e features', tool_at: now - 4_000, running: true, asking: false, cost_usd: 1.61 },
    { agent_id: 'm3', agent_type: 'general-purpose', description: 'mod list and Makefile cargo targets', tool_calls: 8, started_at: now - 191_000, last_at: now - 3_000, tool: 'Bash', detail: 'make -qp', tool_at: now - 6_000, running: true, asking: false, cost_usd: 1.16 },
  ],
  finished: 1,
  recent: [{ agent_id: 'd9', agent_type: 'Plan', description: 'Find the top disk readers', tool_calls: 40, started_at: now - 1_200_000, stopped_at: now - 352_000, cost_usd: 14.19 }],
  cost_usd: 17.65,
}

const detail = (agent: string) => ({
  agent_id: agent, state: agent === 'd9' ? 'finished' : 'working', asking: false, started_at: now - 200_000, last_at: now - 1_000, earlier: 9,
  calls: [
    { id: 11, tool: 'Read', detail: 'internal/store/summaryparts.go', started_at: now - 60_000, ended_at: now - 59_000 },
    { id: 12, tool: 'Grep', detail: 'func Summary', started_at: now - 40_000, ended_at: now - 39_500 },
    { id: 13, tool: 'Bash', detail: 'cargo tree -e features', started_at: now - 4_000, ...(agent === 'd9' ? { ended_at: now - 1_000 } : {}) },
  ],
  stats: { tool_calls: 12, turns: 6, tokens: { in: 1, out: 2, cache_read: 3, cache_write: 4 }, duration_ms: 200_000, by_tool: [] },
})

async function stub(page: Page, sessionId: string) {
  await page.route(/\/v1\/sessions\/[^/]+\/subagents(\?.*)?$/, (r) => r.fulfill(json(SUBS)))
  await page.route(/\/v1\/sessions\/[^/]+\/subagents\/[^/?]+(\?.*)?$/, (r) => r.fulfill(json(detail(new URL(r.request().url()).pathname.split('/').pop()!))))
  // The session's turn has ended with its subagents still at work.
  await page.route(/\/v1\/sessions(\?.*)?$/, async (r) => {
    const res = await r.fetch()
    const rows = await res.json() as { session_id: string; activity?: object; live_subagents?: number }[]
    for (const s of Array.isArray(rows) ? rows : []) {
      if (s.session_id !== sessionId) continue
      s.activity = { phrase: 'background agents working · 3', at: new Date().toISOString(), health: 'working', background: 3 }
      s.live_subagents = 3
    }
    await r.fulfill({ response: res, json: rows })
  })
}

test('Now’s subagent tree folds, opens an entry in place, and switches between Cards and Rows', async ({ app, page }) => {
  const alpha = app.session('alpha')
  await stub(page, alpha.id)
  await app.open()
  await app.openSession('alpha').catch(async () => { await app.row(alpha.name).first().click() })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  const now_ = inspector.getByRole('region', { name: 'Now' })
  const head = now_.locator('[data-agents-head]')
  await expect(head).toContainText('Background agents · 3')
  await expect(head).toHaveAttribute('aria-expanded', 'true')
  // The old section is gone.
  await expect(inspector.locator('[data-section-frame="subagents"]')).toHaveCount(0)
  const tree = now_.getByRole('list', { name: 'Subagents' })
  await expect(tree.locator(':scope > [data-subagent]')).toHaveCount(3)

  // Keyboard: the header folds and unfolds the tree.
  await head.focus()
  await page.keyboard.press('Enter')
  await expect(head).toHaveAttribute('aria-expanded', 'false')
  await expect(tree).toHaveCount(0)
  await page.keyboard.press('Space')
  await expect(head).toHaveAttribute('aria-expanded', 'true')

  // Cards by default; an entry opens in place to its latest steps.
  await expect(now_.locator('[data-now-agents]')).toHaveAttribute('data-view', 'cards')
  const card = now_.locator('[data-subagent="c2"]')
  await card.getByRole('button', { name: /Check error codes/ }).click()
  await expect(card.getByRole('list', { name: 'Latest steps' }).getByRole('listitem')).toHaveCount(3)
  const done = now_.getByRole('button', { name: /1 done · Find the top disk readers/ })
  await expect(done).toHaveAttribute('aria-expanded', 'false')
  await done.click()
  await expect(now_.getByRole('list', { name: 'Finished subagents' }).locator('[data-subagent="d9"]')).toBeVisible()

  // Nothing reaches past the inspector at its narrowest.
  await page.evaluate(() => document.documentElement.style.setProperty('--app-inspector-w', '280px'))
  await page.waitForTimeout(150)
  // Every box ends inside the section (a long line is cut inside its own box), and nothing scrolls sideways.
  const over = await now_.evaluate((sec) => {
    const edge = sec.getBoundingClientRect().right + 0.5
    return [...sec.querySelectorAll<HTMLElement>('button, li, ol, ul')].filter((el) => el.offsetWidth > 0 && el.getBoundingClientRect().right > edge).map((el) => el.textContent)
  })
  expect(over).toEqual([])
  expect(await inspector.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0)
  await page.evaluate(() => document.documentElement.style.removeProperty('--app-inspector-w'))

  // Rows: one line each, the choice kept across a reload.
  await now_.getByRole('group', { name: 'How Now draws its subagents' }).getByRole('button', { name: 'Rows' }).click()
  await expect(now_.locator('[data-now-agents]')).toHaveAttribute('data-view', 'rows')
  await page.reload()
  await expect(inspector.getByRole('region', { name: 'Now' }).locator('[data-now-agents]')).toHaveAttribute('data-view', 'rows')
  const row = inspector.locator('[data-subagent="p1"]')
  await expect(row).toContainText('Running python3')
  await row.getByRole('button', { name: /Running python3/ }).click()
  await expect(row.getByRole('list', { name: 'Latest steps' })).toBeVisible()
  await page.evaluate(() => localStorage.removeItem('caprock.app.now-view'))
})

test('photographs Now’s subagent tree: rows and cards, folded and opened, both themes', async ({ app, page }) => {
  test.skip(!shotsDir, 'CAPROCK_SHOTS_DIR is unset: the photographs are the PR’s own verification')
  const alpha = app.session('alpha')
  await stub(page, alpha.id)
  await page.setViewportSize({ width: 1280, height: 1000 })
  await app.open()
  await app.openSession('alpha').catch(async () => { await app.row(alpha.name).first().click() })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  for (const scheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    for (const view of ['cards', 'rows'] as const) {
      await page.evaluate((v) => localStorage.setItem('caprock.app.now-view', v), view)
      await page.reload()
      const now_ = inspector.getByRole('region', { name: 'Now' })
      await expect(now_.locator('[data-now-agents]')).toHaveAttribute('data-view', view)
      await page.waitForTimeout(300)
      const frame = inspector.locator('[data-section-frame="now"]')
      await frame.screenshot({ path: path.join(shotsDir, `${view}-${scheme}-collapsed.png`) })
      await now_.locator('[data-subagent="c2"]').getByRole('button', { name: /Check error codes/ }).click()
      await expect(now_.getByRole('list', { name: 'Latest steps' })).toBeVisible()
      await now_.getByRole('button', { name: /1 done/ }).click()
      await page.waitForTimeout(300)
      await frame.screenshot({ path: path.join(shotsDir, `${view}-${scheme}-expanded.png`) })
    }
  }
  await page.evaluate(() => localStorage.removeItem('caprock.app.now-view'))
})
