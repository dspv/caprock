/**
 * New agent fits one screen (owner, 2026-11-24: First message sat below the
 * edge of a 1440×900 window). At 1440×900 the whole sheet, First message and
 * Start included, is inside the window without scrolling. In a shorter
 * window the sheet stops at the window's height and its middle scrolls,
 * the title and the Cancel / Start row staying in place. At phone width the
 * fields stand in one column.
 *
 * The second scenario is the owner's sheet: another computer linked (the
 * Machine field) and a project on GitHub with GitHub connected (the *From an
 * issue or PR…* link), both answered at the page.
 *
 * With CAPROCK_SHOTS_DIR set it photographs the sheet at each size, in the
 * light and the dark theme.
 */
import path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures'

const shotsDir = process.env.CAPROCK_SHOTS_DIR ? path.resolve(process.env.CAPROCK_SHOTS_DIR) : ''

async function openSheet(page: Page) {
  await page.getByRole('button', { name: /^New agent/ }).first().click()
  const sheet = page.getByRole('dialog', { name: 'New agent' })
  await expect(sheet.getByLabel('First message')).toBeVisible()
  // It opens on the project search with its list out; the first Esc folds the list, not the sheet.
  await page.keyboard.press('Escape')
  await expect(sheet).toBeVisible()
  // The catalog and the project's instructions arrive after the first frame.
  await expect(sheet.getByRole('radiogroup', { name: 'Permissions' })).toBeVisible()
  await page.waitForTimeout(300)
  return sheet
}

/** The sheet, its message field and its Start button against the window. */
async function measure(page: Page) {
  return page.evaluate(() => {
    const dlg = document.querySelector('[role=dialog][aria-label="New agent"]') as HTMLElement
    const msg = [...dlg.querySelectorAll('textarea')].pop() as HTMLElement
    const start = [...dlg.querySelectorAll('button')].find((b) => /^(Start|Accept and start)/.test(b.textContent ?? '')) as HTMLElement
    const scroller = dlg.querySelector('.app-scroll') as HTMLElement
    const r = (el: Element) => { const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, height: b.height } }
    // What the sheet would measure uncapped: its frame plus everything the middle holds.
    const natural = dlg.getBoundingClientRect().height - scroller.clientHeight + scroller.scrollHeight
    return { vh: window.innerHeight, vw: window.innerWidth, dialog: r(dlg), natural, message: r(msg), start: r(start), scrolls: scroller.scrollHeight > scroller.clientHeight + 1 }
  })
}

/**
 * Model and Effort side by side line up: the two labels on one baseline, the
 * select and the radiogroup with one top and one bottom. Effort's default was
 * a second line under its segment, which made the group taller and lifted its
 * label above Model's (owner, 2026-11-26); it is the label row's hint now.
 */
async function modelBesideEffort(sheet: Locator) {
  const box = async (l: Locator) => (await l.boundingBox())!
  const [ml, el] = [await box(sheet.getByText('Model', { exact: true })), await box(sheet.getByText('Effort', { exact: true }))]
  const [mc, ec] = [await box(sheet.getByRole('combobox', { name: 'Model', exact: true })), await box(sheet.getByRole('radiogroup', { name: 'Effort' }))]
  console.log(`model label ${ml.y}+${ml.height}, effort label ${el.y}+${el.height}; select ${mc.y}+${mc.height}, effort ${ec.y}+${ec.height}`)
  expect(Math.abs(ml.y + ml.height - (el.y + el.height))).toBeLessThan(0.5)
  expect(Math.abs(mc.y - ec.y)).toBeLessThan(0.5)
  expect(Math.abs(mc.y + mc.height - (ec.y + ec.height))).toBeLessThan(0.5)
  await expect(sheet.getByRole('radiogroup', { name: 'Effort' }).locator('[data-default]')).toHaveCount(1)
  await expect(sheet.locator('[data-effort-hint]')).toHaveText(/^\S+ is default$/)
}

async function shoot(page: Page, name: string) {
  if (!shotsDir) return
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
    await page.waitForTimeout(120)
    await page.screenshot({ path: path.join(shotsDir, `new-agent-${name}-${theme}.png`) })
  }
}

