/**
 * Dragging a tab in the strip is drawn as it happens (owner, 2026-10-23,
 * translated: "when dragging tabs at the top, you can't see under the mouse
 * that they are moving"): the tab follows the pointer, its neighbours slide
 * apart, a release over the strip lands it there, and Escape or a release
 * off the strip puts it back. Driven with real pointer input on the stand.
 * TAB_DRAG_SHOTS names a directory to keep mid-drag screenshots in.
 */
import path from 'node:path'
import { expect, test } from './fixtures'

const shots = process.env.TAB_DRAG_SHOTS

test('a dragged tab follows the pointer and lands in the slot its neighbours open', async ({ app, page }) => {
  await app.open()
  for (const name of ['alpha', 'beta'] as const) {
    await app.openSession(name).catch(async () => {
      const s = app.session(name)
      await app.row(s.name).first().click()
    })
  }
  await app.tabs.getByRole('button', { name: 'New', exact: true }).click()
  await page.getByRole('menuitem', { name: /New shell/ }).click()
  const tabs = app.tabs.locator('[data-tab-index]')
  await expect(tabs).toHaveCount(3)
  const order = () => tabs.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? e.textContent ?? ''))
  const before = await order()
  const selected = () => app.tabs.locator('[data-tab-index][aria-selected="true"]').evaluate((e) => e.getAttribute('data-tab-index'))
  // The shell just opened is in front, at the end: a drag of the first tab
  // must not bring that one forward.
  const front = await selected()
  expect(front).toBe('2')

  // Press the first tab and drag it right, its right edge past the second's middle.
  const first = tabs.nth(0)
  const a = (await first.boundingBox())!
  const b = (await tabs.nth(1).boundingBox())!
  const y = a.y + a.height / 2
  await page.mouse.move(a.x + 30, y)
  await page.mouse.down()
  await page.mouse.move(a.x + 40, y, { steps: 2 })
  await page.mouse.move(b.x + b.width * 0.1 + 30, y, { steps: 8 })
  await expect(first).toHaveAttribute('data-dragging', 'true')
  const moved = (await first.boundingBox())!
  expect(moved.x).toBeGreaterThan(a.x + 40)
  expect(await first.evaluate((e) => e.style.transform)).toMatch(/^translateX\(\d+(\.\d+)?px\)$/)
  await page.waitForTimeout(250)
  // The second tab slid left into the first one's place.
  expect((await tabs.nth(1).boundingBox())!.x).toBeLessThan(b.x - 20)
  if (shots) await page.screenshot({ path: path.join(shots, 'mid-drag.png'), clip: { x: 0, y: 0, width: 1440, height: 80 } })
  await page.mouse.up()
  await page.waitForTimeout(250)
  const after = await order()
  expect(after).toEqual([before[1], before[0], before[2]])
  if (shots) await page.screenshot({ path: path.join(shots, 'landed.png'), clip: { x: 0, y: 0, width: 1440, height: 80 } })
  // The click that ended the drag brought no other tab to the front.
  expect(await selected()).toBe(front)
  expect(await tabs.nth(1).evaluate((e) => e.style.transform)).toBe('')

  // Escape mid-drag: back where it was, nothing moves.
  const c = (await tabs.nth(0).boundingBox())!
  await page.mouse.move(c.x + 30, y)
  await page.mouse.down()
  await page.mouse.move(c.x + 300, y, { steps: 10 })
  await expect(tabs.nth(0)).toHaveAttribute('data-dragging', 'true')
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await page.waitForTimeout(250)
  expect(await order()).toEqual(after)
  expect((await tabs.nth(0).boundingBox())!.x).toBeCloseTo(c.x, 0)

  // Released well below the strip: nothing moves either.
  await page.mouse.move(c.x + 30, y)
  await page.mouse.down()
  await page.mouse.move(c.x + 300, y, { steps: 10 })
  await page.mouse.move(c.x + 300, y + 300, { steps: 5 })
  await page.mouse.up()
  await page.waitForTimeout(250)
  expect(await order()).toEqual(after)
})
