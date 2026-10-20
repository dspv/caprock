/**
 * The sidebar's Recently closed and its Background row (owner, 2026-10-20),
 * driven as a person drives them against the sandboxed stand: close a tab,
 * see it under Recently closed, bring it back with a click and with ⇧⌘T
 * (Ctrl+Alt+Shift+T off macOS), and find a helper session started in a temp
 * folder folded under Background · N rather than under Running, no tab.
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './fixtures'

test('a closed tab is listed under Recently closed and comes back on a click and on ⇧⌘T', async ({ app, page }) => {
  await app.open()
  // Close keeps the agent running here: no question, the process stays.
  await page.evaluate(() => localStorage.setItem('caprock.app.agent-close', 'keep'))
  // Earlier scenarios typed into this session, so its terminal is not at its ready line: the tab is what counts.
  const s = app.session('alpha')
  await app.row(s.name).first().click()
  const tab = app.tabs.getByRole('tab', { name: new RegExp(`^${s.name}`) })
  await expect(tab).toHaveAttribute('aria-selected', 'true')
  const closed = app.sidebar.getByRole('region', { name: 'Recently closed' })
  await expect(closed).toHaveCount(0)

  await app.chord('w')
  await expect(tab).toHaveCount(0)
  const row = closed.locator(`[data-closed-row="${s.id}"]`)
  await expect(row).toBeVisible()
  await expect(row).toContainText(s.name)
  await expect(row.locator('[data-closed-ago]')).toHaveText(/^(now|\d+ min)$/)
  // Above Running, no tab, after the tabbed rows (none open now).
  const order = await app.sidebar.locator('[data-recently-closed], [data-untabbed-heading]').evaluateAll((els) => els.map((e) => (e.hasAttribute('data-recently-closed') ? 'closed' : 'running')))
  expect(order).toEqual(['closed', 'running'])

  await row.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
  await expect(closed).toHaveCount(0)

  await app.chord('w')
  await expect(tab).toHaveCount(0)
  await expect(row).toBeVisible()
  const mac = await page.evaluate(() => /Mac|iP(hone|ad)/.test(navigator.platform || navigator.userAgent))
  await page.keyboard.press(mac ? 'Meta+Shift+T' : 'Control+Alt+Shift+T')
  await expect(tab).toBeVisible()
  await expect(closed).toHaveCount(0)
  // ⇧⌘T is not the theme picker any more.
  await expect(page.locator('[data-theme-menu]')).toHaveCount(0)
})

test('a helper started in a temp folder folds under Background, opened on a click and remembered', async ({ app, page }) => {
  // A session another tool started in a temp folder no project holds, the
  // way an ops run is: untitled, outside every listed project.
  const cwd = path.join(app.stand.dir, 'tmp', 'ops-seo-site-e2e')
  mkdirSync(cwd, { recursive: true })
  const r = await fetch(`${app.stand.daemonURL}/v1/agents`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd }) })
  const { session_id: id } = await r.json() as { session_id: string }
  expect(r.ok && id, `spawn in ${cwd}`).toBeTruthy()
  try {
    await app.open()
    const toggle = app.sidebar.locator('[data-background-toggle]')
    // At least this one: an earlier spec in the same stand may leave its own.
    await expect(toggle).toContainText(/Background · [1-9]/)
    await expect(toggle).toContainText('scouts, ops, helpers')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(app.sidebar.locator(`[data-live-row="${id}"]`)).toHaveCount(0)
    // The user's own sessions stay under Running, no tab.
    for (const s of app.stand.sessions) await expect(app.sidebar.getByRole('group', { name: 'Running, no tab' }).locator(`[data-live-row="${s.id}"]`)).toBeVisible()
    await toggle.click()
    await expect(app.sidebar.getByRole('group', { name: 'Background' }).locator(`[data-live-row="${id}"]`)).toBeVisible()
    await page.reload()
    await expect(app.sidebar.locator('[data-background-toggle]')).toHaveAttribute('aria-expanded', 'true')
  } finally {
    // This stand started it, so this stand stops it (rule 7).
    await fetch(`${app.stand.daemonURL}/v1/agents/${id}/signal`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'kill' }) })
  }
})

// Last in the file: it ends the beta session for good.
test('an agent ended with its tab comes back from its Recently closed row, read-only when it cannot be continued', async ({ app, page }) => {
  await app.open()
  // Close ends the agent (Settings → Closing a tab: End the agent), SIGTERM first.
  await page.evaluate(() => localStorage.setItem('caprock.app.agent-close', 'end'))
  const s = app.session('beta')
  await app.row(s.name).first().click()
  const tab = app.tabs.getByRole('tab', { name: new RegExp(`^${s.name}`) })
  await expect(tab).toHaveAttribute('aria-selected', 'true')
  await app.chord('w')
  await expect(tab).toHaveCount(0)
  const row = app.sidebar.locator(`[data-closed-row="${s.id}"]`)
  await expect(row).toBeVisible()
  // Once the daemon says it ended, the row continues it rather than reopening a live tab.
  await expect.poll(async () => {
    const r = await fetch(`${app.stand.daemonURL}/v1/sessions/${s.id}`)
    return r.ok ? ((await r.json()) as { status?: string }).status : 'missing'
  }, { timeout: 15_000 }).toBe('ended')
  await page.waitForTimeout(2500) // the page's next poll of the session list
  await row.click()
  await expect(app.tabs.getByRole('tab', { selected: true })).toHaveAccessibleName(new RegExp(`^${s.name}`), { timeout: 15_000 })
  await expect(row).toHaveCount(0)
  // The fake claude writes no transcript, so the daemon says it cannot be
  // continued: the conversation opens read-only with that reason, as
  // reopenPlan does for one with resume.ok false. (A real one is continued
  // with --resume; that path is lib/recentlyClosed.test.ts's.)
  await expect(page.locator(`[data-observe-pane="${s.id}"]`)).toBeVisible()
  await expect(page.getByText(/Can’t continue here/)).toBeVisible()
})
