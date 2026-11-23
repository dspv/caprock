/**
 * The cockpit's Spend header and Numbers row at every inspector width
 * (owner, 2026-11-19): the header holds over when (*start · today · 7d ·
 * 30d*) beside *Chart | Numbers* on one line, whose spend is the *this
 * session ▾* under it (variant B), and none of it may reach past the
 * panel; Numbers read "SPENT $7,924…", cut in its
 * third of the cockpit, and now draws $7.92k and 13.71B whole. The 30-day
 * summary is stubbed at the page with the owner's figures; nothing is typed.
 */
import { expect, test } from './fixtures'

const json = (b: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) })

test('the Spend header and its big figures fit the inspector at every width', async ({ app, page }) => {
  await page.route(/\/v1\/stats\/summary\?range=30d/, (r) => r.fulfill(json({
    range: '30d', cost_usd: 7924.31, tokens_in: 13_000_000_000, cache_read: 710_000_000, cache_write: 0, tokens_out: 0,
    turns: 182_050, tool_calls: 999, sessions: 1, savings: { hit_rate: 0.05 },
    // Thirty days of spend by day, so the chart draws its top line.
    projects: [{ project: 'alpha', spark: { from_ms: Date.now() - 30 * 86_400_000, width_ms: 86_400_000, cost: Array.from({ length: 30 }, (_, i) => 100 + ((i * 37) % 90)), tokens: [] } }],
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
  const whose = spend.getByRole('button', { name: /\. Choose whose spend$/ })
  // What reaches past the panel, and whether the header holds one line.
  const check = () => spend.evaluate((sec) => {
    const out: string[] = []
    const edge = sec.getBoundingClientRect().right + 0.5
    for (const el of sec.querySelectorAll<HTMLElement>('[data-spend-head] button, [data-spend-head] h4, [data-spend-whose] button')) {
      if (el.offsetWidth === 0) continue
      const r = el.getBoundingClientRect()
      if (r.right > edge) out.push(`"${el.textContent}" ends at ${Math.round(r.right)} > ${Math.round(edge)}`)
    }
    const head = sec.querySelector<HTMLElement>('[data-spend-head]')!
    if (head.getBoundingClientRect().height > 24) out.push(`the header wraps: ${Math.round(head.getBoundingClientRect().height)}px tall`)
    // The whose ▾ says its scope whole, never cut.
    for (const t of sec.querySelectorAll<HTMLElement>('[data-spend-whose] button > span:first-child')) {
      if (t.scrollWidth > t.clientWidth + 0.5) out.push(`"${t.textContent}" is cut: ${t.scrollWidth} > ${t.clientWidth}`)
    }
    // A figure is cut when its text is wider than its cell.
    for (const dd of sec.querySelectorAll<HTMLElement>('[data-spend-numbers] dd')) {
      if (dd.scrollWidth > dd.clientWidth + 0.5) out.push(`"${dd.textContent}" is cut: ${dd.scrollWidth} > ${dd.clientWidth}`)
    }
    return out
  })
  const widths = [280, 300, 330, 360, 400, 460]
  const at = async (px: number) => {
    await page.evaluate((w) => document.documentElement.style.setProperty('--app-inspector-w', `${w}px`), px)
    await page.waitForTimeout(150)
  }

  // This session since start: the widest period chip, four words, on the chart.
  await spend.getByRole('button', { name: 'Chart' }).click()
  await expect(spend.getByRole('group', { name: /^Period: / })).toHaveText('starttoday7d30d')
  await expect(whose).toHaveText('this session▾')
  for (const w of widths) {
    await at(w)
    expect(await check(), `this session, chart, inspector at ${w}px`).toEqual([])
    if (w === 280 || w === 330) await spend.screenshot({ path: test.info().outputPath(`spend-session-${w}.png`) })
  }

  // Whose: the ▾ opens a menu of two; all sessions opens on today.
  await whose.click()
  await spend.getByRole('menu', { name: 'Whose spend' }).getByRole('menuitemradio', { name: 'All sessions' }).click()
  await expect(spend).toHaveAttribute('data-spend-scope', 'all')
  await expect(whose).toHaveText('all sessions▾')
  await spend.getByRole('button', { name: 'Last 30 days' }).click()
  await expect(whose).toHaveAccessibleName('30 days · all sessions. Choose whose spend')
  // The chart's top line: the figure at the left, the whose ▾ at the right.
  await expect(spend.locator('[data-spend-top] [data-spend-whose]')).toBeVisible()
  for (const w of widths) {
    await at(w)
    expect(await check(), `all sessions, chart, inspector at ${w}px`).toEqual([])
    if (w === 280 || w === 330) await spend.screenshot({ path: test.info().outputPath(`spend-all-chart-${w}.png`) })
  }
  await spend.getByRole('button', { name: 'Numbers' }).click()
  await expect(spend.getByLabel('Spent, 30 days · all sessions: $7,924.31')).toHaveText('$7.92k')

  for (const w of widths) {
    await at(w)
    expect(await check(), `all sessions, numbers, inspector at ${w}px`).toEqual([])
    if (w === 280 || w === 330) await spend.screenshot({ path: test.info().outputPath(`spend-all-${w}.png`) })
  }
  const figs = await spend.locator('[data-spend-numbers] dd').allTextContents()
  expect(figs).toEqual(['$7.92k', '13.71B', '182.05k'])
})

/**
 * The folded Spend on two lines (owner, 2026-11-23, variant A): the chip and
 * the figures on the first, the bars 32px tall on the second. With the
 * owner's 30-day figures, the widest the strip carries, no figure may reach
 * past the section at any width; the last ones give way first.
 */
test('the folded Spend keeps its figures inside the cockpit at every width', async ({ app, page }) => {
  await page.route(/\/v1\/stats\/summary\?range=30d/, (r) => r.fulfill(json({
    range: '30d', cost_usd: 7924.31, tokens_in: 13_000_000_000, cache_read: 710_000_000, cache_write: 0, tokens_out: 0,
    turns: 182_050, tool_calls: 999, sessions: 1, savings: { hit_rate: 0.05 },
    projects: [{ project: 'alpha', spark: { from_ms: Date.now() - 30 * 86_400_000, width_ms: 86_400_000, cost: Array.from({ length: 30 }, (_, i) => 100 + ((i * 37) % 90)), tokens: [] } }],
  })))
  await page.addInitScript(() => {
    localStorage.setItem('caprock.app.cockpit.spend', JSON.stringify({ view: 'chart', folded: false, slots: ['cost', 'tokens', 'turns'], v: 6 }))
  })
  await app.open()
  await app.openSession('alpha').catch(async () => {
    const x = app.session('alpha')
    await app.row(x.name).first().click()
  })
  const spend = page.getByRole('region', { name: 'Spend' })
  await spend.getByRole('button', { name: /\. Choose whose spend$/ }).click()
  await spend.getByRole('menu', { name: 'Whose spend' }).getByRole('menuitemradio', { name: 'All sessions' }).click()
  await spend.getByRole('button', { name: 'Last 30 days' }).click()
  await spend.getByRole('button', { name: /^Spend$/ }).click()
  const strip = spend.locator('[data-spend-folded]')
  await expect(strip.locator('[data-fold-period]')).toHaveText('30d · all')
  await expect(strip.locator('[data-fold-fig]').first()).toHaveText('$7,924.31')
  await expect(strip.locator('[data-fold-fig]').nth(1)).toHaveText(/^13\.71B\s*tok$/)
  const at = async (px: number) => {
    await page.evaluate((w) => document.documentElement.style.setProperty('--app-inspector-w', `${w}px`), px)
    await page.waitForTimeout(150)
  }
  // Each figure shown on the first line, its right edge against the section's.
  const measure = () => spend.evaluate((sec) => {
    const edge = sec.getBoundingClientRect().right + 0.5
    const top = sec.querySelector<HTMLElement>('[data-fold-top]')!.getBoundingClientRect()
    const out: string[] = []
    const shown: string[] = []
    for (const f of sec.querySelectorAll<HTMLElement>('[data-fold-fig]')) {
      if (f.offsetWidth === 0) continue
      const r = f.getBoundingClientRect()
      if (r.top >= top.bottom) continue // wrapped onto the clipped line: not shown
      shown.push(f.dataset.foldFig!)
      if (r.right > edge) out.push(`"${f.textContent}" ends at ${Math.round(r.right)} > ${Math.round(edge)}`)
    }
    if (sec.scrollWidth > sec.clientWidth + 0.5) out.push(`the section scrolls sideways: ${sec.scrollWidth} > ${sec.clientWidth}`)
    const s = sec.getBoundingClientRect()
    const bars = sec.querySelector<HTMLElement>('[data-fold-bars]')!.getBoundingClientRect()
    return { out, shown, section: Math.round(s.width), bars: Math.round(bars.height), barsWide: bars.width / s.width }
  })
  for (const w of [280, 300, 330, 360, 400, 460]) {
    await at(w)
    const m = await measure()
    expect(m.out, `folded at ${w}px`).toEqual([])
    expect(m.shown[0], `folded at ${w}px: the first figure is always there`).toBe('cost')
    if (w >= 330) expect(m.shown.length, `folded at ${w}px (section ${m.section}px): two figures or more`).toBeGreaterThanOrEqual(2)
    if (w === 460) expect(m.shown).toEqual(['cost', 'tokens', 'turns'])
    expect(m.bars, `folded at ${w}px: the bars are 32px and a hairline`).toBeGreaterThanOrEqual(32)
    expect(m.bars).toBeLessThanOrEqual(34)
    expect(m.barsWide, `folded at ${w}px: the bars run the cockpit's width`).toBeGreaterThan(0.9)
    if (w === 280 || w === 330) await spend.screenshot({ path: test.info().outputPath(`spend-folded-${w}.png`) })
  }
})