test('New agent fits a 1440×900 window, scrolls its middle in a short one, and stacks at phone width', async ({ app, page }) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await app.open()
  const sheet = await openSheet(page)
  await modelBesideEffort(sheet)

  const tall = await measure(page)
  console.log(`new agent at 1440×900: dialog ${Math.round(tall.dialog.height)} px tall, ${Math.round(tall.natural)} px uncapped`)
  expect(tall.scrolls).toBe(false)
  expect(tall.message.bottom).toBeLessThanOrEqual(tall.vh)
  expect(tall.start.bottom).toBeLessThanOrEqual(tall.vh)
  await shoot(page, '1440x900')

  // Shorter than the sheet: it stops at the window, the middle scrolls, Start stays in sight.
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.waitForTimeout(150)
  const short = await measure(page)
  console.log(`new agent at 1280×720: dialog ${Math.round(short.dialog.height)} px tall, middle scrolls: ${short.scrolls}`)
  expect(short.dialog.bottom).toBeLessThanOrEqual(short.vh)
  expect(short.start.bottom).toBeLessThanOrEqual(short.vh)
  await shoot(page, '1280x720')

  // Phone width: one column, nothing wider than the window.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(150)
  const phone = await measure(page)
  expect(phone.dialog.right).toBeLessThanOrEqual(phone.vw)
  expect(phone.start.bottom).toBeLessThanOrEqual(phone.vh)
  const where = page.getByRole('dialog', { name: 'New agent' }).getByRole('combobox', { name: 'Where', exact: true })
  const project = page.getByRole('dialog', { name: 'New agent' }).getByRole('combobox', { name: 'Project' })
  const [wb, pb] = [await where.boundingBox(), await project.boundingBox()]
  expect(wb!.y).toBeGreaterThan(pb!.y + pb!.height - 1)
  await shoot(page, '390x844')
})

const json = (b: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) })

test('New agent with another computer and a GitHub project still fits 1440×900', async ({ app, page }) => {
  test.setTimeout(90_000)
  await page.route(/\/v1\/machines(\?.*)?$/, (r) => r.fulfill(json({ machines: [{ id: 'm1', name: 'Studio', relay: 'wss://relay.invalid', added_at: Date.now(), status: 'online', role: 'controller' }] })))
  await page.route(/\/v1\/machines\/sessions$/, (r) => r.fulfill(json({ machines: [] })))
  await page.route(/\/v1\/m\/m1\//, (r) => r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"offline"}' }))
  // The sidebar's Computers row reads what it is (OS · memory); answered here, it asks nothing of a relay.
  await page.route(/\/v1\/m\/m1\/v1\/setup$/, (r) => r.fulfill(json({ os: 'darwin', items: [] })))
  await page.route(/\/v1\/m\/m1\/v1\/resources$/, (r) => r.fulfill(json({ at: Date.now(), sessions: [], machine: { cpus: 8, mem_total: 16 * 2 ** 30, mem_available: 8 * 2 ** 30 } })))
  await page.route(/\/v1\/github$/, (r) => r.request().method() === 'GET'
    ? r.fulfill(json({ connected: true, source: 'gh', user: { login: 'acme' }, scopes: ['repo'], scopes_known: true, sources: { gh: true, stored: false, store: '', oauth: false }, health: {}, notify: false }))
    : r.fallback())
  await page.route(/\/v1\/projects$/, async (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    const res = await r.fetch()
    const body = await res.json() as { projects?: { git?: Record<string, unknown> }[] } | { git?: Record<string, unknown> }[]
    const list = Array.isArray(body) ? body : body.projects ?? []
    for (const p of list) p.git = { ...(p.git ?? {}), remote_url: 'https://github.com/acme/app.git' }
    return r.fulfill({ response: res, json: body })
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await app.open()
  const sheet = await openSheet(page)
  await expect(sheet.getByRole('combobox', { name: 'Machine', exact: true })).toBeVisible()
  const gh = sheet.getByRole('button', { name: 'From a GitHub issue or pull request…' })
  await expect(gh).toHaveText('From an issue or PR…')

  // Machine beside Project, Where beside Agent, Model beside Effort.
  const top = async (l: ReturnType<Page['locator']>) => (await l.boundingBox())!.y
  expect(Math.abs(await top(sheet.getByRole('combobox', { name: 'Machine', exact: true })) - await top(sheet.getByRole('combobox', { name: 'Project' })))).toBeLessThan(2)
  expect(Math.abs(await top(sheet.getByRole('combobox', { name: 'Where', exact: true })) - await top(sheet.getByRole('combobox', { name: 'Agent', exact: true })))).toBeLessThan(2)
  await modelBesideEffort(sheet)

  const tall = await measure(page)
  console.log(`new agent with Machine and GitHub at 1440×900: dialog ${Math.round(tall.dialog.height)} px tall, ${Math.round(tall.natural)} px uncapped`)
  expect(tall.scrolls).toBe(false)
  expect(tall.message.bottom).toBeLessThanOrEqual(tall.vh)
  await shoot(page, 'machine-github-1440x900')
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.waitForTimeout(150)
  const short = await measure(page)
  console.log(`new agent with Machine and GitHub at 1280×720: dialog ${Math.round(short.dialog.height)} px tall, middle scrolls: ${short.scrolls}`)
  expect(short.start.bottom).toBeLessThanOrEqual(short.vh)
  await shoot(page, 'machine-github-1280x720')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(150)
  await shoot(page, 'machine-github-390x844')
})
