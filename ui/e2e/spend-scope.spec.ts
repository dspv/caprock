/**
 * The cockpit's Spend header and Numbers row at every inspector width
 * (owner, 2026-11-19): the header carries whose spend (*session | all*) and
 * over when (*whole · today · 7d · 30d*) beside *Chart | Numbers*, and none
 * of it may reach past the panel; Numbers read "SPENT $7,924…", cut in its
 * third of the cockpit, and now draws $7.92k and 13.71B whole. The 30-day
 * summary is stubbed at the page with the owner's figures; nothing is typed.
 */
import { expect, test } from './fixtures'

const json = (b: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) })

test('the Spend header and its big figures fit the inspector at every width', async ({ app, page }) => {
  await page.route(/\/v1\/stats\/summary\?range=30d/, (r) => r.fulfill(json({
    range: '30d', cost_usd: 7924.31, tokens_in: 13_000_000_000, cache_read: 710_000_000, cache_write: 0, tokens_out: 0,
    turns: 182_050, tool_calls: 999, sessions: 1, savings: { hit_rate: 0.05 }, projects: [],
  })))
  await page.addInitScript(() => {
    localStorage.setItem('caprock.app.cockpit.spend', JSON.stringify({ view: 'numbers', folded: false, slots: ['cost', 'tokens', 'turns'], v: 6 }))
  })
  await app.open()
  await app.openSession('alpha').catch(async () => {
    const x = app.session('alpha')
    await app.row(x.name).first().click()
  })
  const spend = page.getByRole('region', { name: 'Spend' })
  await spend.getByRole('button', { name: 'All sessions' }).click()
  await spend.getByRole('button', { name: 'Last 30 days' }).click()
  await expect(spend.getByLabel('Spent, 30 days · all sessions: $7,924.31')).toHaveText('$7.92k')

  for (const w of [280, 300, 330, 360, 400, 460]) {
    await page.evaluate((px) => document.documentElement.style.setProperty('--app-inspector-w', `${px}px`), w)
    await page.waitForTimeout(150)
    const bad = await spend.evaluate((sec) => {
      const out: string[] = []
      const edge = sec.getBoundingClientRect().right + 0.5
      for (const el of sec.querySelectorAll<HTMLElement>('[data-spend-head] button, [data-spend-head] h4')) {
        if (el.offsetWidth === 0) continue
        const r = el.getBoundingClientRect()
        if (r.right > edge) out.push(`"${el.textContent}" ends at ${Math.round(r.right)} > ${Math.round(edge)}`)
      }
      // A figure is cut when its text is wider than its cell.
      for (const dd of sec.querySelectorAll<HTMLElement>('[data-spend-numbers] dd')) {
        if (dd.scrollWidth > dd.clientWidth + 0.5) out.push(`"${dd.textContent}" is cut: ${dd.scrollWidth} > ${dd.clientWidth}`)
      }
      return out
    })
    expect(bad, `inspector at ${w}px`).toEqual([])
  }
  const figs = await spend.locator('[data-spend-numbers] dd').allTextContents()
  expect(figs).toEqual(['$7.92k', '13.71B', '182.05k'])
})
