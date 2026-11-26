/**
 * New agent's Project list stays inside the sheet (owner, 2026-11-26). With
 * another computer linked, Machine is the first field and Project the right
 * column; its list was drawn twice the field's width, ran out of the sheet's
 * right edge, and the scrollIntoView of its active row slid the sheet's
 * whole body sideways: every field shifted left, the left column cut at the
 * edge, the right half empty, until a click elsewhere.
 *
 * With folders whose paths are long, Project focused and the list walked
 * to its last row, the body's scrollLeft stays 0, it has nothing to scroll
 * sideways, the fields stay where they were, and the list ends inside the
 * sheet — at 1440 and at a narrow width, with and without Machine.
 *
 * With CAPROCK_SHOTS_DIR set it photographs the sheet with the list open.
 */
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

const shotsDir = process.env.CAPROCK_SHOTS_DIR ? path.resolve(process.env.CAPROCK_SHOTS_DIR) : ''
const json = (b: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) })

/** Folders with long paths, as the daemon's repository scan would list them. */
async function longPaths(page: Page) {
  await page.route(/\/v1\/browse\/repos$/, async (r) => {
    const res = await r.fetch()
    const body = await res.json() as { home?: string; repos?: { path: string; name: string }[] }
    const home = body.home || '/home/e2e'
    const deep = 'clients/acme-corporation/platform-engineering/services/internal-tooling'
    const more = Array.from({ length: 12 }, (_, i) => ({ path: `${home}/dev/${deep}/repository-with-a-long-name-${i + 1}`, name: `repository-with-a-long-name-${i + 1}` }))
    return r.fulfill({ response: res, json: { ...body, repos: [...(body.repos ?? []), ...more] } })
  })
}

