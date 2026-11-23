/**
 * A figure the agent does not save is a dash with a quiet info mark after it
 * (owner, 2026-11-23): a dash alone read as Caprock broken. The stand's alpha
 * session is dressed as a cursor-agent chat — no tokens, no cost, and the
 * daemon's gaps — by rewriting the daemon's answers at the page; nothing is
 * typed and no agent runs. The marks must show in the inspector at its
 * narrowest, on the Session screen and at phone width, say the sentence on
 * hover and on a tap, and never reach past the window.
 */
import { expect, test } from './fixtures'
import type { Page } from '@playwright/test'

const TOK = "Cursor CLI doesn't save token counts on this computer"
const COST = "Cursor CLI doesn't save what a chat costs on this computer"
const CACHE = "Cursor CLI doesn't save cache reads or writes on this computer"
const said = (why: string) => `${why}, so there is nothing for Caprock to show.`

type Row = Record<string, unknown> & { session_id: string; stats?: Record<string, number> }

function asCursorCLI(s: Row): Row {
  return {
    ...s, agent: 'cursor', model: 'composer-2.5', model_display: 'Composer 2.5', context: undefined,
    stats: { ...(s.stats ?? {}), turns: 2, tool_calls: 3, tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, cost_usd: 0, unpriced_turns: 0 },
    savings: undefined, gaps: { tokens: TOK, cost: COST, cache: CACHE },
  }
}

async function dress(page: Page, id: string): Promise<void> {
  await page.route(/\/v1\/sessions(\?[^/]*)?$/, async (r) => {
    const res = await r.fetch()
    const list = (await res.json()) as Row[]
    await r.fulfill({ response: res, json: list.map((s) => (s.session_id === id ? asCursorCLI(s) : s)) })
  })
  await page.route(new RegExp(`/v1/sessions/${id}(\\?[^/]*)?$`), async (r) => {
    const res = await r.fetch()
    await r.fulfill({ response: res, json: asCursorCLI((await res.json()) as Row) })
  })
}

/** Whatever on the page reaches past the window's right edge. */
const overflow = (page: Page) => page.evaluate(() => {
  const w = document.documentElement.clientWidth
  const out: string[] = []
  for (const el of document.querySelectorAll<HTMLElement>('[data-gap-mark], [role="tooltip"][data-gap-card]')) {
    const r = el.getBoundingClientRect()
    if (r.width > 0 && (r.right > w + 0.5 || r.left < -0.5)) out.push(`${el.tagName} ${Math.round(r.left)}–${Math.round(r.right)} of ${w}`)
  }
  if (document.documentElement.scrollWidth > w + 0.5) out.push(`the page scrolls sideways: ${document.documentElement.scrollWidth} > ${w}`)
  return out
})

test('a dash the agent leaves has an info mark that says why', async ({ app, page }) => {
  const alpha = app.session('alpha')
  await dress(page, alpha.id)
  await app.open()
  await app.openSession('alpha')

  // The inspector: the headline (burn rate, a cost gap) and the two lines.
  const head = page.locator('[data-headline]')
  const mark = head.getByRole('button', { name: said(COST) })
  await expect(mark).toBeVisible()
  await expect(page.locator('[data-hero-line="tokens"]').locator('..').getByRole('button', { name: said(TOK) })).toBeVisible()

  // Hover says it; the mark sits beside the dash without moving it.
  await mark.hover()
  await expect(page.getByRole('tooltip').filter({ hasText: said(COST) })).toBeVisible()
  await page.mouse.move(0, 0)

  for (const w of [280, 330, 460]) {
    await page.evaluate((px) => document.documentElement.style.setProperty('--app-inspector-w', `${px}px`), w)
    await page.waitForTimeout(150)
    await mark.hover()
    expect(await overflow(page), `inspector at ${w}px`).toEqual([])
    if (w === 280) {
      await page.screenshot({ path: test.info().outputPath('inspector-280-light.png') })
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
      await page.screenshot({ path: test.info().outputPath('inspector-280-dark.png') })
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
    }
    await page.mouse.move(0, 0)
  }

  // The Session screen: cost, tokens and cache tiles.
  await page.goto(`${app.stand.pageURL}/#/session/${alpha.id}`)
  const tiles = page.locator('[data-gap-dash]')
  await expect(page.getByRole('button', { name: said(COST) }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: said(CACHE) }).first()).toBeVisible()
  expect(await tiles.count()).toBeGreaterThanOrEqual(3)
  await page.getByRole('button', { name: said(TOK) }).first().hover()
  await page.screenshot({ path: test.info().outputPath('session-light.png') })
  expect(await overflow(page)).toEqual([])
  await page.mouse.move(0, 0)

  // A phone: the Session screen in a browser 390px wide, a touch screen with
  // no hover; a tap shows the sentence inside the window.
  const phone = await page.context().browser()!.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  try {
    await dress(phone, alpha.id)
    await phone.goto(`${app.stand.pageURL}/#/session/${alpha.id}?tab=timeline`)
    const tap = phone.getByRole('button', { name: said(COST) }).first()
    await expect(tap).toBeVisible()
    await tap.tap()
    await expect(phone.getByRole('tooltip').filter({ hasText: said(COST) })).toBeVisible()
    expect(await overflow(phone), 'at phone width').toEqual([])
    await phone.screenshot({ path: test.info().outputPath('session-phone.png') })
    await phone.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await phone.screenshot({ path: test.info().outputPath('session-phone-dark.png') })
    // A tap elsewhere puts it away.
    await phone.locator('body').tap({ position: { x: 380, y: 830 } })
    await expect(phone.getByRole('tooltip')).toHaveCount(0)
  } finally {
    await phone.close()
  }
})
