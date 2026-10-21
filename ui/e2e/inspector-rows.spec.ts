/**
 * The inspector's folded section rows at every inspector width (owner,
 * 2026-10-22): the Changes row read "511 files +35244 −7781 Review and co",
 * cut at the panel's edge. A row's summary now shortens — figures compacted,
 * *Review* for *Review and commit*, then fewer parts — and nothing in a
 * row's head reaches past the panel. The working tree and the subagents are
 * stubbed at the page with the owner's figures; nothing is typed.
 */
import { expect, test } from './fixtures'

const json = (b: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) })

const files = Array.from({ length: 511 }, (_, i) => ({
  path: `internal/pkg${i % 40}/file_${i}.go`, status: 'modified', additions: i < 300 ? 117 : 1, deletions: i < 7 ? 1111 : 0, binary: false, patch: '',
}))
const add = files.reduce((n, f) => n + f.additions, 0)
const del = files.reduce((n, f) => n + f.deletions, 0)

test('folded section rows shorten their summaries and never reach past the inspector', async ({ app, page }) => {
  await page.route(/\/v1\/sessions\/[^/]+\/diff$/, (r) => r.fulfill(json({ root: '/tmp/x', branch: 'feat/x', files, stat: '' })))
  await page.route(/\/v1\/sessions\/[^/]+\/subagents(\?.*)?$/, (r) => r.fulfill(json({
    working: [], finished: 1, cost_usd: 2549.54,
    recent: [{ agent_id: 'c3', agent_type: 'Explore', description: 'Map the store', tool_calls: 6, started_at: Date.now() - 300_000, stopped_at: Date.now() - 60_000 }],
  })))
  await page.addInitScript(() => {
    localStorage.setItem('caprock.app.cockpit-looks', JSON.stringify({ subagents: 'compact', tools: 'compact', changes: 'compact', processes: 'compact', now: 'compact', tasks: 'compact' }))
  })
  await app.open()
  await app.openSession('alpha').catch(async () => {
    const x = app.session('alpha')
    await app.row(x.name).first().click()
  })
  const changes = page.locator('[data-section-frame="changes"]')
  await expect(changes).toContainText(`511 files`)

  for (const w of [280, 300, 324, 360, 400, 460, 560]) {
    await page.evaluate((px) => document.documentElement.style.setProperty('--app-inspector-w', `${px}px`), w)
    await page.waitForTimeout(150)
    // Nothing visible in a section's head row ends past the head itself.
    const over = await page.evaluate(() => {
      const out: string[] = []
      for (const frame of document.querySelectorAll('[data-section-frame]')) {
        const head = (frame.querySelector('[data-section-head], [data-look="compact"], section > div') ?? frame) as HTMLElement
        const edge = head.getBoundingClientRect().right + 0.5
        for (const el of head.querySelectorAll<HTMLElement>('span, button, h4')) {
          if (el.closest('.invisible') || el.offsetWidth === 0) continue
          const r = el.getBoundingClientRect()
          if (r.right > edge) out.push(`${frame.getAttribute('data-section-frame')}: "${el.textContent}" ends at ${Math.round(r.right)} > ${Math.round(edge)}`)
        }
      }
      return out
    })
    expect(over, `inspector at ${w}px`).toEqual([])
    const shown = await changes.locator('[data-fit-summary] > :not(.invisible)').textContent().catch(() => '')
    const subs = await page.locator('[data-section-frame="subagents"] [data-fit-summary] > :not(.invisible)').textContent().catch(() => '')
    const want = w >= 400 ? `511 files +${add} −${del}Review and commit` : w >= 324 ? '511 files +35.3k −7.8kReview' : undefined
    if (want) expect(shown, `Changes at ${w}px`).toBe(want)
    expect(subs, `Subagents at ${w}px`).toMatch(/total$/)
  }

  // The grip shows on the section under the pointer, or a focused one, only.
  await page.evaluate(() => document.documentElement.style.removeProperty('--app-inspector-w'))
  const grips = page.locator('[data-section-grip]')
  const opaque = () => grips.evaluateAll((els) => els.filter((e) => getComputedStyle(e).opacity !== '0').map((e) => e.getAttribute('data-section-grip')))
  await page.mouse.move(600, 300)
  await expect.poll(opaque).toEqual([])
  await page.locator('[data-section-frame="subagents"]').hover()
  await expect.poll(opaque).toEqual(['subagents'])
  await page.locator('[data-section-frame="changes"]').hover()
  await expect.poll(opaque).toEqual(['changes'])
})
