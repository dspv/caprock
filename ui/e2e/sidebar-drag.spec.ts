/**
 * Dragging a session row in the sidebar is drawn as it happens, as the tab
 * strip's drag is (owner, 2026-10-23): the row follows the pointer, the rows
 * it passes slide apart by its height, a release over the list lands it
 * there, and Escape or a release off the list puts it back. Driven with real
 * pointer input on the stand, in the Flat list's Running, no tab group.
 * SIDEBAR_DRAG_SHOTS names a directory to keep mid-drag screenshots in, in
 * the light and the dark theme.
 */
import path from 'node:path'
import { expect, test } from './fixtures'

const shots = process.env.SIDEBAR_DRAG_SHOTS

test('a dragged sidebar row follows the pointer and lands in the slot the others open', async ({ app, page }) => {
  // A third session in alpha's folder, named so it is the user's own (not
  // Background); this stand started it, so this stand stops it (rule 7).
  const alpha = app.session('alpha')
  const r = await fetch(`${app.stand.daemonURL}/v1/agents`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: alpha.cwd }) })
  const { session_id: extra } = await r.json() as { session_id: string }
  expect(r.ok && extra, 'spawn a third session').toBeTruthy()
  await fetch(`${app.stand.daemonURL}/v1/sessions/${extra}/name`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'e2e gamma' }) })
  try {
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await app.open()
      // The Flat list: every untabbed session in one group.
      await page.evaluate(() => { localStorage.setItem('caprock.app.sidebar-grouped', 'off'); localStorage.removeItem('caprock.app.row-order') })
      await page.reload()
      const list = app.sidebar.getByRole('group', { name: 'Running, no tab' })
      const rows = list.locator(':scope > [data-row-key]')
      await expect(list.locator(`[data-live-row="${extra}"]`)).toBeVisible()
      await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(3)
      const order = () => rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-row-key') ?? ''))
      const before = await order()
      const tabsOpen = await app.tabs.locator('[data-tab-index]').count()

      // Press the first row and drag it down over the second.
      const first = rows.nth(0)
      const a = (await first.boundingBox())!
      const b = (await rows.nth(1).boundingBox())!
      const x = a.x + 60
      await page.mouse.move(x, a.y + a.height / 2)
      await page.mouse.down()
      await page.mouse.move(x, a.y + a.height / 2 + 10, { steps: 2 })
      // Its top a third of the way into the second row: past that row's middle, not the third's.
      await page.mouse.move(x, b.y + b.height * 0.3 + a.height / 2, { steps: 8 })
      await expect(first).toHaveAttribute('data-dragging', 'true')
      expect((await first.boundingBox())!.y).toBeGreaterThan(a.y + 30)
      expect(await first.evaluate((e) => e.style.transform)).toMatch(/^translateY\(\d+(\.\d+)?px\)$/)
      await page.waitForTimeout(250)
      // The second row slid up into the first one's place, by the first one's height.
      await expect.poll(async () => Math.round((await rows.nth(1).boundingBox())!.y - a.y)).toBe(0)
      if (shots) await page.screenshot({ path: path.join(shots, `sidebar-mid-drag-${scheme}.png`), clip: { x: 0, y: Math.max(0, a.y - 80), width: 360, height: 280 } })
      await page.mouse.up()
      await page.waitForTimeout(250)
      const after = await order()
      expect(after).toEqual([before[1], before[0], ...before.slice(2)])
      // The click that ended the drag opened no tab.
      await expect(app.tabs.locator('[data-tab-index]')).toHaveCount(tabsOpen)
      expect(await rows.nth(0).evaluate((e) => e.style.transform)).toBe('')

      // Escape mid-drag: back where it was, nothing moves.
      const c = (await rows.nth(0).boundingBox())!
      await page.mouse.move(x, c.y + c.height / 2)
      await page.mouse.down()
      await page.mouse.move(x, c.y + c.height / 2 + 90, { steps: 10 })
      await expect(rows.nth(0)).toHaveAttribute('data-dragging', 'true')
      await page.keyboard.press('Escape')
      await page.mouse.up()
      await page.waitForTimeout(250)
      expect(await order()).toEqual(after)
      await expect.poll(async () => Math.round((await rows.nth(0).boundingBox())!.y - c.y)).toBe(0)

      // Released out past the sidebar's edge: the slot closes and nothing moves.
      await page.mouse.move(x, c.y + c.height / 2)
      await page.mouse.down()
      await page.mouse.move(x, c.y + c.height / 2 + 90, { steps: 10 })
      await page.mouse.move(x + 700, c.y + c.height / 2 + 90, { steps: 5 })
      expect(await rows.nth(1).evaluate((e) => e.style.transform)).toBe('')
      if (shots) await page.screenshot({ path: path.join(shots, `sidebar-off-list-${scheme}.png`), clip: { x: 0, y: Math.max(0, c.y - 80), width: 900, height: 280 } })
      await page.mouse.up()
      await page.waitForTimeout(250)
      expect(await order()).toEqual(after)
      await expect(app.tabs.locator('[data-tab-index]')).toHaveCount(tabsOpen)
    }
  } finally {
    await fetch(`${app.stand.daemonURL}/v1/agents/${extra}/signal`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'kill' }) })
  }
})
