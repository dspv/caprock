/**
 * The plan question under the Cost screen's total (owner-approved mockup,
 * 2026-11-22): with no plan stated it asks *How do you pay for Claude?* with
 * four chips; a tap saves the plan fields through PUT /v1/settings and the
 * figure becomes *Work at API prices*, *Covered by your Pro plan.*, with the
 * month block beside it; *Not now* keeps it away after a reload.
 *
 * /v1/settings is answered at the page — the stand's daemon is shared by
 * every scenario, and a plan saved there would change what the others see —
 * and the 30-day summary carries a 5-hour window so the hint shows.
 */
import { expect, test } from './fixtures'

const json = (b: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) })

test.describe('the plan question on Cost', () => {
  test.beforeEach(async ({ page }) => {
    await page.route(/\/v1\/stats\/summary\?range=30d/, async (r) => {
      const res = await r.fetch()
      const body = await res.json()
      await r.fulfill(json({ ...body, cost_usd: 29.14, turns: Math.max(1, body.turns ?? 0), rate_limits: { five_hour: { used_percentage: 18, resets_at: Math.floor(Date.now() / 1000) + 3600 } } }))
    })
  })

  test('a chip saves the plan and the figure says what covered it', async ({ app, page }) => {
    const puts: Record<string, unknown>[] = []
    let plan = { plan_kind: '', plan_label: '', plan_usd_per_month: 0 }
    await page.route(/\/v1\/settings$/, async (r) => {
      if (r.request().method() === 'PUT') {
        const body = r.request().postDataJSON() as Record<string, unknown>
        puts.push(body)
        plan = { ...plan, ...body }
        return r.fulfill(json({ update_checks: false, ...plan }))
      }
      const res = await r.fetch()
      return r.fulfill(json({ ...(await res.json()), ...plan }))
    })
    // This month's Claude Code summary (range=<day of month>d&agent=claude),
    // registered last so it wins over the 30-day stub on the 30th.
    await page.route(/\/v1\/stats\/summary\?range=\d+d&agent=claude/, async (r) => {
      const res = await r.fetch()
      await r.fulfill(json({ ...(await res.json()), cost_usd: 87.4 }))
    })
    await app.open()
    await page.evaluate(() => { location.hash = '#/cost' })

    const ask = page.locator('[data-plan-ask]')
    await expect(ask).toBeVisible()
    await expect(ask).toContainText('How do you pay for Claude?')
    await expect(ask.getByRole('button')).toHaveText(['Pro $20', 'Max $100', 'Ultra $200', 'API key', 'Not now'])
    await expect(ask.locator('[data-plan-ask-hint]')).toHaveText('Claude shows you plan limits, so it looks like a subscription.')
    const totals = ask.locator('xpath=ancestor::section[1]')
    await totals.screenshot({ path: test.info().outputPath('plan-ask-unstated.png') })

    await ask.getByRole('button', { name: 'Pro $20' }).click()
    await expect.poll(() => puts).toEqual([{ plan_kind: 'flat', plan_label: 'Pro', plan_usd_per_month: 20 }])
    await expect(page.locator('[data-plan-ask]')).toHaveCount(0)
    await expect(page.getByText('Work at API prices', { exact: true })).toBeVisible()
    await expect(page.getByText('Covered by your Pro plan.')).toBeVisible()
    await expect(page.getByText('Nothing extra was charged unless you turned on extra usage.')).toBeVisible()
    const month = page.locator('[data-plan-month]')
    await expect(month).toContainText('This month, at API prices')
    await expect(month.locator('[data-plan-month-spend]')).toHaveText('$87.40')
    await expect(month.locator('[data-plan-month-fee]')).toHaveText('$20.00 / month')
    await expect(month.locator('[data-plan-month-times]')).toHaveText('About 4.4 times what you pay.')
    await month.locator('xpath=ancestor::section[1]').screenshot({ path: test.info().outputPath('plan-ask-month.png') })
    await page.locator('[data-cost-covered]').locator('xpath=ancestor::section[1]').screenshot({ path: test.info().outputPath('plan-ask-flat.png') })
  })

  test('"Not now" keeps the question away after a reload', async ({ app, page }) => {
    const puts: unknown[] = []
    await page.route(/\/v1\/settings$/, async (r) => {
      if (r.request().method() === 'PUT') { puts.push(r.request().postDataJSON()); return r.fulfill(json({})) }
      const res = await r.fetch()
      return r.fulfill(json({ ...(await res.json()), plan_kind: '', plan_label: '', plan_usd_per_month: 0 }))
    })
    await app.open()
    // Home asks under Cost today as well.
    await page.evaluate(() => { location.hash = '#/home' })
    const home = page.locator('[data-plan-ask]')
    await expect(home).toBeVisible()
    await home.locator('xpath=ancestor::section[1]').screenshot({ path: test.info().outputPath('plan-ask-home.png') })
    await page.evaluate(() => { location.hash = '#/cost' })
    await page.locator('[data-plan-ask]').getByRole('button', { name: 'Not now' }).click()
    await expect(page.locator('[data-plan-ask]')).toHaveCount(0)
    await page.reload()
    await page.evaluate(() => { location.hash = '#/cost' })
    await expect(page.getByText('Totals · 30d')).toBeVisible()
    await expect(page.locator('[data-plan-ask]')).toHaveCount(0)
    expect(puts).toEqual([])
  })
})
