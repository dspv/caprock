/**
 * Settings → After an API error (ADR-105): on by default, under When a
 * limit is reached, and turning it off is kept by the daemon — the page
 * read again after a reload says off. Put back on at the end, so the stand
 * is as other scenarios expect it.
 */
import { expect, test } from './fixtures'

test('Resume after API errors is on by default and its switch is kept', async ({ app, page }) => {
  await app.open()
  await app.sidebar.getByRole('button', { name: /^Settings/ }).click()
  await expect(page.locator('[data-settings-page]')).toBeVisible()
  const section = page.locator('[data-settings-section="After an API error"]')
  await section.scrollIntoViewIfNeeded()
  const box = section.getByRole('checkbox', { name: /Resume after API errors/ })
  await expect(box).toBeChecked()
  // Under the limit setting, the other thing that stops a session by itself.
  const order = await page.evaluate(() => [...document.querySelectorAll('[data-settings-section]')].map((el) => el.getAttribute('data-settings-section')))
  expect(order.indexOf('After an API error')).toBe(order.indexOf('When a limit is reached') + 1)

  await box.uncheck()
  await expect(box).not.toBeChecked()
  await expect.poll(async () => ((await (await fetch(`${app.stand.daemonURL}/v1/settings`)).json()) as { resume_after_api_error?: boolean }).resume_after_api_error).toBe(false)
  await page.reload()
  await expect(page.locator('[data-settings-page]')).toBeVisible()
  const again = page.locator('[data-settings-section="After an API error"]').getByRole('checkbox', { name: /Resume after API errors/ })
  await again.scrollIntoViewIfNeeded()
  await expect(again).not.toBeChecked()
  await again.check()
  await expect.poll(async () => ((await (await fetch(`${app.stand.daemonURL}/v1/settings`)).json()) as { resume_after_api_error?: boolean }).resume_after_api_error).toBe(true)
})