/** Another computer linked: the Machine field comes first, Project beside it. */
async function linkedMachine(page: Page) {
  await page.route(/\/v1\/machines(\?.*)?$/, (r) => r.fulfill(json({ machines: [{ id: 'm1', name: 'Studio', relay: 'wss://relay.invalid', added_at: Date.now(), status: 'online', role: 'controller' }] })))
  await page.route(/\/v1\/machines\/sessions$/, (r) => r.fulfill(json({ machines: [] })))
  await page.route(/\/v1\/m\/m1\//, (r) => r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"offline"}' }))
  await page.route(/\/v1\/m\/m1\/v1\/setup$/, (r) => r.fulfill(json({ os: 'darwin', items: [] })))
  await page.route(/\/v1\/m\/m1\/v1\/resources$/, (r) => r.fulfill(json({ at: Date.now(), sessions: [], machine: { cpus: 8, mem_total: 16 * 2 ** 30, mem_available: 8 * 2 ** 30 } })))
}

/** The sheet's body, the list and the fields, measured. */
async function measure(page: Page) {
  return page.evaluate(() => {
    const dlg = document.querySelector('[role=dialog][aria-label="New agent"]') as HTMLElement
    const body = dlg.querySelector('.app-scroll') as HTMLElement
    const list = dlg.querySelector('[data-project-list]') as HTMLElement | null
    const project = dlg.querySelector('[role=combobox][aria-label="Project"]') as HTMLElement
    const first = dlg.querySelector('[data-field-row]') as HTMLElement
    return {
      scrollLeft: body.scrollLeft,
      sideways: body.scrollWidth - body.clientWidth,
      dialog: dlg.getBoundingClientRect().toJSON() as DOMRect,
      body: body.getBoundingClientRect().toJSON() as DOMRect,
      list: list ? (list.getBoundingClientRect().toJSON() as DOMRect) : null,
      projectLeft: project.getBoundingClientRect().left,
      rowLeft: first.getBoundingClientRect().left,
      rowRight: first.getBoundingClientRect().right,
    }
  })
}

async function check(page: Page, name: string) {
  const sheet = page.getByRole('dialog', { name: 'New agent' })
  await expect(sheet.getByLabel('First message')).toBeVisible()
  await expect(sheet.getByRole('radiogroup', { name: 'Permissions' })).toBeVisible()
  const project = sheet.getByRole('combobox', { name: 'Project' })
  // Closed first, to measure where the fields stand.
  await sheet.getByLabel('First message').click()
  await expect(project).toHaveAttribute('aria-expanded', 'false')
  await page.waitForTimeout(200)
  const before = await measure(page)

  // Focused, the list opens; walking it to the end scrolls the list alone.
  await project.click()
  const list = sheet.getByRole('listbox', { name: 'Projects and repositories' })
  await expect(list.getByRole('option', { name: /repository-with-a-long-name-12/ })).toBeAttached()
  const opened = await measure(page)
  for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(150)
  const walked = await measure(page)
  if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `new-agent-project-list-${name}.png`) })

  for (const [when, m] of [['open', opened], ['walked', walked]] as const) {
    console.log(`${name} ${when}: scrollLeft ${m.scrollLeft}, sideways ${m.sideways}, list ${Math.round(m.list!.left)}–${Math.round(m.list!.right)}, row ${Math.round(m.rowLeft)}–${Math.round(m.rowRight)}, sheet right ${Math.round(m.dialog.right)}`)
    expect(m.scrollLeft).toBe(0)
    expect(m.sideways).toBeLessThanOrEqual(0)
    expect(m.list).not.toBeNull()
    expect(m.list!.right).toBeLessThanOrEqual(m.rowRight + 0.5)
    expect(m.list!.right).toBeLessThanOrEqual(m.body.right)
    expect(m.list!.left).toBeGreaterThanOrEqual(m.dialog.left)
    // Nothing moved: the fields stand where they stood with the list closed.
    expect(Math.abs(m.projectLeft - before.projectLeft)).toBeLessThan(0.5)
    expect(Math.abs(m.rowLeft - before.rowLeft)).toBeLessThan(0.5)
  }
  // Every row fits the list: a long path is cut with an ellipsis, and the
  // word saying where it came from stays inside the row.
  const rows = await list.evaluate((ul) => {
    const lr = ul.getBoundingClientRect()
    return [...ul.querySelectorAll('li[role=option]')].map((li) => {
      const r = li.getBoundingClientRect()
      const kind = (li.lastElementChild as HTMLElement).getBoundingClientRect()
      const p = li.querySelector('.mono') as HTMLElement
      return { over: li.scrollWidth - li.clientWidth, right: r.right, listRight: lr.right, kindRight: kind.right, ellipsis: getComputedStyle(p).textOverflow }
    })
  })
  for (const r of rows) {
    expect(r.over).toBeLessThanOrEqual(0)
    expect(r.right).toBeLessThanOrEqual(r.listRight + 0.5)
    expect(r.kindRight).toBeLessThanOrEqual(r.right + 0.5)
    expect(r.ellipsis).toBe('ellipsis')
  }

  await page.keyboard.press('Escape')
  await expect(project).toHaveAttribute('aria-expanded', 'false')
  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()
}

for (const machine of [true, false]) {
  test(`New agent's Project list stays inside the sheet${machine ? ' with Machine beside it' : ''}`, async ({ app, page }) => {
    test.setTimeout(90_000)
    await longPaths(page)
    if (machine) await linkedMachine(page)
    await page.setViewportSize({ width: 1440, height: 900 })
    await app.open()
    // 1440 wide, two columns at a narrow 700, one column at phone width.
    for (const [w, h] of [[1440, 900], [700, 800], [390, 844]] as const) {
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.getByRole('button', { name: /^New agent/ }).first().click()
      if (machine) await expect(page.getByRole('dialog', { name: 'New agent' }).getByRole('combobox', { name: 'Machine', exact: true })).toBeVisible()
      await page.setViewportSize({ width: w, height: h })
      await check(page, `${machine ? 'machine-' : ''}${w}x${h}`)
    }
  })
}
