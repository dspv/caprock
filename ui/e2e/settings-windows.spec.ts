/**
 * Settings as a Windows or Linux window draws it (the first run on a real
 * Windows PC, 2026-11-20, the owner, translated: "on Windows the settings
 * are crooked: there are overlaps, bad spacing"). The page is told it is on
 * Windows the way the app decides it (`navigator.platform`, lib/appmode
 * isMacPlatform), so every key is spelled Ctrl+Shift+…, and what the browser
 * laid out is measured: none of this shows in jsdom.
 *
 * - The search field's key, Ctrl+Shift+F, never covers "Search settings":
 *   left out of the 224px menu, drawn in the wide field above the sections.
 * - A long section title is cut with an ellipsis inside the menu, with its
 *   whole name as the tooltip; the menu never scrolls sideways.
 * - The menu ends above the status strip, and a section it scrolls to lands
 *   below the sticky header, whose rows wrap as the window narrows.
 */
import type { Page } from '@playwright/test'
import { expect, test, type App } from './fixtures'

const LONG = 'Use Caprock from your agents (MCP)'

async function openSettingsOnWindows(app: App, page: Page, width: number): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' })
  })
  await page.setViewportSize({ width, height: 800 })
  await app.open()
  await app.sidebar.getByRole('button', { name: /^Settings/ }).click()
  await expect(page.locator('[data-settings-page]')).toBeVisible()
  await expect(page.locator(`[data-settings-section="${LONG}"]`)).toBeAttached()
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
}

/** The search field that is drawn: where its placeholder ends, and its key if shown. */
function searchField(page: Page) {
  return page.evaluate(() => {
    const input = [...document.querySelectorAll<HTMLInputElement>('input[data-settings-search]')].find((i) => i.getClientRects().length > 0)
    if (!input) return null
    const cs = getComputedStyle(input)
    const ctx = document.createElement('canvas').getContext('2d')!
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
    const box = input.getBoundingClientRect()
    const kbd = input.parentElement!.querySelector<HTMLElement>('[data-settings-search-key]')
    const key = kbd && kbd.getClientRects().length > 0 ? kbd.getBoundingClientRect() : null
    return {
      width: box.width,
      right: box.right,
      title: input.title,
      placeholderEnd: box.left + parseFloat(cs.paddingLeft) + ctx.measureText(input.placeholder).width,
      keyText: kbd?.textContent ?? '',
      key: key && { left: key.left, right: key.right },
    }
  })
}

for (const width of [1280, 1700]) {
  test(`on Windows at ${width}px the menu cuts long titles with an ellipsis and its search key covers nothing`, async ({ app, page }) => {
    await openSettingsOnWindows(app, page, width)
    const nav = page.getByRole('navigation', { name: 'Settings sections' })
    await expect(nav).toBeVisible()
    await expect(nav.getByRole('button', { name: LONG })).toBeAttached()

    const menu = await nav.evaluate((el) => {
      const box = el.getBoundingClientRect()
      const scroller = el.closest<HTMLElement>('[data-dashboard-view]')!.getBoundingClientRect()
      const rows = [...el.querySelectorAll<HTMLElement>('ul button')].map((b) => {
        const label = b.querySelector<HTMLElement>('[data-settings-nav-label]')!
        return { title: label.textContent ?? '', right: b.getBoundingClientRect().right, cut: label.scrollWidth > label.clientWidth, overflow: getComputedStyle(label).textOverflow }
      })
      return { right: box.right, bottom: box.bottom, clientWidth: el.clientWidth, scrollWidth: el.scrollWidth, scrollerBottom: scroller.bottom, rows }
    })
    // Nothing runs past the menu's edge: it was 285px of rows in 224px.
    expect(menu.scrollWidth).toBeLessThanOrEqual(menu.clientWidth)
    for (const r of menu.rows) expect(r.right, r.title).toBeLessThanOrEqual(menu.right + 0.5)
    const long = menu.rows.find((r) => r.title === LONG)!
    expect(long.cut).toBe(true)
    expect(long.overflow).toBe('ellipsis')
    // Its last rows were under the status strip.
    expect(menu.bottom).toBeLessThanOrEqual(menu.scrollerBottom)

    // The whole name on hover, only where it is cut.
    await nav.getByRole('button', { name: LONG }).hover()
    await expect(nav.getByRole('button', { name: LONG })).toHaveAttribute('title', LONG)
    await nav.getByRole('button', { name: 'Telegram', exact: true }).hover()
    await expect(nav.getByRole('button', { name: 'Telegram', exact: true })).not.toHaveAttribute('title')

    const field = await searchField(page)
    expect(field).not.toBeNull()
    expect(field!.keyText).toBe('Ctrl+Shift+F')
    expect(field!.title).toBe('Search settings (Ctrl+Shift+F)')
    // The placeholder is whole, and the key is either not drawn or after it.
    expect(field!.placeholderEnd).toBeLessThan(field!.right)
    if (field!.key) expect(field!.key.left).toBeGreaterThan(field!.placeholderEnd)
    // In the 224px menu there is no room for both.
    expect(field!.width).toBeLessThan(272)
    expect(field!.key).toBeNull()
  })
}

test('on Windows at 1100px the search field above the sections shows its key beside the placeholder', async ({ app, page }) => {
  await openSettingsOnWindows(app, page, 1100)
  await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeHidden()
  await page.locator('[data-dashboard-view]').evaluate((el) => { el.scrollTop = 0 })
  const field = await searchField(page)
  expect(field).not.toBeNull()
  expect(field!.key).not.toBeNull()
  expect(field!.keyText).toBe('Ctrl+Shift+F')
  expect(field!.key!.left).toBeGreaterThan(field!.placeholderEnd)
  expect(field!.key!.right).toBeLessThanOrEqual(field!.right)
})

for (const width of [1100, 1280]) {
  test(`at ${width}px a section scrolled to lands below the wrapped header`, async ({ app, page }) => {
    await openSettingsOnWindows(app, page, width)
    const gap = () => page.evaluate(() => {
      const header = document.querySelector<HTMLElement>('[data-shell-header]')!.getBoundingClientRect()
      const section = document.querySelector<HTMLElement>('[data-settings-section="Computers"]')!.getBoundingClientRect()
      return Math.round(section.top - header.bottom)
    })
    const row = page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Computers' })
    if (width >= 1280) await row.click()
    // Under `xl` there is no menu: a link (#/settings/computers) scrolls the same way.
    else await page.evaluate(() => document.querySelector('[data-settings-section="Computers"]')!.scrollIntoView({ block: 'start' }))
    // 16px under the header, a pixel either way for a header of 95.5px; it
    // was 32px (1280) and 60px (1100) behind it.
    await expect.poll(async () => {
      const g = await gap()
      return g >= 12 && g <= 20 ? 'below the header' : `${g}px from the header's foot`
    }).toBe('below the header')
    await expect(page.getByRole('heading', { name: 'Computers' })).toBeInViewport()
    // The row clicked is the row marked: the section above, its tail under
    // the header, was marked instead.
    if (width >= 1280) await expect(row).toHaveAttribute('aria-current', 'true')
  })
}
